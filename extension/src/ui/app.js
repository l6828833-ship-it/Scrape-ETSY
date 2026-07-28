/**
 * UI controller for both the popup and the tab dashboard (same document; the
 * `?view=tab` query switches to the wide layout).
 */

import { MSG, RUN_STATUS, DEFAULTS, DATASETS } from '../common/constants.js';
import { exportDataset, pickFields, DATASET_FIELDS } from './export.js';

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
    ['Since', 'num', (r) => fmtOrDash(r.shopMemberSince)],
    ['Flags', 'flags', (r) => r],
    ['Gap', 'num', (r) => fmtOrDash(r.competitiveGapScore)],
    ['Opp', 'num', (r) => fmtOrDash(r.opportunityScore)],
    ['Tags', 'num', (r) => (r.tags && r.tags.length
      ? `${r.tags.length}${r.tagSource === 'api' ? ' API' : '~'}` : '—')],
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
};

let rowTotal = -1;
let currentDataset = DATASETS.search;

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
      ? 'Enable "Deep listing intelligence" before starting a run to populate this.'
      : '';
    return;
  }

  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const [, className, accessor] of columns) {
      const value = accessor(row);
      if (className === 'link') tr.append(titleCell(value));
      else if (className === 'flags') tr.append(flagsCell(value));
      else tr.append(td(value, className));
    }
    frag.append(tr);
  }
  body.replaceChildren(frag);
  el('previewHint').textContent = total > rows.length
    ? `Showing first ${rows.length} of ${fmt(total)} rows — export for the full dataset.`
    : `Showing all ${fmt(total)} rows.`;
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
};

async function fetchDataset(dataset, limit) {
  const type = MSG_FOR_DATASET[dataset];
  if (!type) return { rows: [], total: 0 };
  return send(type, limit ? { limit } : {});
}

async function refresh({ withRows = true } = {}) {
  const state = await send(MSG.GET_STATE);
  renderState(state.state, state, state.running);
  if (withRows) await refreshPreview();
}

async function refreshPreview() {
  const dataset = currentDataset === DATASETS.all ? DATASETS.search : currentDataset;
  const { rows, total } = await fetchDataset(dataset, PREVIEW_LIMIT);
  rowTotal = total;
  renderPreview(rows, total, dataset);
}

async function collectAll() {
  const [search, details, reviews] = await Promise.all([
    fetchDataset(DATASETS.search),
    fetchDataset(DATASETS.details),
    fetchDataset(DATASETS.reviews),
  ]);
  return {
    [DATASETS.search]: search.rows,
    [DATASETS.details]: details.rows,
    [DATASETS.reviews]: reviews.rows,
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
    toast(`Saved ${name}`);
  } catch (err) {
    toast(String(err.message || err), true);
  }
}

async function onCopyJson() {
  try {
    const dataset = currentDataset === DATASETS.all ? DATASETS.search : currentDataset;
    const { rows } = await fetchDataset(dataset);
    if (!rows.length) {
      toast('Nothing to copy yet', true);
      return;
    }
    const { rows: shaped } = pickFields(rows, {
      fields: DATASET_FIELDS[dataset],
      includeDebug: el('includeDebug').checked,
    });
    await navigator.clipboard.writeText(JSON.stringify(shaped, null, 2));
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
