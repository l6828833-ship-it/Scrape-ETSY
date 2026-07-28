/**
 * End-to-end load check: does the extension actually install and run?
 *
 *   node tests/extension-check.mjs
 *
 * Part 1 — static analysis: every path the manifest references and every
 * relative import resolves, permissions match the APIs the code calls, and no
 * remote scripts / eval sneak in (MV3 forbids them).
 *
 * Part 2 — live load in headless Chrome with the unpacked extension:
 *   * the MV3 service worker registers with no module or syntax errors,
 *   * the UI page boots, is populated from stored settings, and completes real
 *     message round-trips with the worker (GET_SETTINGS / SAVE_SETTINGS /
 *     GET_STATE / START_RUN validation),
 *   * the offscreen document loads and parses fixture HTML with DOMParser,
 *   * a full run drives the orchestrator through URL building, the engine,
 *     retries, state transitions and completion,
 *   * exports produce a valid CSV / XLSX / JSON inside the extension page.
 *
 * The one leg that cannot be covered here is the HTTP request against the real
 * etsy.com (the sandbox has no egress and no way to mint a trusted certificate
 * for a fake origin), so the run test asserts orchestration and error handling
 * rather than live listing data.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ext = path.join(root, 'extension');
const PORT = 9840 + (process.pid % 120);

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  \u2717 ${name}\n      ${String(err.message).split('\n').join('\n      ')}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// =============================================================== static checks

console.log('\nManifest and module graph');

const manifest = JSON.parse(readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
const allFiles = walk(ext);
const jsFiles = allFiles.filter((f) => f.endsWith('.js'));
const htmlFiles = allFiles.filter((f) => f.endsWith('.html'));

await test('manifest declares MV3 with the expected entry points', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.type, 'module');
  assert.ok(existsSync(path.join(ext, manifest.background.service_worker)), 'service worker missing');
  assert.ok(existsSync(path.join(ext, manifest.action.default_popup)), 'popup missing');
  for (const size of Object.keys(manifest.icons)) {
    assert.ok(existsSync(path.join(ext, manifest.icons[size])), `icon ${size} missing`);
  }
  assert.deepEqual(manifest.host_permissions, ['https://www.etsy.com/*']);
});

await test('every chrome.* API the code uses is declared', () => {
  const declared = new Set([...manifest.permissions, ...(manifest.optional_permissions || [])]);
  const source = jsFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
  const used = new Set([...source.matchAll(/chrome\.([a-zA-Z]+)\./g)].map((m) => m[1]));
  // Available to every extension without a permission entry.
  const implicit = new Set(['runtime', 'permissions', 'windows', 'i18n', 'extension']);
  for (const api of used) {
    if (implicit.has(api)) continue;
    assert.ok(declared.has(api), `chrome.${api} used but not declared in the manifest`);
  }
});

await test('proxy-only APIs stay in optional_permissions', () => {
  assert.deepEqual(manifest.optional_permissions, ['proxy', 'webRequest', 'webRequestAuthProvider']);
  for (const p of manifest.optional_permissions) {
    assert.ok(!manifest.permissions.includes(p), `${p} must not be required at install time`);
  }
});

await test('all relative ES imports resolve to real files', () => {
  const missing = [];
  for (const file of jsFiles) {
    const source = readFileSync(file, 'utf8');
    const pattern = /from\s+['"](\.[^'"]+)['"]|import\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    for (const m of source.matchAll(pattern)) {
      const spec = m[1] || m[2] || m[3];
      if (!existsSync(path.resolve(path.dirname(file), spec))) {
        missing.push(`${path.relative(ext, file)} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(missing, [], `unresolved imports:\n${missing.join('\n')}`);
});

await test('HTML pages only reference local assets (MV3 blocks remote code)', () => {
  const problems = [];
  for (const file of htmlFiles) {
    const html = readFileSync(file, 'utf8');
    for (const m of html.matchAll(/<script[^>]*src=["']([^"']+)["']/g)) {
      if (/^https?:|^\/\//.test(m[1])) problems.push(`${path.relative(ext, file)}: remote script ${m[1]}`);
      else if (!existsSync(path.resolve(path.dirname(file), m[1]))) {
        problems.push(`${path.relative(ext, file)}: missing ${m[1]}`);
      }
    }
    for (const m of html.matchAll(/<link[^>]*href=["']([^"']+)["']/g)) {
      if (!/^https?:|^\/\//.test(m[1]) && !existsSync(path.resolve(path.dirname(file), m[1]))) {
        problems.push(`${path.relative(ext, file)}: missing ${m[1]}`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

await test('no eval / new Function / inline event handlers anywhere', () => {
  const offenders = [];
  for (const file of [...jsFiles, ...htmlFiles]) {
    const source = readFileSync(file, 'utf8');
    if (/\beval\s*\(|new Function\s*\(/.test(source)) offenders.push(path.relative(ext, file));
    if (file.endsWith('.html') && /\son(click|load|change|submit)\s*=/.test(source)) {
      offenders.push(`${path.relative(ext, file)} (inline handler)`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join(', '));
});

await test('background code uses no dynamic import() (banned in workers)', () => {
  // ServiceWorkerGlobalScope forbids import(); it throws at runtime, not load
  // time, so a code path using it can look fine until the day it runs.
  const offenders = [];
  for (const file of jsFiles.filter((f) => f.includes(`${path.sep}background${path.sep}`))) {
    const code = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');
    if (/(?:^|[^.\w])import\s*\(/.test(code)) offenders.push(path.relative(ext, file));
  }
  assert.deepEqual(offenders, [], `dynamic import() in worker code: ${offenders.join(', ')}`);
});

await test('files injected by tab-engine exist', () => {
  const source = readFileSync(path.join(ext, 'src/background/tab-engine.js'), 'utf8');
  const list = source.match(/INJECT_FILES\s*=\s*\[([^\]]+)\]/);
  assert.ok(list, 'INJECT_FILES not found');
  const files = [...list[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.ok(files.length >= 2);
  for (const f of files) assert.ok(existsSync(path.join(ext, f)), `missing injected file ${f}`);
});

await test('OFFSCREEN_PATH points at the real offscreen document', () => {
  const constants = readFileSync(path.join(ext, 'src/common/constants.js'), 'utf8');
  const m = constants.match(/OFFSCREEN_PATH\s*=\s*['"]([^'"]+)['"]/);
  assert.ok(m, 'OFFSCREEN_PATH not found');
  assert.ok(existsSync(path.join(ext, m[1])), `${m[1]} does not exist`);
});

await test('every element id used by app.js exists in app.html', () => {
  const js = readFileSync(path.join(ext, 'src/ui/app.js'), 'utf8');
  const html = readFileSync(path.join(ext, 'src/ui/app.html'), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const referenced = new Set([...js.matchAll(/\bel\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]));
  const missing = [...referenced].filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `ids used in app.js but absent from app.html: ${missing.join(', ')}`);
});

// ============================================================ live load check

const chromePath = ['/usr/local/bin/chrome', '/usr/bin/chromium', '/usr/bin/google-chrome', process.env.CHROME_PATH]
  .filter(Boolean).find((p) => existsSync(p));

if (!chromePath) {
  console.log('\n! headless Chrome not found — skipping the live load check');
  report();
}

/**
 * Chrome derives an unpacked extension's id from the SHA-256 of its absolute
 * path: the first 16 bytes, with each hex nibble mapped onto a–p.
 */
function unpackedExtensionId(absPath) {
  const digest = createHash('sha256').update(absPath).digest('hex').slice(0, 32);
  return [...digest].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

const extensionId = unpackedExtensionId(ext);
const profileDir = mkdtempSync(path.join(tmpdir(), 'etsy-scraper-ext-'));
let chromeExit = null;
let chromeErr = '';

const chrome = spawn(chromePath, [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profileDir}`,
  `--disable-extensions-except=${ext}`,
  `--load-extension=${ext}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

chrome.stderr.on('data', (c) => {
  chromeErr += String(c)
    .split('\n')
    .filter((l) => l && !/dbus|NameHasOwner|Failed to connect to the bus/i.test(l))
    .join('\n');
});
chrome.on('exit', (code, signal) => { chromeExit = signal || code; });
chrome.on('error', (err) => { chromeErr += `spawn error: ${err.message}\n`; });

class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 1;
    this.pending = new Map();
    /** Uncaught exceptions / console errors seen during this session. */
    this.errors = [];
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails || {};
        this.errors.push((d.exception && (d.exception.description || d.exception.value)) || d.text || 'exception');
        return;
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        this.errors.push(msg.params.entry.text);
        return;
      }
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message));
      else entry.resolve(msg.result);
    });
  }

  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP websocket failed')), { once: true });
    });
    const session = new Session(ws);
    await session.send('Runtime.enable').catch(() => {});
    await session.send('Log.enable').catch(() => {});
    return session;
  }

  send(method, params = {}) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error((d.exception && (d.exception.description || d.exception.value)) || d.text);
    }
    return res.result.value;
  }

  close() {
    try { this.ws.close(); } catch (_) { /* already closed */ }
  }
}

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

async function waitForTarget(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (chromeExit !== null) throw new Error(`Chrome exited (${chromeExit})\n${chromeErr.trim()}`);
    try {
      const found = predicate(await targets());
      if (found) return found;
    } catch (_) { /* keep polling */ }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}\n${chromeErr.trim()}`);
}

/** Open a chrome-extension:// page and wait for it to finish loading. */
async function openExtensionPage(relPath) {
  const url = `chrome-extension://${extensionId}/${relPath}`;
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`could not open ${relPath}: HTTP ${res.status}`);
  const target = await res.json();
  const session = await Session.open(target.webSocketDebuggerUrl);
  const deadline = Date.now() + 15000;
  for (;;) {
    const state = await session.evaluate('document.readyState');
    const href = await session.evaluate('location.href');
    if (state === 'complete') {
      if (!href.startsWith('chrome-extension://')) {
        throw new Error(`page did not load from the extension (got ${href}) — is the extension installed?`);
      }
      break;
    }
    if (Date.now() > deadline) throw new Error(`${relPath} did not finish loading`);
    await sleep(100);
  }
  return { session, targetId: target.id, url };
}

async function closeTarget(targetId) {
  await fetch(`http://127.0.0.1:${PORT}/json/close/${targetId}`).catch(() => {});
}

let ui = null;

try {
  console.log(`\nLive extension load (id ${extensionId})`);

  // Wait for the DevTools endpoint before touching it.
  await waitForTarget((list) => Array.isArray(list), 30000, 'the DevTools endpoint');

  // Opening the UI page also wakes the (lazily started) service worker.
  const page = await openExtensionPage('src/ui/app.html?view=tab');
  ui = page.session;
  await sleep(700); // let init() finish its round-trips

  const workerTarget = await waitForTarget(
    (list) => list.find((t) => t.url === `chrome-extension://${extensionId}/src/background/service-worker.js`),
    20000,
    'the MV3 service worker to register',
  );

  await test('service worker registers without module errors', async () => {
    const session = await Session.open(workerTarget.webSocketDebuggerUrl);
    try {
      const health = await session.evaluate(`JSON.stringify({
        id: chrome.runtime.id,
        hasOffscreen: typeof chrome.offscreen === 'object',
        hasScripting: typeof chrome.scripting === 'object',
        hasDownloads: typeof chrome.downloads === 'object',
        hasDomParser: typeof DOMParser
      })`);
      const h = JSON.parse(health);
      assert.equal(h.id, extensionId);
      assert.equal(h.hasOffscreen, true, 'offscreen permission not effective');
      assert.equal(h.hasScripting, true);
      assert.equal(h.hasDownloads, true);
      assert.equal(h.hasDomParser, 'undefined', 'workers have no DOMParser — hence the offscreen document');
      assert.deepEqual(session.errors, [], session.errors.join('\n'));
    } finally {
      session.close();
    }
  });

  await test('UI page renders and is populated from stored defaults', async () => {
    const shape = await ui.evaluate(`JSON.stringify({
      pages: document.getElementById('maxPagesPerQuery').value,
      concurrency: document.getElementById('maxConcurrency').value,
      retries: document.getElementById('maxRequestRetries').value,
      engine: document.getElementById('engine').value,
      sort: document.getElementById('sortOrder').value,
      dedupe: document.getElementById('dedupe').value,
      minDelay: document.getElementById('minDelayMs').value,
      maxDelay: document.getElementById('maxDelayMs').value,
      status: document.getElementById('statusPill').textContent.trim(),
      rowCount: document.getElementById('rowCount').textContent.trim(),
      wide: document.body.classList.contains('view-tab'),
      exportButtons: document.querySelectorAll('[data-export]').length,
      startEnabled: !document.getElementById('start').disabled,
      stopDisabled: document.getElementById('stop').disabled,
      preview: document.querySelector('#previewBody tr.empty') !== null
    })`);
    const s = JSON.parse(shape);
    assert.equal(s.pages, '3', 'default maxPagesPerQuery');
    assert.equal(s.concurrency, '4');
    assert.equal(s.retries, '5');
    assert.equal(s.engine, 'hybrid');
    assert.equal(s.sort, 'most_relevant');
    assert.equal(s.dedupe, 'per_query');
    assert.equal(s.minDelay, '1000');
    assert.equal(s.maxDelay, '3000');
    assert.equal(s.status, 'idle');
    assert.equal(s.rowCount, '0 rows');
    assert.equal(s.wide, true, '?view=tab switches to the wide layout');
    assert.equal(s.exportButtons, 4);
    assert.equal(s.startEnabled, true);
    assert.equal(s.stopDisabled, true);
    assert.equal(s.preview, true, 'empty-state row rendered');
  });

  await test('UI ↔ worker messaging works (GET_SETTINGS / GET_STATE)', async () => {
    const raw = await ui.evaluate(`(async () => JSON.stringify({
      settings: await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }),
      state: await chrome.runtime.sendMessage({ type: 'GET_STATE' })
    }))()`);
    const { settings, state } = JSON.parse(raw);
    assert.equal(settings.ok, true, JSON.stringify(settings));
    assert.equal(settings.result.maxPagesPerQuery, 3);
    assert.equal(settings.result.sortOrder, 'most_relevant');
    assert.equal(state.ok, true);
    assert.equal(state.result.running, false);
    assert.equal(state.result.rowCount, 0);
    assert.equal(state.result.state.status, 'idle');
  });

  await test('unknown message types are rejected cleanly', async () => {
    const raw = await ui.evaluate(`(async () => JSON.stringify(
      await chrome.runtime.sendMessage({ type: 'NOPE' })
    ))()`);
    const res = JSON.parse(raw);
    assert.equal(res.ok, false);
    assert.match(res.error, /Unknown message type/);
  });

  await test('settings round-trip through the worker with validation', async () => {
    const raw = await ui.evaluate(`(async () => {
      await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: {
        queries: ['handmade ceramic mug', '', ' linen apron '],
        maxPagesPerQuery: 999, maxConcurrency: 99, sortOrder: 'price_asc',
        shipTo: 'de', minPrice: '15', engine: 'not-an-engine',
        bestsellerOnly: true, excludeSponsored: true
      }});
      return JSON.stringify(await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }));
    })()`);
    const { result } = JSON.parse(raw);
    assert.deepEqual(result.queries, ['handmade ceramic mug', 'linen apron'], 'blank lines dropped, trimmed');
    assert.equal(result.maxPagesPerQuery, 250, 'clamped to the documented maximum');
    assert.equal(result.maxConcurrency, 8);
    assert.equal(result.sortOrder, 'price_asc');
    assert.equal(result.shipTo, 'DE');
    assert.equal(result.minPrice, 15);
    assert.equal(result.engine, 'hybrid', 'invalid enum falls back to the default');
    assert.equal(result.bestsellerOnly, true);
    assert.equal(result.excludeSponsored, true);
  });

  await test('bestseller filter reaches the URL built inside the extension', async () => {
    const url = await ui.evaluate(`(async () => {
      const { buildSearchUrl } = await import('/src/common/url-builder.js');
      return buildSearchUrl({ query: '2026 calendar printable', bestsellerOnly: true });
    })()`);
    const u = new URL(url);
    assert.equal(u.searchParams.get('is_best_seller'), 'true');
    assert.equal(u.searchParams.get('explicit'), '1');
  });

  await test('the new filter checkboxes are wired to the form', async () => {
    const raw = await ui.evaluate(`(async () => {
      document.getElementById('bestsellerOnly').checked = true;
      document.getElementById('excludeSponsored').checked = true;
      document.getElementById('bestsellerOnly').dispatchEvent(new Event('change'));
      document.getElementById('excludeSponsored').dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 400));
      return JSON.stringify(await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }));
    })()`);
    const { result } = JSON.parse(raw);
    assert.equal(result.bestsellerOnly, true, 'checkbox change must persist through the worker');
    assert.equal(result.excludeSponsored, true);
  });

  await test('a run with no queries surfaces an error state', async () => {
    await ui.evaluate(`chrome.runtime.sendMessage({ type: 'START_RUN', settings: { queries: [] } })`);
    await sleep(600);
    const raw = await ui.evaluate(`(async () => JSON.stringify(
      await chrome.runtime.sendMessage({ type: 'GET_STATE' })
    ))()`);
    const { result } = JSON.parse(raw);
    assert.equal(result.state.status, 'error');
    assert.match(result.state.message, /quer(y|ies) is required/i);
    assert.equal(result.running, false);
  });

  await test('offscreen document parses fixture HTML with DOMParser', async () => {
    const fixture = readFileSync(path.join(root, 'tests/fixtures/etsy-search-page.html'), 'utf8');
    const off = await openExtensionPage('src/offscreen/offscreen.html');
    try {
      const raw = await off.session.evaluate(`(() => {
        const html = ${JSON.stringify(fixture)};
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const result = EtsyParse.parsePage({ html, doc, context: { query: 'mug', page: 1, scrapedAt: '2026-05-13T04:35:22Z' } });
        return JSON.stringify({
          counts: result.counts,
          rows: result.records.length,
          first: result.records[0],
          hasListener: chrome.runtime.onMessage.hasListeners()
        });
      })()`);
      const parsed = JSON.parse(raw);
      assert.equal(parsed.hasListener, true, 'offscreen.js did not register its PARSE_HTML listener');
      assert.equal(parsed.counts.dom, 4, 'DOMParser path found all cards');
      assert.equal(parsed.counts.jsonld, 3);
      assert.equal(parsed.rows, 4);
      assert.equal(parsed.first.listingId, '1027105561');
      assert.equal(parsed.first.price, 28);
      assert.equal(parsed.first.currency, 'USD');
      assert.equal(parsed.first.shopName, 'ArtisanPottery');
      assert.equal(parsed.first.query, 'mug');
      assert.deepEqual(off.session.errors, [], off.session.errors.join('\n'));
    } finally {
      off.session.close();
      await closeTarget(off.targetId);
    }
  });

  await test('offscreen document also parses listing pages (deep scrape)', async () => {
    const fixture = readFileSync(path.join(root, 'tests/fixtures/etsy-listing-page.html'), 'utf8');
    const off = await openExtensionPage('src/offscreen/offscreen.html');
    try {
      const raw = await off.session.evaluate(`(() => {
        const html = ${JSON.stringify(fixture)};
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const result = EtsyDetail.parseListingPage({ html, doc, context: {
          listingId: '1544102938', scrapeReviews: true, maxReviews: 20
        } });
        return JSON.stringify({
          listingId: result.record.listingId,
          favorites: result.record.favoritesCount,
          cart: result.record.cartCount,
          variationCount: result.record.variationCount,
          tags: result.record.tagCount,
          shopSales: result.record.shopTotalSales,
          starSeller: result.record.isStarSeller,
          memberSince: result.record.shopMemberSince,
          freeShipping: result.record.freeShipping,
          reviews: result.reviews.length,
          firstReviewRating: result.reviews[0].rating
        });
      })()`);
      const out = JSON.parse(raw);
      assert.equal(out.listingId, '1544102938');
      assert.equal(out.favorites, 1482);
      assert.equal(out.cart, 20);
      assert.equal(out.variationCount, 6);
      assert.equal(out.tags, 6);
      assert.equal(out.shopSales, 12345);
      assert.equal(out.starSeller, true);
      assert.equal(out.memberSince, 2019);
      assert.equal(out.freeShipping, true);
      assert.equal(out.reviews, 3);
      assert.equal(out.firstReviewRating, 5);
      assert.deepEqual(off.session.errors, [], off.session.errors.join('\n'));
    } finally {
      off.session.close();
      await closeTarget(off.targetId);
    }
  });

  await test('deep-scrape settings round-trip and clamp', async () => {
    const raw = await ui.evaluate(`(async () => {
      await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: {
        queries: ['2026 calendar printable'],
        scrapeDetails: true, maxDetailListings: 9999, detailConcurrency: 99,
        maxReviewsPerListing: 500, scrapeReviews: true, trackHistory: true
      }});
      return JSON.stringify(await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }));
    })()`);
    const { result } = JSON.parse(raw);
    assert.equal(result.scrapeDetails, true);
    assert.equal(result.maxDetailListings, 500, 'clamped to the documented maximum');
    assert.equal(result.detailConcurrency, 4);
    assert.equal(result.maxReviewsPerListing, 100);
    assert.equal(result.trackHistory, true);
  });

  await test('detail and review datasets are addressable from the UI', async () => {
    const raw = await ui.evaluate(`(async () => JSON.stringify({
      details: await chrome.runtime.sendMessage({ type: 'GET_DETAILS', limit: 10 }),
      reviews: await chrome.runtime.sendMessage({ type: 'GET_REVIEWS', limit: 10 }),
      state: await chrome.runtime.sendMessage({ type: 'GET_STATE' })
    }))()`);
    const { details, reviews, state } = JSON.parse(raw);
    assert.equal(details.ok, true, JSON.stringify(details));
    assert.equal(details.result.total, 0);
    assert.equal(reviews.ok, true);
    assert.equal(reviews.result.total, 0);
    assert.equal(state.result.detailCount, 0);
    assert.equal(state.result.reviewCount, 0);
    assert.ok(state.result.history, 'history stats missing from run state');
    assert.equal(state.result.history.listings, 0);
  });

  await test('dataset picker offers every dataset and drives the preview', async () => {
    const raw = await ui.evaluate(`(async () => {
      const select = document.getElementById('dataset');
      const options = [...select.options].map(o => o.value);
      select.value = 'details';
      select.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 400));
      return JSON.stringify({
        options,
        headers: [...document.querySelectorAll('#previewHead th')].map(th => th.textContent),
        hint: document.getElementById('previewHint').textContent
      });
    })()`);
    const out = JSON.parse(raw);
    assert.deepEqual(out.options,
      ['search', 'details', 'reviews', 'history', 'log', 'all']);
    assert.ok(out.headers.includes('Favs/day'), `detail columns expected, got ${out.headers}`);
    assert.ok(out.headers.includes('Opp'));
    assert.match(out.hint, /Deep listing intelligence/, 'empty state should explain itself');
  });

  await test('every dataset option states what is in it', async () => {
    // The picker used to read "Search rows" / "Listing details", which gave no
    // hint that tags and description are absent from the first one — the single
    // most common cause of "the field is missing from my export".
    const raw = await ui.evaluate(`JSON.stringify(
      [...document.getElementById('dataset').options].map(o => o.textContent.trim())
    )`);
    const labels = JSON.parse(raw);
    const search = labels.find((l) => /^Search rows/.test(l));
    const details = labels.find((l) => /^Listing details/.test(l));
    assert.match(search, /no tags/i, 'the grid option must say tags are not in it');
    assert.match(details, /tags/i, 'the details option must say tags are in it');
  });

  await test('the search-grid preview points at where tags actually live', async () => {
    const hint = await ui.evaluate(`(async () => {
      const select = document.getElementById('dataset');
      select.value = 'search';
      select.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 400));
      return document.getElementById('previewHint').textContent;
    })()`);
    // Stated in both the empty and the populated state, because a user hunting a
    // missing field looks at this line either way.
    assert.match(hint, /Listing details/,
      `search preview should name the details dataset, got: ${hint}`);
  });

  await test('the deep-scrape control names the fields it gates', async () => {
    const raw = await ui.evaluate(`JSON.stringify({
      summary: document.querySelector('#deep summary').textContent,
      label: document.querySelector('#deep .check span').textContent
    })`);
    const out = JSON.parse(raw);
    // This section is collapsed by default, so the summary is all a user sees.
    assert.match(out.summary, /tags/i, 'collapsed summary must mention tags');
    assert.match(out.label, /tags/i);
    assert.match(out.label, /description/i);
  });

  await test('the snapshot history is reachable from the UI', async () => {
    // It was recorded on every deep scrape and then had no way out: no message,
    // no dataset, no sheet. Every velocity number is derived from it.
    const out = JSON.parse(await ui.evaluate(`(async () => {
      const res = await chrome.runtime.sendMessage({ type: 'GET_HISTORY_ROWS' });
      // Responses are wrapped as { ok, result }.
      return JSON.stringify({
        ok: res && res.ok === true,
        hasTotal: typeof (res.result || {}).total === 'number',
        isArray: Array.isArray((res.result || {}).rows)
      });
    })()`));
    assert.equal(out.ok, true, 'the worker accepts the new message type');
    assert.equal(out.hasTotal, true, 'the worker answers GET_HISTORY_ROWS');
    assert.equal(out.isArray, true);
  });

  await test('"All datasets" covers every table, not just the first three', async () => {
    const out = JSON.parse(await ui.evaluate(`(async () => {
      const { ALL_DATASETS, DATASET_FIELDS, DATASET_LABELS } = await import('/src/ui/export.js');
      return JSON.stringify({
        all: ALL_DATASETS,
        haveFields: ALL_DATASETS.every(d => Array.isArray(DATASET_FIELDS[d]) && DATASET_FIELDS[d].length),
        haveLabels: ALL_DATASETS.every(d => typeof DATASET_LABELS[d] === 'string')
      });
    })()`));
    assert.deepEqual(out.all, ['search', 'details', 'reviews', 'history', 'log'],
      'history and log are part of "all" now');
    assert.equal(out.haveFields, true, 'every dataset in "all" has an export schema');
    assert.equal(out.haveLabels, true, 'and a sheet name');
  });

  await test('the run summary in a JSON export never carries the API key', async () => {
    // The summary describes the run, and the settings object it is derived from
    // holds the Etsy API key. That must not reach a file on disk.
    const out = JSON.parse(await ui.evaluate(`(async () => {
      await chrome.runtime.sendMessage({ type: 'SET_SETTINGS',
        settings: { etsyApiKey: 'SECRETKEY123', queries: ['x'] } });
      const { exportDataset } = await import('/src/ui/export.js');
      let captured = null;
      const realDownload = chrome.downloads.download;
      chrome.downloads.download = async () => { throw new Error('blocked in test'); };
      const origCreate = URL.createObjectURL;
      URL.createObjectURL = (blob) => { captured = blob; return origCreate(blob); };
      try {
        await exportDataset('all', 'json', {
          search: [{ listingId: '1', title: 't' }], details: [], reviews: [],
          history: [], log: [{ at: 'x', level: 'info', message: 'm', detail: null }],
          run: { status: 'done', queries: ['x'], counts: { rows: 1 } }
        });
      } catch (_) { /* download is stubbed out */ }
      chrome.downloads.download = realDownload;
      URL.createObjectURL = origCreate;
      const text = captured ? await captured.text() : '';
      return JSON.stringify({
        hasRun: text.includes('"run"'),
        hasLog: text.includes('"log"'),
        hasHistory: text.includes('"history"'),
        leaksKey: text.includes('SECRETKEY123')
      });
    })()`));
    assert.equal(out.leaksKey, false, 'the API key must never appear in an export');
    assert.equal(out.hasRun, true, 'the run summary is included');
    assert.equal(out.hasLog, true);
    assert.equal(out.hasHistory, true);
  });

  await test('multi-sheet workbook builds inside the extension page', async () => {
    const raw = await ui.evaluate(`(async () => {
      const { toWorkbook } = await import('/src/ui/export.js');
      const blob = toWorkbook({
        search: [{ listingId: '1', title: 'a', query: 'q', page: 1, position: 1 }],
        details: [{ listingId: '1', title: 'a', materials: ['x', 'y'], favoritesPerDay: 3 }],
        reviews: [{ listingId: '1', rating: 5, comment: 'great' }]
      });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const text = new TextDecoder().decode(bytes);
      return JSON.stringify({
        zip: bytes[0] === 0x50 && bytes[1] === 0x4b,
        sheets: (text.match(/worksheets\\/sheet\\d+\\.xml/g) || []).length,
        flattened: text.includes('x; y')
      });
    })()`);
    const out = JSON.parse(raw);
    assert.equal(out.zip, true);
    assert.ok(out.sheets >= 3, `expected 3 worksheet parts, saw ${out.sheets}`);
    assert.equal(out.flattened, true, 'array values must be flattened for Excel');
  });

  await test('URL builder runs inside the extension and targets Etsy search', async () => {
    const url = await ui.evaluate(`(async () => {
      const { buildSearchUrl } = await import('/src/common/url-builder.js');
      return buildSearchUrl({ query: 'handmade ceramic mug', page: 2, sortOrder: 'price_asc',
        minPrice: 10, maxPrice: 50, shipTo: 'US' });
    })()`);
    const parsedUrl = new URL(url);
    assert.equal(parsedUrl.origin + parsedUrl.pathname, 'https://www.etsy.com/search');
    assert.equal(parsedUrl.searchParams.get('q'), 'handmade ceramic mug');
    assert.equal(parsedUrl.searchParams.get('page'), '2');
    assert.equal(parsedUrl.searchParams.get('order'), 'price_asc');
    assert.equal(parsedUrl.searchParams.get('min'), '10');
    assert.equal(parsedUrl.searchParams.get('max'), '50');
    assert.equal(parsedUrl.searchParams.get('ship_to'), 'US');
  });

  await test('a real run drives the orchestrator to completion', async () => {
    // No sandbox egress, so every request fails; what we are asserting here is
    // the run loop: scheduling, retry accounting, logging, and termination.
    await ui.evaluate(`chrome.runtime.sendMessage({ type: 'START_RUN', settings: {
      queries: ['handmade ceramic mug'], maxPagesPerQuery: 2, maxConcurrency: 2,
      maxRequestRetries: 0, engine: 'fetch', minDelayMs: 0, maxDelayMs: 0,
      proxyConfiguration: { enabled: false, proxies: [], rotateEveryRequests: 5 }
    }})`);

    let state = null;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      await sleep(500);
      const raw = await ui.evaluate(`(async () => JSON.stringify(
        await chrome.runtime.sendMessage({ type: 'GET_STATE' })
      ))()`);
      state = JSON.parse(raw).result;
      if (!state.running && state.state.status !== 'running' && state.state.status !== 'stopping') break;
    }
    assert.ok(state, 'no state returned');
    assert.equal(state.state.status, 'done', `run did not finish: ${JSON.stringify(state.state.message)}`);
    assert.equal(state.state.progress.queriesTotal, 1);
    assert.equal(state.state.progress.pagesPlanned, 2);
    assert.equal(state.state.progress.pagesDone, 2, 'both pages accounted for');
    assert.equal(state.state.active.length, 0, 'no in-flight entries left behind');
    assert.ok(state.state.log.length > 0, 'run produced no log entries');
    assert.match(state.state.log[0].message, /Run started/);
    assert.match(String(state.state.message), /Finished/);
  });

  await test('SCRAPE_ACTIVE_TAB reaches the worker and guards non-Etsy tabs', async () => {
    // Exercises the message path end-to-end; the active tab here is not Etsy,
    // so the worker's guard must reject it with a clear error.
    const raw = await ui.evaluate(`(async () => JSON.stringify(
      await chrome.runtime.sendMessage({ type: 'SCRAPE_ACTIVE_TAB' })
    ))()`);
    const res = JSON.parse(raw);
    assert.equal(res.ok, false);
    assert.match(res.error, /not an etsy\.com page|No active tab/i);
  });

  await test('exports build a valid CSV, XLSX and JSON in the page', async () => {
    const raw = await ui.evaluate(`(async () => {
      const { toCsv, toXlsx, toJson } = await import('/src/ui/export.js');
      const rows = [{ query: 'mug', page: 1, position: 1, listingId: '1', title: 'A, "B"', price: 28,
        currency: 'USD', shopName: 'S', image: null, url: 'https://www.etsy.com/listing/1/a',
        rating: 4.8, reviewCount: 342, freeShipping: true, bestseller: false, sponsored: false,
        scrapedAt: '2026-05-13T04:35:22Z' }];
      const csv = await toCsv(rows).text();
      const bytes = new Uint8Array(await toXlsx(rows).arrayBuffer());
      const json = JSON.parse(await toJson(rows).text());
      return JSON.stringify({
        header: csv.replace(/^\\ufeff/, '').split('\\r\\n')[0],
        quoted: csv.includes('"A, ""B"""'),
        zip: bytes[0] === 0x50 && bytes[1] === 0x4b,
        size: bytes.length,
        keys: Object.keys(json[0])
      });
    })()`);
    const out = JSON.parse(raw);
    assert.equal(out.header, 'query,page,position,listingId,title,price,currency,shopName,image,url,rating,reviewCount,freeShipping,bestseller,sponsored,isDigital,scrapedAt');
    assert.equal(out.quoted, true, 'CSV quoting of embedded commas/quotes');
    assert.equal(out.zip, true, 'XLSX has the ZIP magic bytes');
    assert.ok(out.size > 1000, `xlsx too small: ${out.size}`);
    assert.equal(out.keys.length, 17, 'search schema: 16 original columns + isDigital');
  });

  await test('clearing results resets the store', async () => {
    const raw = await ui.evaluate(`(async () => {
      await chrome.runtime.sendMessage({ type: 'CLEAR_RESULTS' });
      return JSON.stringify(await chrome.runtime.sendMessage({ type: 'GET_RESULTS', limit: 10 }));
    })()`);
    const { result } = JSON.parse(raw);
    assert.equal(result.total, 0);
    assert.deepEqual(result.rows, []);
  });

  await test('no uncaught exceptions or console errors in the UI page', () => {
    // Broadcasts with no listener reject by design ("Receiving end does not
    // exist"); the fetch failures below are the sandbox having no egress.
    const real = ui.errors.filter((e) => !/Receiving end does not exist|net::ERR|Failed to load resource/i.test(e));
    assert.deepEqual(real, [], real.join('\n'));
  });

  ui.close();
  await closeTarget(page.targetId);
} catch (err) {
  failures.push({ name: 'live extension load', err });
  console.log(`  \u2717 live extension load\n      ${String(err.message).split('\n').join('\n      ')}`);
} finally {
  if (ui) ui.close();
  chrome.kill('SIGKILL');
  rmSync(profileDir, { recursive: true, force: true });
}

report();

function report() {
  console.log(`\n${failures.length ? '\u2717' : '\u2713'} ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`);
    process.exit(1);
  }
  process.exit(0);
}
