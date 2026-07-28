/**
 * UI controller for both the popup and the tab dashboard (same document; the
 * `?view=tab` query switches to the wide layout).
 */

import { MSG, RUN_STATUS, DEFAULTS } from '../common/constants.js';
import { exportRows, pickFields } from './export.js';

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
  ['stopOnEmptyPage', 'stopOnEmptyPage', 'bool'],
  ['manualCaptchaSolve', 'manualCaptchaSolve', 'bool'],
  ['keepTabsOpen', 'keepTabsOpen', 'bool'],
];

let cachedRows = [];
let rowTotal = 0;

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
      case 'numOrNull': {
        settings[key] = node.value === '' ? null : Number(node.value);
        break;
      }
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
  updateQueriesHint();
}

function updateQueriesHint() {
  const count = el('queries').value.split('\n').filter((s) => s.trim()).length;
  const pages = Number.parseInt(el('maxPagesPerQuery').value, 10) || 0;
  el('queriesHint').textContent = count
    ? `${count} quer${count === 1 ? 'y' : 'ies'} -> up to ${count * pages} page request(s)`
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

function renderState(state, rowCount, running) {
  const status = state.status || RUN_STATUS.IDLE;
  const pill = el('statusPill');
  pill.textContent = status;
  pill.className = `pill pill-${status}`;

  const p = state.progress || {};
  const planned = p.pagesPlanned || 0;
  const done = p.pagesDone || 0;
  const pct = planned ? Math.min(100, Math.round((done / planned) * 100)) : (running ? 5 : 0);
  el('progressBar').style.width = `${pct}%`;

  el('statRows').textContent = fmt(p.rows || 0);
  el('statPages').textContent = `${fmt(done)} / ${fmt(planned)}`;
  el('statQueries').textContent = `${fmt(p.queriesDone || 0)} / ${fmt(p.queriesTotal || 0)}`;
  el('statDupes').textContent = fmt(p.duplicates || 0);
  el('statAds').textContent = fmt(p.adsSkipped || 0);
  el('statRetries').textContent = fmt(p.retries || 0);
  el('statBlocks').textContent = fmt(p.blocks || 0);
  el('statusMessage').textContent = state.message || (running ? 'Working…' : 'Ready.');

  const active = state.active || [];
  const activeNode = el('activeList');
  activeNode.hidden = active.length === 0;
  activeNode.textContent = active.length ? `In flight: ${active.join(', ')}` : '';

  el('start').disabled = running;
  el('stop').disabled = !running;
  el('scrapeTab').disabled = running;

  renderLog(state.log || []);
  el('rowCount').textContent = `${fmt(rowCount)} rows`;
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

function renderPreview(rows, total) {
  const body = el('previewBody');
  if (!rows.length) {
    body.innerHTML = '<tr class="empty"><td colspan="9">No rows yet.</td></tr>';
    el('previewHint').textContent = '';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.append(
      td(row.position, 'num'),
      td(row.query),
      td(row.page, 'num'),
      titleCell(row),
      td(formatPrice(row), 'num'),
      td(row.shopName || '—'),
      td(row.rating == null ? '—' : row.rating, 'num'),
      td(row.reviewCount == null ? '—' : fmt(row.reviewCount), 'num'),
      flagsCell(row),
    );
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
  cell.textContent = value === null || value === undefined || value === '' ? '—' : String(value);
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
  return `${row.price.toFixed(2)} ${row.currency || ''}`.trim();
}

function fmt(n) {
  return Number(n || 0).toLocaleString();
}

let toastTimer = null;
function toast(message, isError = false) {
  const node = el('toast');
  node.textContent = message;
  node.className = `toast${isError ? ' error' : ''}`;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 4000);
}

// ------------------------------------------------------------------ actions

async function refresh({ withRows = true } = {}) {
  const { state, rowCount, running } = await send(MSG.GET_STATE);
  renderState(state, rowCount, running);
  if (withRows) {
    const { rows, total } = await send(MSG.GET_RESULTS, { limit: PREVIEW_LIMIT });
    rowTotal = total;
    renderPreview(rows, total);
  }
}

async function loadAllRows() {
  const { rows, total } = await send(MSG.GET_RESULTS, {});
  cachedRows = rows;
  rowTotal = total;
  return rows;
}

async function onStart() {
  const settings = readForm();
  if (!settings.queries.length) {
    toast('Add at least one search keyword', true);
    el('queries').focus();
    return;
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
    toast('Run started');
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
    const rows = await loadAllRows();
    if (!rows.length) {
      toast('Nothing to export yet', true);
      return;
    }
    const name = await exportRows(rows, format, { includeDebug: el('includeDebug').checked });
    toast(`Saved ${name}`);
  } catch (err) {
    toast(String(err.message || err), true);
  }
}

async function onCopyJson() {
  try {
    const rows = await loadAllRows();
    if (!rows.length) {
      toast('Nothing to copy yet', true);
      return;
    }
    const { rows: shaped } = pickFields(rows, { includeDebug: el('includeDebug').checked });
    await navigator.clipboard.writeText(JSON.stringify(shaped, null, 2));
    toast(`Copied ${rows.length} row(s) as JSON`);
  } catch (err) {
    toast(String(err.message || err), true);
  }
}

async function onClear() {
  try {
    await send(MSG.CLEAR_RESULTS);
    cachedRows = [];
    toast('Results cleared');
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

  el('queries').addEventListener('input', updateQueriesHint);
  el('maxPagesPerQuery').addEventListener('input', updateQueriesHint);

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
    renderState(message.state, message.rowCount, message.state.status === RUN_STATUS.RUNNING
      || message.state.status === RUN_STATUS.STOPPING);
    // Keep the preview roughly in sync without hammering the worker.
    schedulePreviewRefresh(message.rowCount);
  });
}

let previewTimer = null;
function schedulePreviewRefresh(rowCount) {
  if (rowCount === rowTotal) return;
  if (previewTimer) return;
  previewTimer = setTimeout(async () => {
    previewTimer = null;
    try {
      const { rows, total } = await send(MSG.GET_RESULTS, { limit: PREVIEW_LIMIT });
      rowTotal = total;
      renderPreview(rows, total);
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
