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
  };

  const workerCount = Math.min(settings.maxConcurrency, Math.max(1, settings.queries.length * settings.maxPagesPerQuery));
  const promise = (async () => {
    try {
      await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(ctx, i)));
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
  await store.patchState({
    status: aborted ? RUN_STATUS.IDLE : RUN_STATUS.DONE,
    finishedAt: Date.now(),
    message: aborted
      ? `Stopped. ${p.rows} rows from ${p.pagesDone} page(s).`
      : `Finished. ${p.rows} rows from ${p.pagesDone} page(s), ${p.pagesFailed} failed.`,
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

    const { kept, duplicates } = ctx.dedupe.filter(records, task.query);
    const stored = await store.addRows(kept);
    await store.bumpProgress({ pagesDone: 1, rows: stored, duplicates });
    if (task.page >= settings.maxPagesPerQuery
      && ctx.scheduler.markDone(task.queueIndex, 'page limit')) {
      await store.bumpProgress({ queriesDone: 1 });
    }
    await store.log('success',
      `${label} -> ${stored} rows${duplicates ? ` (${duplicates} dupes)` : ''} via ${engine}`
      + ` [ld:${outcome.counts.jsonld} dom:${outcome.counts.dom}]`);
    return;
  }

  await store.log('error', `${label} gave up after ${maxAttempts} attempt(s) — ${lastError}`);
  await store.bumpProgress({ pagesDone: 1, pagesFailed: 1 });
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
  const { kept, duplicates } = dedupe.filter(res.result.records, query);
  const stored = await store.addRows(kept);
  await store.bumpProgress({ rows: stored, duplicates, pagesDone: 1 });
  await store.log('success', `Current tab -> ${stored} rows${duplicates ? ` (${duplicates} dupes)` : ''}`);
  await store.persistNow();
  return { rows: stored, duplicates, total: (await store.getRows()).length };
}

export const __testing = { Scheduler, Dedupe, LIMITS };
