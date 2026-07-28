/**
 * UI controller for both the popup and the tab dashboard (same document; the
 * `?view=tab` query switches to the wide layout).
 */

import { MSG, RUN_STATUS, DEFAULTS, DATASETS } from '../common/constants.js';
import { exportDataset, pickFields, DATASET_FIELDS, joinEverything } from './export.js';

const PREVIEW_LIMIT = 200;

const el = (id) => document.getElementById(id);

const FIELD_BINDINGS = [
  ['queries', 'queries', 'lines'],
  ['maxPagesPerQuery', 'maxPagesPerQuery', 'int'],
  ['maxConcurrency', 'maxConcurrency', 'int'],
  ['maxRequestRetries', 'maxRequestRetries', 'int'],
  ['minDelayMs', 'minDelayMs', 'int'],
  ['maxDelayMs', 'maxDelayMs', 'int'],
  ['minPrice', 'minPrice', 'numOrNull'],
  ['maxPrice', 'maxPrice', 'numOrNull'],
  ['shipTo', 'shipTo', 'text'],
  ['sortOrder', 'sortOrder', 'text'],
  ['engine', 'engine', 'text'],
  ['dedupe', 'dedupe', 'text'],
  ['positionMode', 'positionMode', 'text'],
  ['bestsellerOnly', 'bestsellerOnly', 'bool'],
  ['excludeSponsored', 'excludeSponsored', 'bool'],
  ['digitalOnly', 'digitalOnly', 'bool'],
  ['useEhuntPanel', 'useEhuntPanel', 'bool'],
  ['freeShippingOnly', 'freeShippingOnly', 'bool'],
  ['scrapeDetails', 'scrapeDetails', 'bool'],
  ['maxDetailListings', 'maxDetailListings', 'int'],
  ['detailConcurrency', 'detailConcurrency', 'int'],
  ['maxReviewsPerListing', 'maxReviewsPerListing', 'int'],
  ['scrapeReviews', 'scrapeReviews', 'bool'],
  ['trackHistory', 'trackHistory', 'bool'],
  ['etsyApiKey', 'etsyApiKey', 'text'],
  ['stopOnEmptyPage', 'stopOnEmptyPage', 'bool'],
  ['manualCaptchaSolve', 'manualCaptchaSolve', 'bool'],
  ['keepTabsOpen', 'keepTabsOpen', 'bool'],
  ['tabMode', 'tabMode', 'text'],
  ['ehuntWaitMs', 'ehuntWaitMs', 'int'],
];

/** Preview table shape per dataset: [header, className, accessor]. */
const PREVIEW_COLUMNS = {
  [DATASETS.search]: [
    ['#', 'num', (r) => r.position],
    ['Query', '', (r) => r.query],
    ['P', 'num', (r) => r.page],
    ['Title', 'link', (r) => r],
    ['Price', 'num', (r) => formatPrice(r)],
    ['Shop', '', (r) => r.shopName],
    ['Rating', 'num', (r) => r.rating],
    ['Reviews', 'num', (r) => fmtOrDash(r.reviewCount)],
    ['Flags', 'flags', (r) => r],
  ],
  [DATASETS.details]: [
    ['Listing', 'link', (r) => r],
    ['Price', 'num', (r) => formatPrice(r)],
    ['Favs', 'num', (r) => fmtOrDash(r.favoritesCount)],
    ['Favs/day', 'num', (r) => fmtOrDash(r.favoritesPerDay)],
    ['Δ favs', 'num', (r) => fmtDelta(r.favoritesDelta)],
    ['Cart', 'num', (r) => fmtOrDash(r.cartCount)],
    ['Qty', 'num', (r) => fmtOrDash(r.quantityAvailable)],
    ['Reviews', 'num', (r) => fmtOrDash(r.reviewCount)],
    ['Shop sales', 'num', (r) => fmtOrDash(r.shopTotalSales)],
    // Etsy shows a start year on some listings and a tenure on others, so show
    // whichever the page actually gave us ("2019" or "11mo").
    ['Shop age', 'num', (r) => (r.shopMemberSince != null
      ? String(r.shopMemberSince)
      : (r.shopAgeMonths != null ? `${r.shopAgeMonths}mo` : '—'))],
    ['Flags', 'flags', (r) => r],
    ['Gap', 'num', (r) => fmtOrDash(r.competitiveGapScore)],
    ['Opp', 'num', (r) => fmtOrDash(r.opportunityScore)],
    // The tags themselves, not how many there are. This column used to read
    // "13~", which is the least useful thing it could say about the field people
    // open this tool for.
    ['Tags', 'tags', (r) => r],
    ['Tracked', 'num', (r) => (r.snapshotCount ? `${r.snapshotCount}x` : '—')],
  ],
  [DATASETS.reviews]: [
    ['Listing', 'num', (r) => r.listingId],
    ['Rating', 'num', (r) => fmtOrDash(r.rating)],
    ['Date', '', (r) => r.date],
    ['Reviewer', '', (r) => r.reviewer],
    ['Comment', '', (r) => r.comment],
    ['Photos', 'num', (r) => fmtOrDash(r.photoCount)],
  ],
  // The joined view: grid context, then the fields the listing page added.
  [DATASETS.combined]: [
    ['#', 'num', (r) => r.position],
    ['Query', '', (r) => r.query],
    ['Title', 'link', (r) => r],
    ['Price', 'num', (r) => formatPrice(r)],
    ['Deep', 'num', (r) => (r.deepScraped ? 'yes' : '—')],
    ['Tags', 'tags', (r) => r],
    ['Favs', 'num', (r) => fmtOrDash(r.favoritesCount)],
    ['Reviews', 'num', (r) => fmtOrDash(r.reviewCount)],
    ['Shop sales', 'num', (r) => fmtOrDash(r.shopTotalSales)],
    ['Opp', 'num', (r) => fmtOrDash(r.opportunityScore)],
  ],
  [DATASETS.history]: [
    ['Listing', 'num', (r) => r.listingId],
    ['Observed', '', (r) => r.observedAt],
    ['Favourites', 'num', (r) => fmtOrDash(r.favorites)],
    ['Reviews', 'num', (r) => fmtOrDash(r.reviewCount)],
    ['Price', 'num', (r) => fmtOrDash(r.price)],
    ['Stock', 'num', (r) => fmtOrDash(r.quantity)],
  ],
  [DATASETS.log]: [
    ['At', '', (r) => r.at],
    ['Level', '', (r) => r.level],
    ['Message', '', (r) => r.message],
  ],
};

let rowTotal = -1;
let currentDataset = DATASETS.search;
/** Once the user picks a dataset, stop switching it for them. */
let datasetChosenByUser = false;

// --------------------------------------------------------------- messaging

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response) throw new Error('No response from background worker');
  if (!response.ok) throw new Error(response.error || 'Request failed');
  return response.result;
}

// ------------------------------------------------------------ form <-> state

function readForm() {
  const settings = {};
  for (const [id, key, kind] of FIELD_BINDINGS) {
    const node = el(id);
    if (!node) continue;
    switch (kind) {
      case 'lines':
        settings[key] = node.value.split('\n').map((s) => s.trim()).filter(Boolean);
        break;
      case 'int': {
        const n = Number.parseInt(node.value, 10);
        settings[key] = Number.isFinite(n) ? n : DEFAULTS[key];
        break;
      }
      case 'numOrNull':
        settings[key] = node.value === '' ? null : Number(node.value);
        break;
      case 'bool':
        settings[key] = node.checked;
        break;
      default:
        settings[key] = node.value;
    }
  }
  settings.proxyConfiguration = {
    enabled: el('proxyEnabled').checked,
    proxies: el('proxyList').value.split('\n').map((s) => s.trim()).filter(Boolean),
    rotateEveryRequests: Number.parseInt(el('proxyRotate').value, 10) || DEFAULTS.proxyConfiguration.rotateEveryRequests,
  };
  return settings;
}

function writeForm(settings) {
  for (const [id, key, kind] of FIELD_BINDINGS) {
    const node = el(id);
    if (!node) continue;
    const value = settings[key];
    if (kind === 'bool') node.checked = Boolean(value);
    else if (kind === 'lines') node.value = (value || []).join('\n');
    else node.value = value === null || value === undefined ? '' : value;
  }
  const proxy = settings.proxyConfiguration || DEFAULTS.proxyConfiguration;
  el('proxyEnabled').checked = Boolean(proxy.enabled);
  el('proxyList').value = (proxy.proxies || []).join('\n');
  el('proxyRotate').value = proxy.rotateEveryRequests;
  if (settings.scrapeDetails) el('deep').open = true;
  updateQueriesHint();
}

function updateQueriesHint() {
  const count = el('queries').value.split('\n').filter((s) => s.trim()).length;
  const pages = Number.parseInt(el('maxPagesPerQuery').value, 10) || 0;
  const searchRequests = count * pages;
  const detailRequests = el('scrapeDetails').checked
    ? Math.min(Number.parseInt(el('maxDetailListings').value, 10) || 0, 500)
    : 0;
  el('queriesHint').textContent = count
    ? `${count} quer${count === 1 ? 'y' : 'ies'} -> up to ${searchRequests} search page(s)`
      + `${detailRequests ? ` + up to ${detailRequests} listing page(s)` : ''}`
    : '0 queries';
}

async function persistForm() {
  try {
    await send(MSG.SAVE_SETTINGS, { settings: readForm() });
  } catch (err) {
    console.warn('settings not saved', err);
  }
}

// -------------------------------------------------------------- rendering

function renderState(state, counts, running) {
  const status = state.status || RUN_STATUS.IDLE;
  const pill = el('statusPill');
  pill.textContent = state.phase === 'details' && running ? 'deep scrape' : status;
  pill.className = `pill pill-${status}`;

  const p = state.progress || {};
  const planned = (p.pagesPlanned || 0) + (p.detailsPlanned || 0);
  const done = (p.pagesDone || 0) + (p.detailsDone || 0);
  const pct = planned ? Math.min(100, Math.round((done / planned) * 100)) : (running ? 5 : 0);
  el('progressBar').style.width = `${pct}%`;

  el('statRows').textContent = fmt(p.rows || 0);
  el('statPages').textContent = `${fmt(p.pagesDone || 0)} / ${fmt(p.pagesPlanned || 0)}`;
  el('statQueries').textContent = `${fmt(p.queriesDone || 0)} / ${fmt(p.queriesTotal || 0)}`;
  el('statDupes').textContent = fmt(p.duplicates || 0);
  el('statAds').textContent = fmt(p.adsSkipped || 0);
  el('statNonDigital').textContent = fmt(p.nonDigitalSkipped || 0);
  el('statRetries').textContent = fmt(p.retries || 0);
  el('statBlocks').textContent = fmt(p.blocks || 0);
  el('statDetails').textContent = `${fmt(p.detailsDone || 0)} / ${fmt(p.detailsPlanned || 0)}`;
  el('statReviews').textContent = fmt((counts && counts.reviewCount) || p.reviews || 0);
  el('statTracked').textContent = fmt((counts && counts.history && counts.history.listings) || 0);
  el('statusMessage').textContent = state.message || (running ? 'Working…' : 'Ready.');

  const active = state.active || [];
  const activeNode = el('activeList');
  activeNode.hidden = active.length === 0;
  activeNode.textContent = active.length ? `In flight: ${active.join(', ')}` : '';

  el('start').disabled = running;
  el('stop').disabled = !running;
  el('scrapeTab').disabled = running;

  renderLog(state.log || []);
  renderCountPill(counts);
}

function renderCountPill(counts) {
  if (!counts) return;
  const parts = [`${fmt(counts.rowCount || 0)} rows`];
  if (counts.detailCount) parts.push(`${fmt(counts.detailCount)} details`);
  if (counts.reviewCount) parts.push(`${fmt(counts.reviewCount)} reviews`);
  el('rowCount').textContent = parts.join(' · ');
}

function renderLog(entries) {
  const list = el('log');
  if (!entries.length) {
    list.innerHTML = '<li class="empty">No activity yet.</li>';
    return;
  }
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  const frag = document.createDocumentFragment();
  for (const entry of entries.slice(-120)) {
    const li = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = new Date(entry.t).toLocaleTimeString([], { hour12: false });
    const span = document.createElement('span');
    span.className = `lvl-${entry.level}`;
    span.textContent = entry.message;
    li.append(time, span);
    frag.append(li);
  }
  list.replaceChildren(frag);
  if (nearBottom) list.scrollTop = list.scrollHeight;
}

function renderPreview(rows, total, dataset) {
  const columns = PREVIEW_COLUMNS[dataset] || PREVIEW_COLUMNS[DATASETS.search];

  const headRow = document.createElement('tr');
  for (const [header] of columns) {
    const th = document.createElement('th');
    th.textContent = header;
    headRow.append(th);
  }
  el('previewHead').replaceChildren(headRow);

  const body = el('previewBody');
  if (!rows.length) {
    body.innerHTML = `<tr class="empty"><td colspan="${columns.length}">No rows yet.</td></tr>`;
    el('previewHint').textContent = dataset === DATASETS.details
      ? 'Empty because "Deep listing intelligence" was off for this run — tick it and run again '
        + 'to collect tags, description and favourites.'
      : (dataset === DATASETS.search
        ? 'Tags, description and favourites are in the "Listing details" dataset, not this one.'
        : '');
    return;
  }

  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const [, className, accessor] of columns) {
      const value = accessor(row);
      if (className === 'link') tr.append(titleCell(value));
      else if (className === 'flags') tr.append(flagsCell(value));
      else if (className === 'tags') tr.append(tagsCell(value));
      else tr.append(td(value, className));
    }
    frag.append(tr);
  }
  body.replaceChildren(frag);
  const shown = total > rows.length
    ? `Showing first ${rows.length} of ${fmt(total)} rows — export for the full dataset.`
    : `Showing all ${fmt(total)} rows.`;
  // Say it on the screen where the field is missing, not only in the run log.
  el('previewHint').textContent = dataset === DATASETS.search
    ? `${shown} This is the search grid; tags, description and favourites are in `
      + '"Listing details".'
    : shown;
}

/**
 * The listing's actual tags, one chip each.
 *
 * Every tag is rendered rather than a count, because the tags *are* the point of
 * the deep scrape — a cell reading "13~" tells you nothing you wanted to know.
 * The search volume EHunt reports rides along in each chip's tooltip, and the
 * cell's own tooltip holds the full list as one comma-separated line so it can be
 * read or copied without exporting.
 *
 * `tagSource` is shown as a short marker rather than being hidden, because
 * "these are the literal 13 from Etsy's API" and "these are links that resemble
 * the tags" deserve different levels of trust.
 */
const TAG_SOURCE_LABEL = {
  api: { mark: 'API', hint: "Etsy's own API — the literal tags on this listing" },
  ehunt: { mark: 'EHunt', hint: 'Read from the EHunt panel — the real tags, via a third party' },
  'page-links': { mark: '~', hint: 'Harvested from page links — a close proxy, not the literal tags' },
};

function tagsCell(row) {
  const cell = document.createElement('td');
  cell.className = 'tags';
  const tags = Array.isArray(row && row.tags) ? row.tags : [];
  if (!tags.length) {
    cell.textContent = '—';
    return cell;
  }

  const volumes = (row && row.tagVolumes) || {};
  cell.title = tags.join(', ');

  for (const tag of tags) {
    const chip = document.createElement('span');
    chip.className = 'tag';
    chip.textContent = tag;
    const volume = volumes[tag];
    if (typeof volume === 'number') chip.title = `${tag} — ${fmt(volume)} competing listings`;
    cell.append(chip);
  }

  const source = TAG_SOURCE_LABEL[row.tagSource];
  if (source) {
    const mark = document.createElement('span');
    mark.className = 'tag-source';
    mark.textContent = source.mark;
    mark.title = source.hint;
    cell.append(mark);
  }
  return cell;
}

function td(value, className) {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  const empty = value === null || value === undefined || value === '';
  cell.textContent = empty ? '—' : String(value);
  if (!empty && String(value).length > 40) cell.title = String(value);
  return cell;
}

function titleCell(row) {
  const cell = document.createElement('td');
  cell.title = row.title || '';
  if (row.url) {
    const a = document.createElement('a');
    a.href = row.url;
    a.target = '_blank';
    a.rel = 'noreferrer noopener';
    a.textContent = row.title || row.listingId || 'listing';
    cell.append(a);
  } else {
    cell.textContent = row.title || '—';
  }
  return cell;
}

function flagsCell(row) {
  const cell = document.createElement('td');
  const flags = [
    row.sponsored && ['ad', 'Ad'],
    row.freeShipping && ['free', 'Free ship'],
    row.bestseller && ['best', 'Best'],
    row.isStarSeller && ['best', 'Star'],
    row.isPersonalizable && ['', 'Custom'],
  ].filter(Boolean);
  if (!flags.length) {
    cell.textContent = '—';
    return cell;
  }
  for (const [cls, label] of flags) {
    const span = document.createElement('span');
    span.className = `badge ${cls}`;
    span.textContent = label;
    cell.append(span);
  }
  return cell;
}

function formatPrice(row) {
  if (row.price === null || row.price === undefined) return '—';
  return `${Number(row.price).toFixed(2)} ${row.currency || ''}`.trim();
}

function fmt(n) {
  return Number(n || 0).toLocaleString();
}

function fmtOrDash(v) {
  return v === null || v === undefined || v === '' ? '—' : fmt(v);
}

function fmtDelta(v) {
  if (v === null || v === undefined) return '—';
  return v > 0 ? `+${fmt(v)}` : fmt(v);
}

let toastTimer = null;
function toast(message, isError = false) {
  const node = el('toast');
  node.textContent = message;
  node.className = `toast${isError ? ' error' : ''}`;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 5000);
}

// ------------------------------------------------------------------ actions

const MSG_FOR_DATASET = {
  [DATASETS.search]: MSG.GET_RESULTS,
  [DATASETS.details]: MSG.GET_DETAILS,
  [DATASETS.reviews]: MSG.GET_REVIEWS,
  [DATASETS.history]: MSG.GET_HISTORY_ROWS,
};

/** The run log lives on the run state rather than in a results store. */
async function fetchLogRows(limit) {
  const state = await send(MSG.GET_STATE);
  const entries = (state && state.state && state.state.log) || [];
  const rows = entries.map((e) => ({
    at: new Date(e.t).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    level: e.level,
    message: e.message,
    detail: e.extra === undefined ? null : e.extra,
  }));
  return { total: rows.length, rows: limit > 0 ? rows.slice(-limit) : rows };
}

/** The joined view is derived here rather than stored. */
async function fetchCombinedRows(limit) {
  const [search, details] = await Promise.all([
    fetchDataset(DATASETS.search),
    fetchDataset(DATASETS.details),
  ]);
  const rows = joinEverything(search.rows, details.rows);
  return { total: rows.length, rows: limit > 0 ? rows.slice(0, limit) : rows };
}

async function fetchDataset(dataset, limit) {
  if (dataset === DATASETS.combined) return fetchCombinedRows(limit);
  if (dataset === DATASETS.log) return fetchLogRows(limit);
  const type = MSG_FOR_DATASET[dataset];
  if (!type) return { rows: [], total: 0 };
  return send(type, limit ? { limit } : {});
}

async function refresh({ withRows = true } = {}) {
  const state = await send(MSG.GET_STATE);
  renderState(state.state, state, state.running);
  if (withRows) await refreshPreview();
}

/**
 * Land on the richer dataset once a run has produced one.
 *
 * The picker defaults to the search grid, which has no tags, description or
 * favourites in its schema at all — so someone who ran a deep scrape and then
 * exported what was on screen got a file that could not contain the fields they
 * ran the deep scrape *for*, with nothing to indicate why. Only done once, and
 * only if the user has not chosen a dataset themselves.
 */
async function preferDetailsDataset() {
  if (datasetChosenByUser || currentDataset !== DATASETS.search) return;
  const { total } = await fetchDataset(DATASETS.details, 1);
  if (!total) return;
  currentDataset = DATASETS.details;
  el('dataset').value = DATASETS.details;
}

async function refreshPreview() {
  await preferDetailsDataset();
  const dataset = currentDataset === DATASETS.all ? DATASETS.search : currentDataset;
  const { rows, total } = await fetchDataset(dataset, PREVIEW_LIMIT);
  rowTotal = total;
  renderPreview(rows, total, dataset);
}

/**
 * Everything a run produced: the three result tables, the snapshot series behind
 * the velocity numbers, the run log, and a summary of the run itself.
 *
 * The last three were being recorded and then left unreachable, so "All
 * datasets" was not in fact all of them.
 */
async function collectAll() {
  const [search, details, reviews, historyRows, logRows, state] = await Promise.all([
    fetchDataset(DATASETS.search),
    fetchDataset(DATASETS.details),
    fetchDataset(DATASETS.reviews),
    fetchDataset(DATASETS.history),
    fetchDataset(DATASETS.log),
    send(MSG.GET_STATE),
  ]);
  return {
    [DATASETS.search]: search.rows,
    [DATASETS.details]: details.rows,
    [DATASETS.reviews]: reviews.rows,
    [DATASETS.history]: historyRows.rows,
    [DATASETS.log]: logRows.rows,
    run: runSummary(state),
  };
}

/**
 * What the run did, for the JSON export. Deliberately not the settings object:
 * that holds the Etsy API key, which must never reach an exported file.
 */
function runSummary(state) {
  const s = (state && state.state) || {};
  return {
    status: s.status || null,
    startedAt: s.startedAt ? new Date(s.startedAt).toISOString() : null,
    finishedAt: s.finishedAt ? new Date(s.finishedAt).toISOString() : null,
    queries: Array.isArray(s.queries) ? s.queries : null,
    counts: s.counts || null,
    error: s.error || null,
  };
}

async function onStart() {
  const settings = readForm();
  if (!settings.queries.length) {
    toast('Add at least one search keyword', true);
    el('queries').focus();
    return;
  }
  // api.etsy.com is an optional host permission, requested only once a key is set.
  if (settings.etsyApiKey && settings.scrapeDetails) {
    const grantedApi = await chrome.permissions.request({ origins: ['https://api.etsy.com/*'] });
    if (!grantedApi) {
      toast('Access to api.etsy.com denied — tags will use the page-link proxy', true);
      settings.etsyApiKey = '';
    }
  }
  if (settings.proxyConfiguration.enabled) {
    const granted = await chrome.permissions.request({
      permissions: ['proxy', 'webRequest', 'webRequestAuthProvider'],
    });
    if (!granted) {
      toast('Proxy permission denied — running without proxies', true);
      settings.proxyConfiguration.enabled = false;
      el('proxyEnabled').checked = false;
    }
  }
  try {
    el('start').disabled = true;
    await send(MSG.START_RUN, { settings });
    toast(settings.scrapeDetails ? 'Run started (search, then deep scrape)' : 'Run started');
    await refresh();
  } catch (err) {
    el('start').disabled = false;
    toast(String(err.message || err), true);
  }
}

async function onStop() {
  try {
    await send(MSG.STOP_RUN);
    toast('Stopping…');
  } catch (err) {
    toast(String(err.message || err), true);
  }
}

async function onScrapeTab() {
  try {
    el('scrapeTab').disabled = true;
    const res = await send(MSG.SCRAPE_ACTIVE_TAB);
    toast(`Added ${res.rows} row(s) from the current tab`);
    await refresh();
  } catch (err) {
    toast(String(err.message || err), true);
  } finally {
    el('scrapeTab').disabled = false;
  }
}

async function onExport(format) {
  try {
    const data = await collectAll();
    const name = await exportDataset(currentDataset, format, data, {
      includeDebug: el('includeDebug').checked,
    });
    // Exporting the grid while richer rows are sitting right there is almost
    // always a mistake, and the resulting file gives no clue that it is one.
    if (currentDataset === DATASETS.search && data[DATASETS.details].length) {
      toast(`Saved ${name} — note this is the search grid; `
        + `${data[DATASETS.details].length} listing detail row(s) with tags and description `
        + 'are under the "Listing details" dataset.');
      return;
    }
    toast(`Saved ${name}`);
  } catch (err) {
    toast(String(err.message || err), true);
  }
}

async function onCopyJson() {
  try {
    const includeDebug = el('includeDebug').checked;

    // "All datasets" used to silently fall back to the search rows here, so
    // Copy JSON handed over one of the three tables while the picker said all
    // three — the same shape of failure as exporting the grid and wondering
    // where the tags went. JSON can hold all three, so it now does.
    if (currentDataset === DATASETS.all) {
      const data = await collectAll();
      const payload = {
        search: pickFields(data.search, { fields: DATASET_FIELDS[DATASETS.search], includeDebug }).rows,
        details: pickFields(data.details, { fields: DATASET_FIELDS[DATASETS.details], includeDebug }).rows,
        reviews: pickFields(data.reviews, { fields: DATASET_FIELDS[DATASETS.reviews], includeDebug }).rows,
      };
      const totals = Object.values(payload).reduce((n, arr) => n + arr.length, 0);
      if (!totals) {
        toast('Nothing to copy yet', true);
        return;
      }
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      toast(`Copied all datasets — ${payload.search.length} search, `
        + `${payload.details.length} details, ${payload.reviews.length} reviews`);
      return;
    }

    const dataset = currentDataset;
    const { rows } = await fetchDataset(dataset);
    if (!rows.length) {
      toast('Nothing to copy yet', true);
      return;
    }
    const { rows: shaped } = pickFields(rows, {
      fields: DATASET_FIELDS[dataset],
      includeDebug,
    });
    await navigator.clipboard.writeText(JSON.stringify(shaped, null, 2));
    if (dataset === DATASETS.search) {
      const { total: detailTotal } = await fetchDataset(DATASETS.details, 1);
      if (detailTotal) {
        toast(`Copied ${rows.length} search row(s) — tags and description are in the `
          + '"Listing details" dataset, not this one.');
        return;
      }
    }
    toast(`Copied ${rows.length} row(s) as JSON`);
  } catch (err) {
    toast(String(err.message || err), true);
  }
}

async function onClear() {
  try {
    await send(MSG.CLEAR_RESULTS);
    toast('Results cleared (snapshot history kept for velocity)');
    await refresh();
  } catch (err) {
    toast(String(err.message || err), true);
  }
}

// -------------------------------------------------------------------- wiring

function wire() {
  if (new URLSearchParams(location.search).get('view') === 'tab') {
    document.body.classList.add('view-tab');
    el('openTab').hidden = true;
    el('advanced').open = true;
  }

  el('openTab').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/app.html?view=tab') });
    window.close();
  });

  el('start').addEventListener('click', onStart);
  el('stop').addEventListener('click', onStop);
  el('scrapeTab').addEventListener('click', onScrapeTab);
  el('clear').addEventListener('click', onClear);
  el('copyJson').addEventListener('click', onCopyJson);
  for (const btn of document.querySelectorAll('[data-export]')) {
    btn.addEventListener('click', () => onExport(btn.dataset.export));
  }

  el('dataset').addEventListener('change', async () => {
    currentDataset = el('dataset').value;
    datasetChosenByUser = true;
    rowTotal = -1;
    await refreshPreview();
  });

  for (const id of ['queries', 'maxPagesPerQuery', 'maxDetailListings', 'scrapeDetails']) {
    el(id).addEventListener('input', updateQueriesHint);
    el(id).addEventListener('change', updateQueriesHint);
  }

  // Persist settings as the user edits, so the popup reopens where it left off.
  for (const [id] of FIELD_BINDINGS) {
    const node = el(id);
    if (node) node.addEventListener('change', persistForm);
  }
  el('proxyEnabled').addEventListener('change', persistForm);
  el('proxyList').addEventListener('change', persistForm);
  el('proxyRotate').addEventListener('change', persistForm);

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== MSG.STATE_CHANGED) return;
    const running = message.state.status === RUN_STATUS.RUNNING
      || message.state.status === RUN_STATUS.STOPPING;
    renderState(message.state, message, running);
    schedulePreviewRefresh(message);
  });
}

let previewTimer = null;
function schedulePreviewRefresh(message) {
  const relevant = currentDataset === DATASETS.details ? message.detailCount
    : currentDataset === DATASETS.reviews ? message.reviewCount
      : message.rowCount;
  if (relevant === rowTotal) return;
  if (previewTimer) return;
  previewTimer = setTimeout(async () => {
    previewTimer = null;
    try {
      await refreshPreview();
    } catch (_) { /* worker busy */ }
  }, 1200);
}

async function init() {
  wire();
  try {
    const settings = await send(MSG.GET_SETTINGS);
    writeForm(settings);
  } catch (err) {
    toast(`Could not load settings: ${err.message || err}`, true);
  }
  await refresh();
}

document.addEventListener('DOMContentLoaded', init);

/**
 * Cell builders reachable from the test harness, the same way runner.js exposes
 * `__testing`. Rendering is otherwise only observable through a populated table,
 * which a fixture run cannot produce.
 */
globalThis.__uiTesting = { tagsCell, flagsCell, td };
