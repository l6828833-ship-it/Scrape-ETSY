/**
 * Single source of truth for settings, run state and scraped rows.
 *
 * MV3 service workers get suspended aggressively, so everything that matters is
 * mirrored into chrome.storage.local (debounced) and lazily re-hydrated.
 */

import { STORAGE_KEYS, DEFAULTS, LIMITS, RUN_STATUS, MSG } from '../common/constants.js';

const memory = {
  hydrated: false,
  settings: null,
  state: null,
  rows: [],
  /** Listing-detail records, one per listingId (latest wins). */
  details: [],
  reviews: [],
};

function freshState() {
  return {
    status: RUN_STATUS.IDLE,
    startedAt: null,
    finishedAt: null,
    engineInUse: null,
    message: '',
    progress: {
      queriesTotal: 0,
      queriesDone: 0,
      pagesPlanned: 0,
      pagesDone: 0,
      pagesFailed: 0,
      rows: 0,
      duplicates: 0,
      adsSkipped: 0,
      retries: 0,
      blocks: 0,
      detailsPlanned: 0,
      detailsDone: 0,
      detailsFailed: 0,
      reviews: 0,
    },
    phase: 'search',
    active: [],
    log: [],
  };
}

async function hydrate() {
  if (memory.hydrated) return;
  const raw = await chrome.storage.local.get([
    STORAGE_KEYS.settings,
    STORAGE_KEYS.state,
    STORAGE_KEYS.results,
    STORAGE_KEYS.details,
    STORAGE_KEYS.reviews,
  ]);
  memory.settings = normalizeSettings(raw[STORAGE_KEYS.settings]);
  memory.state = raw[STORAGE_KEYS.state] || freshState();
  memory.rows = Array.isArray(raw[STORAGE_KEYS.results]) ? raw[STORAGE_KEYS.results] : [];
  memory.details = Array.isArray(raw[STORAGE_KEYS.details]) ? raw[STORAGE_KEYS.details] : [];
  memory.reviews = Array.isArray(raw[STORAGE_KEYS.reviews]) ? raw[STORAGE_KEYS.reviews] : [];
  // A run can never survive a worker restart mid-flight; mark it finished.
  if (memory.state.status === RUN_STATUS.RUNNING || memory.state.status === RUN_STATUS.STOPPING) {
    memory.state.status = RUN_STATUS.IDLE;
    memory.state.active = [];
    memory.state.message = 'Previous run was interrupted (worker restarted).';
  }
  memory.hydrated = true;
}

export function normalizeSettings(input) {
  const s = Object.assign({}, DEFAULTS, input || {});
  s.proxyConfiguration = Object.assign({}, DEFAULTS.proxyConfiguration, (input || {}).proxyConfiguration || {});
  s.queries = (Array.isArray(s.queries) ? s.queries : String(s.queries || '').split('\n'))
    .map((q) => String(q).trim())
    .filter(Boolean)
    .slice(0, LIMITS.maxQueries);
  s.maxPagesPerQuery = clampInt(s.maxPagesPerQuery, 1, LIMITS.maxPagesPerQuery, DEFAULTS.maxPagesPerQuery);
  s.maxConcurrency = clampInt(s.maxConcurrency, 1, LIMITS.maxConcurrency, DEFAULTS.maxConcurrency);
  s.maxRequestRetries = clampInt(s.maxRequestRetries, 0, LIMITS.maxRequestRetries, DEFAULTS.maxRequestRetries);
  s.minDelayMs = clampInt(s.minDelayMs, 0, 120000, DEFAULTS.minDelayMs);
  s.maxDelayMs = clampInt(s.maxDelayMs, s.minDelayMs, 300000, Math.max(s.minDelayMs, DEFAULTS.maxDelayMs));
  s.resultsPerPage = clampInt(s.resultsPerPage, 1, 200, DEFAULTS.resultsPerPage);
  s.positionMode = s.positionMode === 'global' ? 'global' : 'per_page';
  for (const flag of ['bestsellerOnly', 'freeShippingOnly', 'excludeSponsored',
    'stopOnEmptyPage', 'manualCaptchaSolve', 'keepTabsOpen', 'scrapeDetails',
    'scrapeReviews', 'trackHistory']) {
    s[flag] = Boolean(s[flag]);
  }
  s.maxDetailListings = clampInt(s.maxDetailListings, 1, LIMITS.maxDetailListings, DEFAULTS.maxDetailListings);
  s.detailConcurrency = clampInt(s.detailConcurrency, 1, LIMITS.maxDetailConcurrency, DEFAULTS.detailConcurrency);
  s.maxReviewsPerListing = clampInt(s.maxReviewsPerListing, 0, LIMITS.maxReviewsPerListing, DEFAULTS.maxReviewsPerListing);
  s.dedupe = ['off', 'per_query', 'global'].includes(s.dedupe) ? s.dedupe : DEFAULTS.dedupe;
  s.engine = ['fetch', 'tab', 'hybrid'].includes(s.engine) ? s.engine : DEFAULTS.engine;
  s.minPrice = toNumOrNull(s.minPrice);
  s.maxPrice = toNumOrNull(s.maxPrice);
  s.shipTo = String(s.shipTo || '').trim().toUpperCase().slice(0, 2);
  if (!Object.prototype.hasOwnProperty.call(
    { most_relevant: 1, price_asc: 1, price_desc: 1, date_desc: 1 }, s.sortOrder)) {
    s.sortOrder = DEFAULTS.sortOrder;
  }
  return s;
}

function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function toNumOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ------------------------------------------------------------------ settings

export async function getSettings() {
  await hydrate();
  return memory.settings;
}

export async function saveSettings(patch) {
  await hydrate();
  memory.settings = normalizeSettings(Object.assign({}, memory.settings, patch || {}));
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: memory.settings });
  return memory.settings;
}

// --------------------------------------------------------------------- state

export async function getState() {
  await hydrate();
  return memory.state;
}

export async function resetState(patch) {
  await hydrate();
  memory.state = Object.assign(freshState(), patch || {});
  schedulePersist();
  broadcast();
  return memory.state;
}

export async function patchState(patch) {
  await hydrate();
  Object.assign(memory.state, patch || {});
  schedulePersist();
  broadcast();
  return memory.state;
}

export async function bumpProgress(patch) {
  await hydrate();
  for (const [k, v] of Object.entries(patch || {})) {
    memory.state.progress[k] = (memory.state.progress[k] || 0) + v;
  }
  schedulePersist();
  broadcast();
}

export async function setActive(list) {
  await hydrate();
  memory.state.active = list;
  broadcast();
}

export async function log(level, message, extra) {
  await hydrate();
  const entry = {
    t: Date.now(),
    level, // 'info' | 'warn' | 'error' | 'success'
    message: String(message),
  };
  if (extra) entry.extra = extra;
  memory.state.log.push(entry);
  if (memory.state.log.length > LIMITS.maxLogEntries) {
    memory.state.log.splice(0, memory.state.log.length - LIMITS.maxLogEntries);
  }
  schedulePersist();
  broadcast();
  return entry;
}

// ------------------------------------------------------------------- results

export async function addRows(rows) {
  await hydrate();
  if (!rows || !rows.length) return 0;
  const room = LIMITS.maxStoredRows - memory.rows.length;
  const accepted = room > 0 ? rows.slice(0, room) : [];
  memory.rows.push(...accepted);
  if (accepted.length < rows.length) {
    await log('warn', `Row cap reached (${LIMITS.maxStoredRows}); extra rows dropped. Export and clear.`);
  }
  schedulePersist();
  return accepted.length;
}

export async function getRows() {
  await hydrate();
  return memory.rows;
}

/** Upsert by listingId: a re-scrape replaces the previous detail record. */
export async function upsertDetail(detail) {
  await hydrate();
  if (!detail || !detail.listingId) return false;
  const index = memory.details.findIndex((d) => d.listingId === detail.listingId);
  if (index >= 0) {
    memory.details[index] = detail;
  } else {
    if (memory.details.length >= LIMITS.maxStoredDetails) {
      await log('warn', `Detail cap reached (${LIMITS.maxStoredDetails}); export and clear.`);
      return false;
    }
    memory.details.push(detail);
  }
  schedulePersist();
  return true;
}

export async function addReviews(reviews) {
  await hydrate();
  if (!reviews || !reviews.length) return 0;
  const room = LIMITS.maxStoredReviews - memory.reviews.length;
  if (room <= 0) return 0;
  const accepted = reviews.slice(0, room);
  memory.reviews.push(...accepted);
  schedulePersist();
  return accepted.length;
}

/** Drop previously stored reviews for a listing before re-adding fresh ones. */
export async function dropReviewsFor(listingId) {
  await hydrate();
  if (!listingId) return 0;
  const before = memory.reviews.length;
  memory.reviews = memory.reviews.filter((r) => r.listingId !== listingId);
  return before - memory.reviews.length;
}

export async function getDetails() {
  await hydrate();
  return memory.details;
}

export async function getReviews() {
  await hydrate();
  return memory.reviews;
}

export async function clearRows() {
  await hydrate();
  memory.rows = [];
  memory.details = [];
  memory.reviews = [];
  await chrome.storage.local.set({
    [STORAGE_KEYS.results]: [],
    [STORAGE_KEYS.details]: [],
    [STORAGE_KEYS.reviews]: [],
  });
  broadcast();
}

// ----------------------------------------------------------- persist/notify

let persistTimer = null;
let persistPending = false;

function schedulePersist() {
  persistPending = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (persistPending) void persistNow();
  }, 800);
}

export async function persistNow() {
  persistPending = false;
  try {
    await chrome.storage.local.set({
      [STORAGE_KEYS.state]: memory.state,
      [STORAGE_KEYS.results]: memory.rows,
      [STORAGE_KEYS.details]: memory.details,
      [STORAGE_KEYS.reviews]: memory.reviews,
    });
  } catch (err) {
    // Quota problems should never abort a run — surface and keep going.
    console.warn('[etsy-scraper] persist failed', err);
  }
}

let broadcastTimer = null;

/** Notify any open UI. Throttled: the log can move fast. */
function broadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const payload = {
      type: MSG.STATE_CHANGED,
      state: memory.state,
      rowCount: memory.rows.length,
      detailCount: memory.details.length,
      reviewCount: memory.reviews.length,
    };
    chrome.runtime.sendMessage(payload).catch(() => {
      /* no UI listening — expected */
    });
  }, 250);
}

export const __testing = { freshState };
