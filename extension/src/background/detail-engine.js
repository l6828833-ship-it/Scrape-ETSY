/**
 * Phase-2 engine: fetch one listing page and extract the deep dataset.
 *
 * Same two transports as the search phase (worker `fetch` + offscreen parsing,
 * or a real tab) so blocked listings can escalate exactly like search pages do.
 * The worker-side fallback here is thinner than the search one: a listing page's
 * JSON-LD carries title/description/price/rating but none of the DOM-only
 * signals (favourites, cart count, stock, variations, reviews), so a run without
 * an offscreen document produces sparse detail records and says so.
 */

import { ETSY_LISTING_URL } from '../common/constants.js';
import { fetchListingPage } from './fetch-engine.js';
import { openScrapeTab } from './tabs.js';
import { parseDetailOffscreen, offscreenAvailable } from './offscreen.js';
// Classic scripts: importing publishes globalThis.EtsyParse / EtsyDetail.
import '../common/parse.js';
import '../common/detail-parse.js';

const INJECT_FILES = [
  'src/common/parse.js',
  'src/common/detail-parse.js',
  // EHunt renders into the page DOM, so it is only readable from a real tab.
  'src/common/ehunt-parse.js',
  'src/content/extract-detail.js',
];

/** @returns {string} canonical listing URL for an id (or the row's own URL) */
export function buildListingUrl(listingId, fallbackUrl) {
  if (listingId) return `${ETSY_LISTING_URL}${listingId}`;
  return fallbackUrl || null;
}

/**
 * @param {string} url
 * @param {{signal?:AbortSignal, context:object}} opts
 * @returns {Promise<{ok:boolean, blocked:boolean, blockReason:?string,
 *   error:?string, retryable:boolean, record:?object, reviews:Array<object>,
 *   counts:object}>}
 */
export async function fetchDetailViaFetch(url, opts = {}) {
  const { signal, context = {}, retryableStatus } = opts;
  const res = await fetchListingPage(url, { signal });
  if (signal && signal.aborted) return { aborted: true };

  if (!res.html) {
    return {
      ok: false,
      blocked: false,
      blockReason: null,
      error: res.error || `HTTP ${res.status}`,
      retryable: res.status === 0 || (retryableStatus ? retryableStatus.has(res.status) : true),
      record: null,
      reviews: [],
      counts: null,
    };
  }

  let parsed;
  try {
    parsed = offscreenAvailable()
      ? await parseDetailOffscreen(res.html, context)
      : parseDetailWorkerFallback(res.html, context);
  } catch (_) {
    parsed = parseDetailWorkerFallback(res.html, context);
  }

  if (parsed.blocked) {
    return {
      ok: false,
      blocked: true,
      blockReason: parsed.blockReason,
      error: `blocked: ${parsed.blockReason}`,
      retryable: true,
      record: null,
      reviews: [],
      counts: parsed.counts,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      blocked: false,
      blockReason: null,
      error: res.error || `HTTP ${res.status}`,
      retryable: retryableStatus ? retryableStatus.has(res.status) : false,
      record: parsed.record,
      reviews: parsed.reviews,
      counts: parsed.counts,
    };
  }
  return {
    ok: Boolean(parsed.record && parsed.record.listingId),
    blocked: false,
    blockReason: null,
    error: parsed.record ? null : 'no listing data found on the page',
    retryable: true,
    record: parsed.record,
    reviews: parsed.reviews,
    counts: parsed.counts,
  };
}

/** JSON-LD only — no DOM, therefore no favourites/stock/variations/reviews. */
function parseDetailWorkerFallback(html, context) {
  const P = globalThis.EtsyParse;
  const D = globalThis.EtsyDetail;
  const block = P.detectBlock(html);
  if (block.blocked) {
    return { record: null, reviews: [], blocked: true, blockReason: block.reason, counts: null };
  }
  const ld = D.fromJsonLd(html);
  const record = D.finalizeDetail(ld, {}, context, []);
  return {
    record: record && record.listingId ? record : null,
    reviews: [],
    blocked: false,
    blockReason: null,
    counts: { jsonld: 1, dom: 0, reviews: 0 },
  };
}

/**
 * Tab transport: renders the page so lazily-loaded reviews and variation
 * selects exist before parsing.
 */
export async function fetchDetailViaTab(url, opts = {}) {
  const {
    signal,
    context = {},
    keepTabsOpen = false,
    loadTimeoutMs = 60000,
    tuning = {},
  } = opts;

  let tabId = null;
  try {
    ({ tabId } = await openScrapeTab(url, { tabMode: opts.tabMode }));
    await waitForComplete(tabId, loadTimeoutMs, signal);

    await chrome.scripting.executeScript({ target: { tabId }, files: INJECT_FILES });
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (o) => globalThis.__etsyExtractDetail(o),
      args: [{ context, ...tuning }],
    });

    if (signal && signal.aborted) return { aborted: true };
    if (!result) {
      return { ok: false, blocked: false, error: 'no result from injected script', retryable: true, record: null, reviews: [], counts: null };
    }
    if (result.blocked) {
      return { ok: false, blocked: true, blockReason: result.blockReason, error: `blocked: ${result.blockReason}`, retryable: true, record: null, reviews: [], counts: result.counts };
    }
    if (result.error) {
      return { ok: false, blocked: false, error: result.error, retryable: true, record: result.record, reviews: result.reviews || [], counts: result.counts };
    }
    return {
      ok: Boolean(result.record && result.record.listingId),
      blocked: false,
      blockReason: null,
      error: result.record ? null : 'no listing data found on the page',
      retryable: true,
      record: result.record,
      reviews: result.reviews || [],
      counts: result.counts,
      ehuntFound: Boolean(result.ehuntFound),
    };
  } catch (err) {
    return {
      ok: false,
      blocked: false,
      blockReason: null,
      error: String((err && err.message) || err),
      retryable: true,
      record: null,
      reviews: [],
      counts: null,
    };
  } finally {
    if (tabId != null && !keepTabsOpen) {
      try {
        await chrome.tabs.remove(tabId);
      } catch (_) { /* already closed */ }
    }
  }
}

function waitForComplete(tabId, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(arg);
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') finish(resolve, true);
    };
    const onRemoved = (id) => {
      if (id === tabId) finish(reject, new Error('tab closed before load finished'));
    };
    const onAbort = () => finish(reject, new Error('aborted'));
    const timer = setTimeout(() => finish(resolve, false), timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    chrome.tabs.get(tabId).then((t) => {
      if (t && t.status === 'complete') finish(resolve, true);
    }).catch(() => { /* covered by onRemoved/timeout */ });
  });
}
