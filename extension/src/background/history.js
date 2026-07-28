/**
 * Per-listing snapshot history — the thing that makes velocity possible.
 *
 * A single scrape can only ever tell you a listing has 100 favourites. Knowing
 * it gained 15 of them since yesterday requires remembering yesterday, so every
 * enriched listing appends a compact snapshot here and the derived metrics are
 * recomputed from the stored series.
 *
 * Storage shape (chrome.storage.local, key `history`):
 *   { "<listingId>": [[ts, favorites, reviewCount, price, quantity], ...] }
 * Tuples rather than objects because this file grows with every run and JSON
 * keys would otherwise dominate the quota.
 */

import { STORAGE_KEYS, LIMITS } from '../common/constants.js';
import { applyMetrics, snapshotFromDetail } from '../common/metrics.js';

/** Snapshots closer together than this replace the previous one. */
const COALESCE_WINDOW_MS = 60 * 60 * 1000;

let cache = null;
let dirty = false;
let persistTimer = null;

async function load() {
  if (cache) return cache;
  const raw = await chrome.storage.local.get(STORAGE_KEYS.history);
  const stored = raw[STORAGE_KEYS.history];
  cache = stored && typeof stored === 'object' ? stored : {};
  return cache;
}

function toTuple(s) {
  return [s.ts, s.favorites, s.reviewCount, s.price, s.quantity];
}

function fromTuple(t) {
  if (Array.isArray(t)) {
    return { ts: t[0], favorites: t[1], reviewCount: t[2], price: t[3], quantity: t[4] };
  }
  // Tolerate the object form in case a future version writes it.
  return t;
}

export async function getSnapshots(listingId) {
  const store = await load();
  const series = store[String(listingId)];
  return Array.isArray(series) ? series.map(fromTuple) : [];
}

/**
 * Append (or coalesce) a snapshot for one listing and return the detail record
 * enriched with the resulting trend metrics.
 *
 * @param {object} detail parsed listing detail (must have listingId)
 * @param {{now?:number, track?:boolean}} [options] `track:false` computes
 *        metrics from existing history without recording a new snapshot
 * @returns {Promise<object>} detail + metrics
 */
export async function recordAndSummarize(detail, options = {}) {
  const now = Number(options.now) || Date.now();
  const listingId = detail && detail.listingId ? String(detail.listingId) : null;
  if (!listingId) return applyMetrics(detail, [], { now });

  const store = await load();
  const series = Array.isArray(store[listingId]) ? store[listingId].map(fromTuple) : [];
  const snapshot = snapshotFromDetail(detail, now);

  if (options.track === false) {
    return applyMetrics(detail, series.concat(snapshot), { now });
  }

  const last = series[series.length - 1];
  if (last && now - last.ts < COALESCE_WINDOW_MS) {
    // Same observation window: overwrite so repeated runs in one sitting do not
    // fabricate a growth interval.
    series[series.length - 1] = snapshot;
  } else {
    series.push(snapshot);
  }
  if (series.length > LIMITS.maxSnapshotsPerListing) {
    series.splice(0, series.length - LIMITS.maxSnapshotsPerListing);
  }

  if (!store[listingId] && Object.keys(store).length >= LIMITS.maxTrackedListings) {
    // At capacity: evict the least recently updated listing.
    const oldest = Object.entries(store)
      .map(([id, s]) => [id, Array.isArray(s) && s.length ? fromTuple(s[s.length - 1]).ts : 0])
      .sort((a, b) => a[1] - b[1])[0];
    if (oldest) delete store[oldest[0]];
  }

  store[listingId] = series.map(toTuple);
  schedulePersist();

  return applyMetrics(detail, series, { now });
}

function schedulePersist() {
  dirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistNow();
  }, 1500);
}

export async function persistNow() {
  if (!dirty || !cache) return;
  dirty = false;
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.history]: cache });
  } catch (err) {
    console.warn('[etsy-scraper] history persist failed', err);
  }
}

export async function stats() {
  const store = await load();
  const ids = Object.keys(store);
  let snapshots = 0;
  for (const id of ids) snapshots += (store[id] || []).length;
  return { listings: ids.length, snapshots };
}

/** History is intentionally NOT cleared by "Clear results" — it is the baseline. */
export async function clearHistory() {
  cache = {};
  dirty = false;
  await chrome.storage.local.set({ [STORAGE_KEYS.history]: {} });
}

export async function exportHistory() {
  const store = await load();
  const out = [];
  for (const [listingId, series] of Object.entries(store)) {
    for (const tuple of series) {
      const s = fromTuple(tuple);
      out.push({
        listingId,
        observedAt: new Date(s.ts).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        favorites: s.favorites,
        reviewCount: s.reviewCount,
        price: s.price,
        quantity: s.quantity,
      });
    }
  }
  return out.sort((a, b) => (a.listingId === b.listingId
    ? a.observedAt.localeCompare(b.observedAt)
    : a.listingId.localeCompare(b.listingId)));
}
