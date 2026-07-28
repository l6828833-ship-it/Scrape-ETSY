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
import { fetchListingFromApi, mergeApiRecord, API_RATE } from '../common/etsy-api.js';
import { upgradeModeForVisibility, closeScrapeSurface } from './tabs.js';
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
  const cfg = settings || {};
  let rows = records || [];
  let adsSkipped = 0;
  let nonDigitalSkipped = 0;

  if (cfg.excludeSponsored) {
    const kept = rows.filter((r) => !r.sponsored);
    adsSkipped = rows.length - kept.length;
    rows = kept;
  }

  if (cfg.digitalOnly) {
    // Etsy labels digital listings but stays silent for physical ones, so only
    // an explicit `true` qualifies. Unlabelled rows are dropped and counted, so
    // over-filtering is visible in the log instead of silently shrinking a run.
    const kept = rows.filter((r) => r.isDigital === true);
    nonDigitalSkipped = rows.length - kept.length;
    rows = kept;
  }

  return { rows, adsSkipped, nonDigitalSkipped };
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
      nonDigitalSkipped: 0,
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
    /** How often each key deep-scrape field came back empty. */
    detailGaps: {},
    detailsCaptured: 0,
    /** Where scraped pages open; may be upgraded below for visibility. */
    tabMode: settings.tabMode,
    /** EHunt panel bookkeeping. */
    ehuntHits: 0,
    ehuntOnPage: 0,
    ehuntTagHits: 0,
    /** Furthest EHunt got on any listing: 0 absent … 4 tags rendered. */
    ehuntBestStage: 0,
    // Tag-route accounting, so an empty `tags` column can be explained rather
    // than merely counted.
    tagPages: 0,
    tagPagesWithLinks: 0,
    tagPagesWithModule: 0,
    tagPagesPlaceholder: 0,
    /** Search-row coverage, so a rotted card selector is announced. */
    rowGaps: {},
    rowsSeen: 0,
    /** Etsy API enrichment bookkeeping. */
    apiHits: 0,
    apiMisses: 0,
    apiDisabled: false,
    lastApiCallAt: 0,
  };

  const workerCount = Math.min(settings.maxConcurrency, Math.max(1, settings.queries.length * settings.maxPagesPerQuery));
  const promise = (async () => {
    try {
      // Said up front rather than left to be discovered in the export: the
      // search grid does not carry these fields at all, so with the deep scrape
      // off there is no path by which they could ever be populated.
      if (!settings.scrapeDetails) {
        await store.log('info',
          'Deep scrape is OFF, so tags, description, favourites, stock and shop sales will '
          + 'not be collected — Etsy publishes none of them on the search grid. Open '
          + '"Deep scrape" and tick "Scrape listing details" to get them.');
      }
      await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(ctx, i)));
      if (settings.scrapeDetails && !signal.aborted) await detailPhase(ctx);
    } finally {
      await finishRun(ctx);
    }
  })();

  current = { controller, settings, promise };
  return promise;
}

/**
 * Resolve review counts that cannot be trusted, using evidence a single card
 * cannot provide.
 *
 * A bare "(1,482)" on a card with no stars is usually the listing's review
 * count — but sometimes it is the shop's total, and the two are structurally
 * identical inside one card. The giveaway is cross-row: in a real run, `144`
 * appeared on all three listings from one shop, `109` on all three from
 * another. So when the same count repeats across multiple listings from the same
 * shop and none of those rows had a star rating, it is a shop total and gets
 * cleared. Rows with a rating are left alone — their count sits next to the
 * stars and is trustworthy.
 *
 * @returns {number} how many counts were cleared
 */
export function resolveAmbiguousReviewCounts(records) {
  const groups = new Map();
  for (const row of records) {
    if (!row || row.rating !== null || row.reviewCount === null || row.reviewCount === undefined) continue;
    if (!row.shopName) continue;
    const key = `${row.shopName}::${row.reviewCount}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  let cleared = 0;
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    for (const row of rows) {
      row.reviewCount = null;
      cleared += 1;
    }
  }
  return cleared;
}

/**
 * Search-card fields that are inferred from markup rather than structured data.
 * If one is empty on every row, a selector has rotted — say so during the run.
 */
const WATCHED_ROW_FIELDS = [['rating', 'rating'], ['reviewCount', 'review count'],
  ['shopName', 'shop name'], ['price', 'price']];

function tallyRowGaps(ctx, rows) {
  for (const row of rows) {
    ctx.rowsSeen += 1;
    for (const [field, label] of WATCHED_ROW_FIELDS) {
      const v = row[field];
      if (v === null || v === undefined || v === '') {
        ctx.rowGaps[label] = (ctx.rowGaps[label] || 0) + 1;
      }
    }
  }
}

async function reportRowCoverage(ctx) {
  if (!ctx.rowsSeen) return;
  const total = ctx.rowsSeen;
  const empty = Object.entries(ctx.rowGaps).filter(([, n]) => n === total);
  if (!empty.length) return;
  await store.log('warn',
    `Search rows: ${empty.map(([l]) => l).join(', ')} empty on all ${total} row(s) — `
    + 'Etsy likely changed its card markup. Update SELECTORS in src/common/parse.js; '
    + 'the deep scrape reads these from the listing page instead.');
}

async function finishRun(ctx) {
  const aborted = ctx.signal.aborted;
  const state = await store.getState();
  const p = state.progress;
  await reportRowCoverage(ctx);
  if (ctx.settings.proxyConfiguration && ctx.settings.proxyConfiguration.enabled) {
    await proxy.clearProxyConfiguration();
    await store.log('info', 'Proxy settings restored to system default.');
  }
  // Always tidy up the scraping window, including on abort or error.
  if (!ctx.settings.keepTabsOpen) await closeScrapeSurface();
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
    const ambiguous = resolveAmbiguousReviewCounts(records);
    if (ambiguous) {
      await store.log('info',
        `${label}: cleared ${ambiguous} review count(s) repeated across one shop's `
        + 'listings — that is a shop total, not per-listing.');
    }
    tallyRowGaps(ctx, records);
    const { rows: filtered, adsSkipped, nonDigitalSkipped } = applyRowFilters(records, settings);
    const { kept, duplicates } = ctx.dedupe.filter(filtered, task.query);
    for (const row of kept) {
      if (row.listingId && !ctx.collected.has(row.listingId)) {
        ctx.collected.set(row.listingId, { url: row.url, query: row.query, page: row.page, position: row.position });
      }
    }
    const stored = await store.addRows(kept);
    await store.bumpProgress({
      pagesDone: 1, rows: stored, duplicates, adsSkipped, nonDigitalSkipped,
    });
    if (task.page >= settings.maxPagesPerQuery
      && ctx.scheduler.markDone(task.queueIndex, 'page limit')) {
      await store.bumpProgress({ queriesDone: 1 });
    }
    await store.log('success',
      `${label} -> ${stored} rows${duplicates ? ` (${duplicates} dupes)` : ''}`
      + `${adsSkipped ? ` (${adsSkipped} ads skipped)` : ''}`
      + `${nonDigitalSkipped ? ` (${nonDigitalSkipped} non-digital skipped)` : ''} via ${engine}`
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

  if (settings.useEhuntPanel) {
    // A hidden background tab reports visibilityState 'hidden', and EHunt (like
    // many panels) waits for the page to be visible before rendering. Move to a
    // separate unfocused window, whose active tab does count as visible.
    const upgraded = upgradeModeForVisibility(ctx.tabMode, true);
    if (upgraded) {
      ctx.tabMode = upgraded;
      await store.log('info',
        'EHunt needs a visible page, so listings open in a separate scraping window '
        + '(your window keeps focus). It closes when the run ends.');
    }
    if (settings.engine !== ENGINES.TAB) {
      await store.log('info', 'Deep scrape uses real tabs because the EHunt panel is enabled.');
    }
  }

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
  if (settings.useEhuntPanel) {
    if (ctx.ehuntHits) {
      await store.log('success',
        `EHunt panel read on ${ctx.ehuntHits}/${ctx.detailsCaptured} listing(s) — tags from EHunt.`);
    } else if (ctx.ehuntOnPage) {
      // EHunt is clearly running — its own markup is in the page — but the tag
      // list never filled in. Waiting longer is the fix, not reinstalling.
      await store.log('warn',
        `EHunt was on the page for ${ctx.ehuntOnPage}/${ctx.detailsCaptured} listing(s) but its `
        + 'tag table never finished rendering. The wait already extends itself while the panel '
        + `is visibly still loading, so past ${Math.round(settings.ehuntWaitMs / 1000)}s it had `
        + 'stopped making progress. Raise "EHunt wait", make sure its panel is expanded (it '
        + 'renders tags only when open), and check you are still signed in to EHunt.');
      await store.log('info',
        `Furthest EHunt got on any listing: ${describeEhuntStage(ctx.ehuntBestStage)}.`);
    } else {
      await store.log('warn',
        'EHunt was not detected on any listing page. Check that the EHunt - Etsy Rank Tool '
        + 'extension is installed and enabled, that it is not restricted to specific sites, '
        + 'and that it works when you open a listing manually. Note it cannot be read if it '
        + 'renders inside its own iframe. Tags fall back to the page-link proxy.');
    }
  }
  if (settings.etsyApiKey && !ctx.apiDisabled) {
    await store.log(ctx.apiHits ? 'success' : 'warn',
      `Etsy API enriched ${ctx.apiHits}/${ctx.detailsCaptured} listing(s)`
      + `${ctx.apiMisses ? `, ${ctx.apiMisses} lookup(s) failed` : ''}`);
  }
  await reportDetailCoverage(ctx.detailGaps, ctx.detailsCaptured, ctx.detailEscalated ? ENGINES.TAB : settings.engine);
  await reportTagCoverage(ctx);
}

/**
 * Plain English for how far EHunt's panel got, so "it didn't work" becomes a
 * specific stage the user can act on.
 */
function describeEhuntStage(stage) {
  switch (stage) {
    case 4: return 'tag table rendered';
    case 3: return 'stats table rendered but no tag row';
    case 2: return 'panel frame appeared but stayed empty';
    case 1: return 'EHunt is on the page but never drew its panel';
    default: return 'no trace of EHunt';
  }
}

/** Tally what each listing page offered the tag harvester. */
function noteTagSources(ctx, counts) {
  const info = counts && counts.tagSources;
  if (!info) return;
  ctx.tagPages += 1;
  if (info.marketLinks > 0 || info.searchChips > 0) ctx.tagPagesWithLinks += 1;
  if (info.moduleEmpty) ctx.tagPagesPlaceholder += 1;
  if (info.modulePresent) ctx.tagPagesWithModule += 1;
}

/**
 * Say which of the three tag routes was actually available, and what to do.
 *
 * "tags (25/25)" in the gap report is true but useless: it does not say whether
 * Etsy changed its markup, whether the module simply never loaded, or whether
 * the user was never on a route that can return tags in the first place. Each
 * cause has a different fix, so each is reported separately.
 */
async function reportTagCoverage(ctx) {
  const { settings } = ctx;
  const captured = ctx.detailsCaptured;
  if (!captured) return;

  const withTags = captured - (ctx.detailGaps.tags || 0);
  if (withTags === captured) return; // every listing has tags; nothing to explain

  await store.log('warn',
    `Tags missing on ${captured - withTags}/${captured} listing(s). Routes available this run:`);

  if (!settings.etsyApiKey) {
    await store.log('warn',
      '• Etsy API — no key set. This is the only route that returns a listing\'s real '
      + '13 tags. A free keystring from etsy.com/developers/your-apps pasted into '
      + '"Etsy API key" is enough; no OAuth and no app review.');
  } else if (ctx.apiDisabled) {
    await store.log('warn', '• Etsy API — key rejected by Etsy, so it was disabled for this run.');
  } else {
    await store.log('info', `• Etsy API — answered for ${ctx.apiHits}/${captured} listing(s).`);
  }

  if (!settings.useEhuntPanel) {
    await store.log('warn',
      '• EHunt panel — not enabled. Tick "Read tags from the EHunt panel" if you have '
      + 'the EHunt - Etsy Rank Tool extension installed.');
  } else if (!ctx.ehuntOnPage) {
    await store.log('warn',
      '• EHunt panel — not detected on any page, so it is not installed, not enabled, or '
      + 'not permitted to run there.');
  } else if (!ctx.ehuntTagHits) {
    await store.log('warn',
      `• EHunt panel — present on ${ctx.ehuntOnPage}/${captured} page(s) but its tag list `
      + 'stayed empty. Raise "EHunt wait" and leave its panel expanded.');
  }

  // The page-link route, and the distinction that matters most.
  if (ctx.tagPages && ctx.tagPagesPlaceholder === ctx.tagPages) {
    await store.log('warn',
      `• Page links — Etsy's tag section was still an unloaded placeholder on all `
      + `${ctx.tagPages} page(s), so there were no links to harvest. This is normal with `
      + 'the fetch engine: the module only loads once the page runs its JavaScript and '
      + 'is scrolled to. Switch Engine to "tab".');
  } else if (ctx.tagPages && !ctx.tagPagesWithLinks && !ctx.tagPagesWithModule) {
    await store.log('warn',
      '• Page links — no tag section and no /market/ links anywhere on the page, which '
      + 'means Etsy moved this markup: update SELECTORS.tagsModule / marketLinks in '
      + 'src/common/detail-parse.js.');
  } else if (ctx.tagPages && !ctx.tagPagesWithLinks) {
    await store.log('warn',
      `• Page links — the tag section rendered on ${ctx.tagPagesWithModule}/${ctx.tagPages} `
      + 'page(s) but contained no links, so nothing could be harvested from it.');
  }
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
      useEhuntPanel: settings.useEhuntPanel,
      scrapedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };

    // Reviews and favourites only exist in the rendered DOM, so a fetch without
    // an offscreen parser is upgraded to a tab automatically.
    // Reading the EHunt panel requires a rendered page, so the deep scrape has to
    // use a real tab regardless of the configured engine. Without this the
    // "Read the EHunt panel" option silently did nothing on the default engine,
    // because `fetch()` returns HTML that no other extension has touched.
    const useTab = settings.engine === ENGINES.TAB
      || settings.useEhuntPanel
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
        tabMode: ctx.tabMode,
        tuning: { ehuntTimeoutMs: settings.ehuntWaitMs },
      })
      : await fetchDetailViaFetch(url, {
        signal: ctx.signal,
        context,
        retryableStatus: RETRYABLE_STATUS,
      });

    if (outcome.aborted || ctx.signal.aborted) return;
    if (outcome.ehuntFound) ctx.ehuntHits += 1;
    if (outcome.ehuntOnPage) ctx.ehuntOnPage += 1;
    if (outcome.ehuntStage > ctx.ehuntBestStage) ctx.ehuntBestStage = outcome.ehuntStage;
    if (outcome.ehuntTagCount) ctx.ehuntTagHits += 1;
    noteTagSources(ctx, outcome.counts);

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

    // Digital-only: the listing page states this positively, so this is a much
    // stronger signal than the search card and worth re-checking here.
    if (settings.digitalOnly && outcome.record.isDigital === false) {
      await store.bumpProgress({ detailsDone: 1, nonDigitalSkipped: 1 });
      await store.log('info', `${label} skipped — physical product (digital-only is on).`);
      return;
    }

    // Optional API pass: the only source for the real 13 tags. Runs before the
    // snapshot so history records the authoritative favourite count.
    const withApi = await enrichFromApi(ctx, outcome.record, label);

    // Snapshot second, then attach the derived velocity metrics.
    const enriched = settings.trackHistory
      ? await history.recordAndSummarize(withApi)
      : await history.recordAndSummarize(withApi, { track: false });

    await store.upsertDetail(enriched);

    let reviewCount = 0;
    if (settings.scrapeReviews && outcome.reviews && outcome.reviews.length) {
      await store.dropReviewsFor(enriched.listingId);
      reviewCount = await store.addReviews(outcome.reviews.slice(0, settings.maxReviewsPerListing));
    }

    ctx.detailsCaptured += 1;
    for (const label of missingDetailFields(enriched)) {
      ctx.detailGaps[label] = (ctx.detailGaps[label] || 0) + 1;
    }

    await store.bumpProgress({ detailsDone: 1, reviews: reviewCount });
    await store.log('success',
      `${label} -> ${describeDetail(enriched)}${reviewCount ? `, ${reviewCount} review(s)` : ''}`);
    return;
  }

  await store.bumpProgress({ detailsDone: 1, detailsFailed: 1 });
  await store.log('error', `${label} gave up — ${lastError}`);
}

/**
 * Ask the Etsy API for the same listing and merge what it returns.
 *
 * Silent no-op without a configured key. A key that Etsy rejects (401/403)
 * disables the API for the rest of the run after one warning, rather than
 * repeating a doomed request for every listing.
 */
async function enrichFromApi(ctx, record, label) {
  const { settings } = ctx;
  if (!settings.etsyApiKey || ctx.apiDisabled || !record || !record.listingId) {
    return mergeApiRecord(record, null);
  }

  // Keep comfortably inside Etsy's published rate limit.
  const since = Date.now() - ctx.lastApiCallAt;
  if (since < API_RATE.minIntervalMs) await sleep(API_RATE.minIntervalMs - since);
  ctx.lastApiCallAt = Date.now();

  const res = await fetchListingFromApi(record.listingId, settings.etsyApiKey, {
    signal: ctx.signal,
  });

  if (res.ok) {
    ctx.apiHits += 1;
    return mergeApiRecord(record, res.record);
  }

  if (res.fatal) {
    ctx.apiDisabled = true;
    await store.log('error',
      `Etsy API disabled for this run — ${res.error}. Check the keystring at `
      + 'etsy.com/developers/your-apps; the scrape continues without it '
      + '(tags fall back to the page-link proxy).');
  } else {
    ctx.apiMisses += 1;
    await store.log('warn', `${label}: API lookup failed (${res.error}); using scraped values.`);
  }
  return mergeApiRecord(record, null);
}

/** Compact log summary: the signals worth eyeballing while a run happens. */
function describeDetail(d) {
  const bits = [];
  if (d.favoritesCount !== null && d.favoritesCount !== undefined) bits.push(`${d.favoritesCount} favs`);
  if (d.favoritesPerDay !== null && d.favoritesPerDay !== undefined) bits.push(`${d.favoritesPerDay}/day`);
  if (d.cartCount) bits.push(`${d.cartCount} in cart`);
  if (d.quantityAvailable !== null && d.quantityAvailable !== undefined) bits.push(`qty ${d.quantityAvailable}`);
  if (d.description) bits.push(`${d.description.length} chars desc`);
  if (d.tags && d.tags.length) {
    const source = d.tagSource === 'api' ? ' (API)' : (d.tagSource === 'ehunt' ? ' (EHunt)' : '');
    bits.push(`${d.tags.length} tags${source}`);
  }
  if (d.isDigital === true) bits.push('digital');
  if (d.ehuntEstimatedSales !== null && d.ehuntEstimatedSales !== undefined) {
    bits.push(`~${d.ehuntEstimatedSales} sales (EHunt)`);
  }
  if (d.opportunityScore !== null && d.opportunityScore !== undefined) bits.push(`opp ${d.opportunityScore}`);
  const missing = missingDetailFields(d);
  if (missing.length) bits.push(`no ${missing.join('/')}`);
  return bits.length ? bits.join(', ') : 'detail captured';
}

/**
 * The deep-scrape fields users actually ask about. When a selector rots, these
 * come back null and the run still "succeeds" — so they are named in the log and
 * summarised at the end of the phase rather than being discovered in the export.
 */
const KEY_DETAIL_FIELDS = [
  ['description', 'description'],
  ['favoritesCount', 'favourites'],
  ['shopTotalSales', 'shop sales'],
  ['tags', 'tags'],
  ['quantityAvailable', 'stock'],
];

function missingDetailFields(detail) {
  const missing = [];
  for (const [field, label] of KEY_DETAIL_FIELDS) {
    const value = detail ? detail[field] : null;
    const empty = value === null || value === undefined || value === ''
      || (Array.isArray(value) && value.length === 0);
    if (empty) missing.push(label);
  }
  return missing;
}

/** Warn once per run, with the reason and where to fix it. */
async function reportDetailCoverage(tally, captured, engineUsed) {
  if (!captured) return;
  const gaps = Object.entries(tally).filter(([, count]) => count > 0);
  if (!gaps.length) return;

  const worst = gaps.sort((a, b) => b[1] - a[1]);
  const summary = worst.map(([label, count]) => `${label} (${count}/${captured})`).join(', ');
  const allMissing = worst.some(([, count]) => count === captured);

  await store.log('warn', `Deep scrape gaps — empty for: ${summary}`);
  if (allMissing && engineUsed === ENGINES.FETCH) {
    await store.log('warn',
      'A field empty on every listing usually means the page was not fully rendered: '
      + 'try the tab engine, which runs the listing page\'s JavaScript.');
  } else if (allMissing) {
    await store.log('warn',
      'A field empty on every listing usually means Etsy renamed its markup: update the '
      + 'SELECTORS table at the top of src/common/detail-parse.js (JSON-LD fields keep working meanwhile).');
  }
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
    tabMode: ctx.tabMode,
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

export const __testing = {
  Scheduler, Dedupe, applyRowFilters, missingDetailFields, describeDetail,
  tallyRowGaps, WATCHED_ROW_FIELDS, resolveAmbiguousReviewCounts, LIMITS,
  noteTagSources,
};
