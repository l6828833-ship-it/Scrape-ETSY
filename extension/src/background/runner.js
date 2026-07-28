/**
 * Run orchestrator: fan out queries × pages across a bounded worker pool,
 * retry with exponential backoff, escalate engines when blocked, de-duplicate,
 * and stream rows into the store.
 */

import { ENGINES, RUN_STATUS, RETRYABLE_STATUS, LIMITS } from '../common/constants.js';
import { buildSearchUrl } from '../common/url-builder.js';
import { fetchSearchPage } from './fetch-engine.js';
import { scrapeInTab, scrapeExistingTab } from './tab-engine.js';
import { parseHtmlOffscreen, offscreenAvailable, closeOffscreen } from './offscreen.js';
import { buildListingUrl, fetchDetailViaFetch, fetchDetailViaTab } from './detail-engine.js';
import * as history from './history.js';
import * as store from './store.js';
import * as proxy from './proxy.js';
// Classic script: executing it defines globalThis.EtsyParse (JSON-LD-only
// parsing works in the worker; DOM parsing needs the offscreen document).
import '../common/parse.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => Math.floor(min + Math.random() * Math.max(0, max - min));

let current = null; // {controller, settings, promise}

export function isRunning() {
  return Boolean(current);
}

export function stopRun() {
  if (!current) return false;
  current.controller.abort();
  void store.patchState({ status: RUN_STATUS.STOPPING, message: 'Stopping after in-flight requests…' });
  return true;
}

/** Round-robins (query, page) tasks and supports early per-query termination. */
class Scheduler {
  constructor(queries, maxPages) {
    this.queues = queries.map((q) => ({ query: q, nextPage: 1, done: false }));
    this.maxPages = maxPages;
    this.cursor = 0;
  }

  next() {
    for (let i = 0; i < this.queues.length; i += 1) {
      const idx = (this.cursor + i) % this.queues.length;
      const q = this.queues[idx];
      if (q.done || q.nextPage > this.maxPages) continue;
      this.cursor = (idx + 1) % this.queues.length;
      const task = { query: q.query, page: q.nextPage, queueIndex: idx };
      q.nextPage += 1;
      return task;
    }
    return null;
  }

  markDone(queueIndex, reason) {
    const q = this.queues[queueIndex];
    if (q && !q.done) {
      q.done = true;
      q.doneReason = reason;
      return true;
    }
    return false;
  }

  remainingQueries() {
    return this.queues.filter((q) => !q.done && q.nextPage <= this.maxPages).length;
  }
}

class Dedupe {
  constructor(mode) {
    this.mode = mode;
    this.global = new Set();
    this.perQuery = new Map();
  }

  /** @returns {{kept:Array<object>, duplicates:number}} */
  filter(rows, query) {
    if (this.mode === 'off') return { kept: rows, duplicates: 0 };
    let set;
    if (this.mode === 'global') {
      set = this.global;
    } else {
      if (!this.perQuery.has(query)) this.perQuery.set(query, new Set());
      set = this.perQuery.get(query);
    }
    const kept = [];
    let duplicates = 0;
    for (const row of rows) {
      const key = row.listingId || row.url;
      if (!key) {
        kept.push(row);
        continue;
      }
      if (set.has(key)) {
        duplicates += 1;
        continue;
      }
      set.add(key);
      kept.push(row);
    }
    return { kept, duplicates };
  }
}

/**
 * Row-level filters applied to every parsed page.
 *
 * Note we do NOT filter on `bestseller` when `bestsellerOnly` is set: Etsy's
 * `is_best_seller=true` facet already restricts the result set server-side, and
 * badge detection in the DOM is only best-effort — filtering locally as well
 * would silently drop valid rows whose badge we failed to see.
 *
 * @returns {{rows:Array<object>, adsSkipped:number}}
 */
export function applyRowFilters(records, settings) {
  if (!settings || !settings.excludeSponsored) return { rows: records, adsSkipped: 0 };
  const rows = records.filter((r) => !r.sponsored);
  return { rows, adsSkipped: records.length - rows.length };
}

/**
 * Kick off a scraping run. Resolves when the run finishes or is stopped.
 * @param {object} rawSettings see DEFAULTS in common/constants.js
 */
export async function startRun(rawSettings) {
  if (current) throw new Error('A run is already in progress');

  const settings = await store.saveSettings(rawSettings);
  if (!settings.queries.length) throw new Error('At least one search query is required');

  const controller = new AbortController();
  const signal = controller.signal;
  const scheduler = new Scheduler(settings.queries, settings.maxPagesPerQuery);
  const dedupe = new Dedupe(settings.dedupe);

  await store.resetState({
    status: RUN_STATUS.RUNNING,
    startedAt: Date.now(),
    engineInUse: settings.engine,
    progress: {
      queriesTotal: settings.queries.length,
      queriesDone: 0,
      pagesPlanned: settings.queries.length * settings.maxPagesPerQuery,
      pagesDone: 0,
      pagesFailed: 0,
      rows: 0,
      duplicates: 0,
      adsSkipped: 0,
      retries: 0,
      blocks: 0,
    },
    active: [],
    log: [],
  });

  await store.log('info',
    `Run started: ${settings.queries.length} quer${settings.queries.length === 1 ? 'y' : 'ies'} × up to `
    + `${settings.maxPagesPerQuery} page(s), engine=${settings.engine}, concurrency=${settings.maxConcurrency}`);

  if (settings.proxyConfiguration && settings.proxyConfiguration.enabled) {
    const applied = await proxy.applyProxyConfiguration(settings.proxyConfiguration);
    await store.log(applied.applied ? 'info' : 'warn',
      applied.applied
        ? `Proxy active for *.etsy.com via ${applied.label} (${applied.count} in rotation)`
        : `Proxy not applied: ${applied.reason}`);
  }

  const ctx = {
    settings,
    signal,
    scheduler,
    dedupe,
    /** Queries whose fetch engine got blocked -> use tab engine from now on. */
    escalated: new Set(),
    active: new Map(),
    requestCount: 0,
    /** listingId -> first search hit, in discovery order (phase-2 queue). */
    collected: new Map(),
    /** Listings whose detail fetch was blocked -> tab engine from now on. */
    detailEscalated: false,
  };

  const workerCount = Math.min(settings.maxConcurrency, Math.max(1, settings.queries.length * settings.maxPagesPerQuery));
  const promise = (async () => {
    try {
      await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(ctx, i)));
      if (settings.scrapeDetails && !signal.aborted) await detailPhase(ctx);
    } finally {
      await finishRun(ctx);
    }
  })();

  current = { controller, settings, promise };
  return promise;
}

async function finishRun(ctx) {
  const aborted = ctx.signal.aborted;
  const state = await store.getState();
  const p = state.progress;
  if (ctx.settings.proxyConfiguration && ctx.settings.proxyConfiguration.enabled) {
    await proxy.clearProxyConfiguration();
    await store.log('info', 'Proxy settings restored to system default.');
  }
  await store.setActive([]);
  const deep = p.detailsPlanned
    ? ` ${p.detailsDone - p.detailsFailed}/${p.detailsPlanned} listing detail(s), ${p.reviews} review(s).`
    : '';
  await store.patchState({
    status: aborted ? RUN_STATUS.IDLE : RUN_STATUS.DONE,
    finishedAt: Date.now(),
    phase: 'idle',
    message: aborted
      ? `Stopped. ${p.rows} rows from ${p.pagesDone} page(s).${deep}`
      : `Finished. ${p.rows} rows from ${p.pagesDone} page(s), ${p.pagesFailed} failed.${deep}`,
  });
  await store.log(aborted ? 'warn' : 'success',
    aborted ? 'Run stopped by user.' : `Run complete: ${p.rows} rows, ${p.duplicates} duplicates skipped.`);
  await store.persistNow();
  await closeOffscreen();
  current = null;
}

async function worker(ctx, workerIndex) {
  let first = workerIndex === 0;
  for (;;) {
    if (ctx.signal.aborted) return;
    const task = ctx.scheduler.next();
    if (!task) return;

    // Politeness delay: skip only for the very first request of the run.
    if (!first) {
      const wait = jitter(ctx.settings.minDelayMs, ctx.settings.maxDelayMs);
      if (wait > 0) await sleep(wait);
      if (ctx.signal.aborted) return;
    }
    first = false;

    const label = `"${task.query}" p${task.page}`;
    ctx.active.set(label, true);
    await store.setActive([...ctx.active.keys()]);
    try {
      await processTask(ctx, task, label);
    } catch (err) {
      await store.log('error', `${label} crashed: ${(err && err.message) || err}`);
      await store.bumpProgress({ pagesFailed: 1 });
    } finally {
      ctx.active.delete(label);
      await store.setActive([...ctx.active.keys()]);
    }
  }
}

function pickEngine(ctx, task, attempt) {
  const configured = ctx.settings.engine;
  if (configured === ENGINES.FETCH) return ENGINES.FETCH;
  if (configured === ENGINES.TAB) return ENGINES.TAB;
  // Hybrid: fetch first; switch to a real tab once this query has been blocked
  // or after the first failed attempt.
  if (ctx.escalated.has(task.query) || attempt > 0) return ENGINES.TAB;
  return ENGINES.FETCH;
}

async function processTask(ctx, task, label) {
  const { settings } = ctx;
  const url = buildSearchUrl({
    query: task.query,
    page: task.page,
    sortOrder: settings.sortOrder,
    minPrice: settings.minPrice,
    maxPrice: settings.maxPrice,
    shipTo: settings.shipTo,
    bestsellerOnly: settings.bestsellerOnly,
    freeShippingOnly: settings.freeShippingOnly,
  });

  const context = {
    query: task.query,
    page: task.page,
    sourceUrl: url,
    resultsPerPage: settings.positionMode === 'global' ? settings.resultsPerPage : 0,
    scrapedAt: null, // stamped per page below
  };

  const maxAttempts = settings.maxRequestRetries + 1;
  let lastError = 'unknown error';

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (ctx.signal.aborted) return;
    if (attempt > 0) {
      const backoff = Math.min(30000, 700 * 2 ** (attempt - 1)) + jitter(0, 600);
      await store.bumpProgress({ retries: 1 });
      await store.log('warn', `${label} retry ${attempt}/${settings.maxRequestRetries} in ${Math.round(backoff / 1000)}s — ${lastError}`);
      await sleep(backoff);
      if (ctx.signal.aborted) return;
    }

    const engine = pickEngine(ctx, task, attempt);
    context.scrapedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

    ctx.requestCount += 1;
    if (settings.proxyConfiguration && settings.proxyConfiguration.enabled) {
      const rotated = await proxy.noteRequestAndMaybeRotate(settings.proxyConfiguration.rotateEveryRequests);
      if (rotated) await store.log('info', `Rotated proxy -> ${rotated}`);
    }

    const outcome = engine === ENGINES.FETCH
      ? await runFetchAttempt(ctx, url, context)
      : await runTabAttempt(ctx, url, context, label);

    if (outcome.aborted) return;

    if (outcome.blocked) {
      await store.bumpProgress({ blocks: 1 });
      if (settings.engine === ENGINES.HYBRID && !ctx.escalated.has(task.query)) {
        ctx.escalated.add(task.query);
        await store.log('warn', `${label} blocked (${outcome.blockReason || 'challenge'}) — escalating "${task.query}" to the tab engine.`);
      }
      lastError = `blocked: ${outcome.blockReason || 'challenge page'}`;
      continue;
    }

    if (!outcome.ok) {
      lastError = outcome.error || 'request failed';
      if (!outcome.retryable) {
        await store.log('error', `${label} failed permanently — ${lastError}`);
        await store.bumpProgress({ pagesDone: 1, pagesFailed: 1 });
        return;
      }
      continue;
    }

    // Success -------------------------------------------------------------
    const records = outcome.records || [];
    if (!records.length) {
      // Page 1 with nothing on it is suspicious rather than final: on hybrid,
      // give the tab engine a shot before believing "no results".
      const suspicious = task.page === 1 && engine === ENGINES.FETCH
        && settings.engine === ENGINES.HYBRID && !outcome.noResults;
      if (suspicious && attempt + 1 < maxAttempts) {
        ctx.escalated.add(task.query);
        lastError = 'no listings found via fetch (page 1)';
        continue;
      }
      await store.bumpProgress({ pagesDone: 1 });
      if (settings.stopOnEmptyPage && ctx.scheduler.markDone(task.queueIndex, 'empty page')) {
        await store.bumpProgress({ queriesDone: 1 });
        await store.log('info', `${label} returned 0 listings — stopping pagination for "${task.query}".`);
      } else {
        await store.log('info', `${label} returned 0 listings.`);
      }
      return;
    }

    // Row-level filters run before de-duplication so the dupe count stays
    // meaningful, and after the empty-page check above so that a page made up
    // entirely of ads is not mistaken for the end of the results.
    const { rows: filtered, adsSkipped } = applyRowFilters(records, settings);
    const { kept, duplicates } = ctx.dedupe.filter(filtered, task.query);
    for (const row of kept) {
      if (row.listingId && !ctx.collected.has(row.listingId)) {
        ctx.collected.set(row.listingId, { url: row.url, query: row.query, page: row.page, position: row.position });
      }
    }
    const stored = await store.addRows(kept);
    await store.bumpProgress({ pagesDone: 1, rows: stored, duplicates, adsSkipped });
    if (task.page >= settings.maxPagesPerQuery
      && ctx.scheduler.markDone(task.queueIndex, 'page limit')) {
      await store.bumpProgress({ queriesDone: 1 });
    }
    await store.log('success',
      `${label} -> ${stored} rows${duplicates ? ` (${duplicates} dupes)` : ''}`
      + `${adsSkipped ? ` (${adsSkipped} ads skipped)` : ''} via ${engine}`
      + ` [ld:${outcome.counts.jsonld} dom:${outcome.counts.dom}]`);
    return;
  }

  await store.log('error', `${label} gave up after ${maxAttempts} attempt(s) — ${lastError}`);
  await store.bumpProgress({ pagesDone: 1, pagesFailed: 1 });
}

// ---------------------------------------------------------------- phase 2
// Deep listing intelligence: re-open each listing discovered above, extract the
// full dataset, snapshot it for velocity, and store reviews separately.

async function detailPhase(ctx) {
  const { settings } = ctx;
  const targets = [...ctx.collected.entries()]
    .slice(0, settings.maxDetailListings)
    .map(([listingId, meta]) => ({ listingId, ...meta }));

  if (!targets.length) {
    await store.log('info', 'Deep scrape skipped: the search phase collected no listings.');
    return;
  }

  await store.patchState({ phase: 'details' });
  await store.bumpProgress({ detailsPlanned: targets.length });
  const skipped = ctx.collected.size - targets.length;
  await store.log('info',
    `Deep scrape: ${targets.length} listing(s)${skipped > 0 ? ` (${skipped} over the cap were skipped)` : ''}`
    + `, concurrency=${settings.detailConcurrency}`
    + `${settings.scrapeReviews ? `, up to ${settings.maxReviewsPerListing} reviews each` : ', reviews off'}`);

  if (!offscreenAvailable() && settings.engine === ENGINES.FETCH) {
    await store.log('warn',
      'No offscreen document available: detail records will carry JSON-LD fields only '
      + '(no favourites, stock, variations or reviews). Use the tab engine for the full dataset.');
  }

  let cursor = 0;
  const next = () => (cursor < targets.length ? targets[cursor++] : null);

  const workers = Array.from(
    { length: Math.min(settings.detailConcurrency, targets.length) },
    (_, index) => (async () => {
      let firstRequest = index === 0;
      for (;;) {
        if (ctx.signal.aborted) return;
        const target = next();
        if (!target) return;

        if (!firstRequest) {
          const wait = jitter(settings.minDelayMs, settings.maxDelayMs);
          if (wait > 0) await sleep(wait);
          if (ctx.signal.aborted) return;
        }
        firstRequest = false;

        const label = `listing ${target.listingId}`;
        ctx.active.set(label, true);
        await store.setActive([...ctx.active.keys()]);
        try {
          await processDetailTask(ctx, target, label);
        } catch (err) {
          await store.log('error', `${label} crashed: ${(err && err.message) || err}`);
          await store.bumpProgress({ detailsDone: 1, detailsFailed: 1 });
        } finally {
          ctx.active.delete(label);
          await store.setActive([...ctx.active.keys()]);
        }
      }
    })(),
  );

  await Promise.all(workers);
  await history.persistNow();
}

async function processDetailTask(ctx, target, label) {
  const { settings } = ctx;
  const url = buildListingUrl(target.listingId, target.url);
  if (!url) {
    await store.bumpProgress({ detailsDone: 1, detailsFailed: 1 });
    await store.log('warn', `${label} has no usable URL; skipped.`);
    return;
  }

  const maxAttempts = settings.maxRequestRetries + 1;
  let lastError = 'unknown error';

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (ctx.signal.aborted) return;
    if (attempt > 0) {
      const backoff = Math.min(30000, 700 * 2 ** (attempt - 1)) + jitter(0, 600);
      await store.bumpProgress({ retries: 1 });
      await store.log('warn', `${label} retry ${attempt}/${settings.maxRequestRetries} in ${Math.round(backoff / 1000)}s — ${lastError}`);
      await sleep(backoff);
      if (ctx.signal.aborted) return;
    }

    const context = {
      listingId: target.listingId,
      sourceUrl: url,
      scrapeReviews: settings.scrapeReviews,
      maxReviews: settings.maxReviewsPerListing,
      scrapedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };

    // Reviews and favourites only exist in the rendered DOM, so a fetch without
    // an offscreen parser is upgraded to a tab automatically.
    const useTab = settings.engine === ENGINES.TAB
      || ctx.detailEscalated
      || attempt > 0
      || (settings.engine === ENGINES.HYBRID && !offscreenAvailable());

    ctx.requestCount += 1;
    if (settings.proxyConfiguration && settings.proxyConfiguration.enabled) {
      const rotated = await proxy.noteRequestAndMaybeRotate(settings.proxyConfiguration.rotateEveryRequests);
      if (rotated) await store.log('info', `Rotated proxy -> ${rotated}`);
    }

    const outcome = useTab
      ? await fetchDetailViaTab(url, {
        signal: ctx.signal,
        context,
        keepTabsOpen: settings.keepTabsOpen,
      })
      : await fetchDetailViaFetch(url, {
        signal: ctx.signal,
        context,
        retryableStatus: RETRYABLE_STATUS,
      });

    if (outcome.aborted || ctx.signal.aborted) return;

    if (outcome.blocked) {
      await store.bumpProgress({ blocks: 1 });
      if (settings.engine === ENGINES.HYBRID && !ctx.detailEscalated) {
        ctx.detailEscalated = true;
        await store.log('warn', `${label} blocked — escalating the deep scrape to the tab engine.`);
      }
      lastError = outcome.error || 'blocked';
      continue;
    }

    if (!outcome.ok || !outcome.record) {
      lastError = outcome.error || 'no listing data';
      if (!outcome.retryable) break;
      continue;
    }

    // Snapshot first, then attach the derived velocity metrics.
    const enriched = settings.trackHistory
      ? await history.recordAndSummarize(outcome.record)
      : await history.recordAndSummarize(outcome.record, { track: false });

    await store.upsertDetail(enriched);

    let reviewCount = 0;
    if (settings.scrapeReviews && outcome.reviews && outcome.reviews.length) {
      await store.dropReviewsFor(enriched.listingId);
      reviewCount = await store.addReviews(outcome.reviews.slice(0, settings.maxReviewsPerListing));
    }

    await store.bumpProgress({ detailsDone: 1, reviews: reviewCount });
    await store.log('success',
      `${label} -> ${describeDetail(enriched)}${reviewCount ? `, ${reviewCount} review(s)` : ''}`);
    return;
  }

  await store.bumpProgress({ detailsDone: 1, detailsFailed: 1 });
  await store.log('error', `${label} gave up — ${lastError}`);
}

/** Compact log summary: the signals worth eyeballing while a run happens. */
function describeDetail(d) {
  const bits = [];
  if (d.favoritesCount !== null && d.favoritesCount !== undefined) bits.push(`${d.favoritesCount} favs`);
  if (d.favoritesPerDay !== null && d.favoritesPerDay !== undefined) bits.push(`${d.favoritesPerDay}/day`);
  if (d.cartCount) bits.push(`${d.cartCount} in cart`);
  if (d.quantityAvailable !== null && d.quantityAvailable !== undefined) bits.push(`qty ${d.quantityAvailable}`);
  if (d.opportunityScore !== null && d.opportunityScore !== undefined) bits.push(`opp ${d.opportunityScore}`);
  return bits.length ? bits.join(', ') : 'detail captured';
}

async function runFetchAttempt(ctx, url, context) {
  const res = await fetchSearchPage(url, { signal: ctx.signal });
  if (ctx.signal.aborted) return { aborted: true };

  if (!res.ok && !res.html) {
    return {
      ok: false,
      error: res.error || `HTTP ${res.status}`,
      retryable: res.status === 0 || RETRYABLE_STATUS.has(res.status),
    };
  }

  let parsed;
  try {
    parsed = offscreenAvailable()
      ? await parseHtmlOffscreen(res.html, context)
      : parseJsonLdOnly(res.html, context);
  } catch (err) {
    await store.log('warn', `Offscreen parser unavailable (${(err && err.message) || err}); using JSON-LD-only parsing.`);
    parsed = parseJsonLdOnly(res.html, context);
  }

  if (parsed.blocked) return { blocked: true, blockReason: parsed.blockReason };
  if (!res.ok) {
    return {
      ok: false,
      error: res.error || `HTTP ${res.status}`,
      retryable: RETRYABLE_STATUS.has(res.status),
    };
  }
  return {
    ok: true,
    records: parsed.records,
    counts: parsed.counts,
    noResults: parsed.noResults,
  };
}

/** Worker-side fallback: JSON-LD extraction needs no DOM. */
function parseJsonLdOnly(html, context) {
  const P = globalThis.EtsyParse;
  const block = P.detectBlock(html);
  if (block.blocked) {
    return { records: [], blocked: true, blockReason: block.reason, counts: { jsonld: 0, dom: 0, merged: 0 }, noResults: false };
  }
  const jsonLd = P.recordsFromJsonLd(html);
  const records = jsonLd
    .filter((r) => r.listingId || r.url)
    .map((r, i) => P.finalize(r, i, context));
  return {
    records,
    blocked: false,
    blockReason: null,
    counts: { jsonld: jsonLd.length, dom: 0, merged: records.length },
    noResults: records.length === 0 && P.looksLikeNoResults(html),
  };
}

async function runTabAttempt(ctx, url, context, label) {
  const res = await scrapeInTab(url, {
    signal: ctx.signal,
    context,
    keepTabsOpen: ctx.settings.keepTabsOpen,
    manualCaptchaSolve: ctx.settings.manualCaptchaSolve,
    onNotice: (level, msg) => { void store.log(level, msg); },
  });
  if (ctx.signal.aborted) return { aborted: true };

  if (res.blocked) return { blocked: true, blockReason: (res.result && res.result.blockReason) || 'challenge' };
  if (!res.ok) return { ok: false, error: res.error || `tab engine failed on ${label}`, retryable: true };
  return {
    ok: true,
    records: res.result.records,
    counts: res.result.counts,
    noResults: res.result.noResults,
  };
}

/** One-off: scrape the Etsy search page the user is currently viewing. */
export async function scrapeActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) throw new Error('No active tab');
  if (!/^https:\/\/www\.etsy\.com\//.test(tab.url)) {
    throw new Error('Active tab is not an etsy.com page');
  }
  const settings = await store.getSettings();
  const url = new URL(tab.url);
  const query = url.searchParams.get('q') || url.pathname.split('/').pop() || 'current-page';
  const page = Number(url.searchParams.get('page')) || 1;
  // Statically imported on purpose: service workers forbid dynamic imports.
  const res = await scrapeExistingTab(tab.id, {
    query,
    page,
    sourceUrl: tab.url,
    resultsPerPage: settings.positionMode === 'global' ? settings.resultsPerPage : 0,
    scrapedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  });
  if (!res.ok) throw new Error(res.error || 'extraction failed');

  const dedupe = new Dedupe(settings.dedupe === 'off' ? 'off' : 'global');
  const existing = await store.getRows();
  for (const row of existing) {
    if (row.listingId) dedupe.global.add(row.listingId);
  }
  const { rows: filtered, adsSkipped } = applyRowFilters(res.result.records, settings);
  const { kept, duplicates } = dedupe.filter(filtered, query);
  const stored = await store.addRows(kept);
  await store.bumpProgress({ rows: stored, duplicates, adsSkipped, pagesDone: 1 });
  await store.log('success', `Current tab -> ${stored} rows${duplicates ? ` (${duplicates} dupes)` : ''}`
    + `${adsSkipped ? ` (${adsSkipped} ads skipped)` : ''}`);
  await store.persistNow();
  return { rows: stored, duplicates, total: (await store.getRows()).length };
}

export const __testing = { Scheduler, Dedupe, applyRowFilters, LIMITS };
