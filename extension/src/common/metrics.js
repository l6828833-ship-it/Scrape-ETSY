/**
 * Derived trend metrics and opportunity scores.
 *
 * Everything here is a pure function of the snapshots we have actually observed
 * — no estimation of Etsy-internal numbers (sales, views) that the site does not
 * publish. Two rules the whole module follows:
 *
 *   1. If the inputs cannot support a metric, it is `null`, never 0. A brand-new
 *      listing seen once has `favoritesDelta: null`, because "we don't know yet"
 *      and "it gained nothing" are very different facts.
 *   2. Rates are only computed over intervals long enough to be meaningful
 *      (>= MIN_INTERVAL_HOURS), so re-running the scraper twice in a minute
 *      cannot manufacture a "rocket ship".
 *
 * Scores are deliberately bounded 0-100 heuristics for ranking candidates, not
 * predictions. The saturation constants are the knobs to tune.
 */

const DAY_MS = 86400000;

export const METRIC_CONFIG = {
  /** Shorter gaps than this are treated as the same observation for rates. */
  MIN_INTERVAL_HOURS: 6,
  /** Value at which each signal is considered "as strong as it gets". */
  PRICE_SATURATION: 200,
  COMPETITION_SATURATION: 2000,
  DEMAND_SATURATION: 5000,
  MOMENTUM_SATURATION: 20,
  /** Weights for opportunityScore; must sum to 1. */
  WEIGHTS: { momentum: 0.4, demand: 0.35, gap: 0.25 },
};

/**
 * True only for real numbers. `Number(null) === 0`, so a plain isFinite check
 * would silently turn "we never saw this value" into "it is zero" — which is the
 * exact class of lie this module exists to avoid.
 */
function isNum(value) {
  return value !== null && value !== undefined && value !== ''
    && Number.isFinite(Number(value));
}

/** log-scaled 0..1, so the first few favourites matter more than the 4000th. */
function saturate(value, ceiling) {
  if (!isNum(value)) return null;
  const v = Math.max(0, Number(value));
  return Math.min(1, Math.log1p(v) / Math.log1p(ceiling));
}

function round(value, decimals = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function daysBetween(aMs, bMs) {
  return Math.abs(bMs - aMs) / DAY_MS;
}

/**
 * A snapshot is what we saw at one point in time.
 * @typedef {{ts:number, favorites:?number, reviewCount:?number, price:?number,
 *            quantity:?number}} Snapshot
 */

/**
 * Collapse a listing's snapshot history into trend metrics.
 *
 * @param {Snapshot[]} snapshots chronological (oldest first)
 * @param {{listedAt?:?string, now?:number}} [options] `listedAt` = listing
 *        creation date (ISO), used for lifetime rates when available
 * @returns {object} metric fields (all nullable)
 */
export function summarizeHistory(snapshots, options = {}) {
  const list = (Array.isArray(snapshots) ? snapshots : [])
    .filter((s) => s && Number.isFinite(Number(s.ts)))
    .slice()
    .sort((a, b) => a.ts - b.ts);

  const empty = {
    firstScrapedAt: null,
    lastScrapedAt: null,
    snapshotCount: 0,
    daysTracked: null,
    daysSinceListed: null,
    favoritesDelta: null,
    favoritesPerDay: null,
    favoritesPerDayLifetime: null,
    reviewsDelta: null,
    reviewsPerDay: null,
  };
  if (!list.length) return empty;

  const now = Number(options.now) || Date.now();
  const first = list[0];
  const last = list[list.length - 1];
  const tracked = daysBetween(first.ts, last.ts);

  const out = {
    ...empty,
    firstScrapedAt: new Date(first.ts).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    lastScrapedAt: new Date(last.ts).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    snapshotCount: list.length,
    daysTracked: round(tracked, 3),
  };

  const listedMs = options.listedAt ? Date.parse(options.listedAt) : NaN;
  if (!Number.isNaN(listedMs)) {
    out.daysSinceListed = round(Math.max(0, (now - listedMs) / DAY_MS), 1);
  }

  // Most recent usable interval: walk back until the gap is long enough.
  const previous = findComparisonSnapshot(list);
  if (previous) {
    const gapDays = daysBetween(previous.ts, last.ts);
    out.favoritesDelta = diff(last.favorites, previous.favorites);
    out.reviewsDelta = diff(last.reviewCount, previous.reviewCount);
    if (gapDays > 0) {
      out.favoritesPerDay = out.favoritesDelta === null ? null : round(out.favoritesDelta / gapDays);
      out.reviewsPerDay = out.reviewsDelta === null ? null : round(out.reviewsDelta / gapDays);
    }
  }

  // Lifetime rate: total favourites over the listing's age (preferred) or over
  // the window we have been watching it.
  const span = out.daysSinceListed || (tracked >= 1 ? tracked : null);
  if (span && isNum(last.favorites)) {
    out.favoritesPerDayLifetime = round(Number(last.favorites) / span);
  }

  return out;
}

function diff(current, previous) {
  if (!isNum(current) || !isNum(previous)) return null;
  return Number(current) - Number(previous);
}

/** Newest snapshot at least MIN_INTERVAL_HOURS older than the latest one. */
function findComparisonSnapshot(list) {
  if (list.length < 2) return null;
  const last = list[list.length - 1];
  const minGapMs = METRIC_CONFIG.MIN_INTERVAL_HOURS * 3600000;
  for (let i = list.length - 2; i >= 0; i -= 1) {
    if (last.ts - list[i].ts >= minGapMs) return list[i];
  }
  return null;
}

/**
 * Bounded 0-100 heuristics for ranking listings.
 *
 * - demandScore: how much total interest the listing has accumulated.
 * - momentumScore: how fast that interest is currently growing.
 * - competitiveGapScore: high price + few reviews = margin with weak proof of
 *   competition. This is the "gap" signal, not a quality signal.
 * - opportunityScore: weighted blend of the three.
 *
 * @param {{price:?number, reviewCount:?number, favoritesCount:?number,
 *          favoritesPerDay:?number}} input
 * @returns {{demandScore:?number, momentumScore:?number,
 *            competitiveGapScore:?number, opportunityScore:?number}}
 */
export function computeScores(input = {}) {
  const cfg = METRIC_CONFIG;
  const price = saturate(input.price, cfg.PRICE_SATURATION);
  const competition = saturate(input.reviewCount, cfg.COMPETITION_SATURATION);
  const demand = saturate(input.favoritesCount, cfg.DEMAND_SATURATION);
  const momentum = isNum(input.favoritesPerDay)
    ? saturate(Math.max(0, Number(input.favoritesPerDay)), cfg.MOMENTUM_SATURATION)
    : null;

  const gap = price === null || competition === null ? null : price * (1 - competition);

  const parts = [
    [cfg.WEIGHTS.momentum, momentum],
    [cfg.WEIGHTS.demand, demand],
    [cfg.WEIGHTS.gap, gap],
  ].filter(([, v]) => v !== null);

  // Re-normalise across whatever signals we actually have, so a listing is not
  // penalised merely for being observed once.
  let opportunity = null;
  if (parts.length) {
    const weight = parts.reduce((sum, [w]) => sum + w, 0);
    opportunity = parts.reduce((sum, [w, v]) => sum + w * v, 0) / weight;
  }

  return {
    demandScore: pct(demand),
    momentumScore: pct(momentum),
    competitiveGapScore: pct(gap),
    opportunityScore: pct(opportunity),
  };
}

function pct(value) {
  return value === null ? null : Math.round(value * 100);
}

/**
 * Convenience wrapper: merge history metrics and scores onto a detail record.
 * @param {object} detail parsed listing detail
 * @param {Snapshot[]} snapshots
 * @param {{now?:number}} [options]
 */
export function applyMetrics(detail, snapshots, options = {}) {
  const history = summarizeHistory(snapshots, {
    listedAt: detail && detail.listingCreationDate,
    now: options.now,
  });
  const scores = computeScores({
    price: detail && detail.price,
    reviewCount: detail && detail.reviewCount,
    favoritesCount: detail && detail.favoritesCount,
    favoritesPerDay: history.favoritesPerDay,
  });
  return { ...detail, ...history, ...scores };
}

/** Build a snapshot from a freshly parsed detail record. */
export function snapshotFromDetail(detail, now = Date.now()) {
  return {
    ts: now,
    favorites: numOrNull(detail && detail.favoritesCount),
    reviewCount: numOrNull(detail && detail.reviewCount),
    price: numOrNull(detail && detail.price),
    quantity: numOrNull(detail && detail.quantityAvailable),
  };
}

function numOrNull(v) {
  return isNum(v) ? Number(v) : null;
}

export const __testing = { isNum, saturate, findComparisonSnapshot };
