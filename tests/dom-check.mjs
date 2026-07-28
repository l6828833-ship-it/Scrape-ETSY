/**
 * Browser-side verification of the DOM half of the parser.
 *
 *   node tests/dom-check.mjs
 *
 * Node has no DOMParser, so the listing-card selectors, the merge with JSON-LD
 * and the injected content script (extract.js, including its lazy-load scroll)
 * are exercised in real headless Chrome. Driven over the DevTools Protocol with
 * nothing but the standard library (fetch + the built-in WebSocket in Node 22),
 * because the sandbox has no network access to install a driver.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PORT = 9333 + (process.pid % 500);

const CHROME_CANDIDATES = [
  '/usr/local/bin/chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  process.env.CHROME_PATH,
].filter(Boolean);

const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chromePath) {
  console.log('! headless Chrome not found — skipping DOM checks');
  process.exit(0);
}

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

// ------------------------------------------------------------- CDP plumbing

const profileDir = mkdtempSync(path.join(tmpdir(), 'etsy-scraper-chrome-'));
let chromeStderr = '';
let chromeExit = null;

const chrome = spawn(chromePath, [
  '--headless=new',
  // The sandbox already provides isolation; nested sandboxing cannot start here.
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profileDir}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

chrome.stderr.on('data', (chunk) => {
  // Chrome is very chatty about dbus in containers; keep only useful lines.
  chromeStderr += String(chunk)
    .split('\n')
    .filter((line) => line && !/dbus|Failed to connect to the bus|NameHasOwner/i.test(line))
    .join('\n');
});
chrome.on('exit', (code, signal) => { chromeExit = signal || code; });
chrome.on('error', (err) => { chromeStderr += `spawn error: ${err.message}\n`; });

async function waitForChrome(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (chromeExit !== null) {
      throw new Error(`Chrome exited early (${chromeExit})\n${chromeStderr.trim()}`);
    }
    try {
      // Local loopback only: NO_PROXY covers 127.0.0.1 in proxied environments.
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return res.json();
    } catch (_) { /* not up yet */ }
    await sleep(250);
  }
  throw new Error(`no debugging port on ${PORT} within ${timeoutMs}ms\n${chromeStderr.trim()}`);
}

class Session {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message));
      else entry.resolve(msg.result);
    });
  }

  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP websocket failed')), { once: true });
    });
    return new Session(ws);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate an expression in the page and return its value. */
  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error((d.exception && (d.exception.description || d.exception.value)) || d.text);
    }
    return res.result.value;
  }

  close() {
    try {
      this.ws.close();
    } catch (_) { /* already closed */ }
  }
}

async function openPage(fileUrl) {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(fileUrl)}`, {
    method: 'PUT',
  });
  if (!res.ok) throw new Error(`could not open target: HTTP ${res.status}`);
  const target = await res.json();
  const session = await Session.open(target.webSocketDebuggerUrl);
  const deadline = Date.now() + 15000;
  for (;;) {
    const ready = await session.evaluate('document.readyState');
    if (ready === 'complete') break;
    if (Date.now() > deadline) throw new Error('page did not finish loading');
    await sleep(100);
  }
  return { session, targetId: target.id };
}

async function closePage(targetId) {
  await fetch(`http://127.0.0.1:${PORT}/json/close/${targetId}`).catch(() => {});
}

// --------------------------------------------------------------------- setup

const parseSource = readFileSync(path.join(root, 'extension/src/common/parse.js'), 'utf8');
const extractSource = readFileSync(path.join(root, 'extension/src/content/extract.js'), 'utf8');
const searchFixture = pathToFileURL(path.join(root, 'tests/fixtures/etsy-search-page.html')).href;
const challengeFixture = pathToFileURL(path.join(root, 'tests/fixtures/etsy-challenge-page.html')).href;

let exitCode = 0;
try {
  await waitForChrome();
  console.log(`\nDOM parser in headless Chrome (${path.basename(chromePath)})`);

  // ---------------------------------------------------------- listing cards
  {
    const { session, targetId } = await openPage(searchFixture);
    await session.evaluate(parseSource);

    const result = await session.evaluate(`JSON.stringify(EtsyParse.parsePage({
      html: document.documentElement.outerHTML,
      doc: document,
      context: { query: 'handmade ceramic mug', page: 1, sourceUrl: 'https://www.etsy.com/search?q=handmade+ceramic+mug', scrapedAt: '2026-05-13T04:35:22Z' }
    }))`);
    const parsed = JSON.parse(result);
    const rows = parsed.records;
    const byId = Object.fromEntries(rows.map((r) => [r.listingId, r]));

    await test('finds every listing card in the grid', () => {
      assert.equal(parsed.counts.dom, 4, `dom cards: ${parsed.counts.dom}`);
      assert.equal(parsed.counts.jsonld, 3);
      assert.equal(rows.length, 4, 'DOM-only listing must survive the merge');
      assert.deepEqual(
        rows.map((r) => r.listingId),
        ['1027105561', '1027105562', '1027105563', '1027105564'],
      );
    });

    await test('extracts all fields from a complete card', () => {
      const r = byId['1027105561'];
      assert.equal(r.title, 'Handmade Ceramic Mug, Speckled Stoneware Coffee Cup');
      assert.equal(r.price, 28);
      assert.equal(r.currency, 'USD');
      assert.equal(r.shopName, 'ArtisanPottery');
      assert.equal(r.rating, 4.8);
      assert.equal(r.reviewCount, 342);
      assert.equal(r.freeShipping, true);
      assert.equal(r.sponsored, false);
      assert.equal(r.url, 'https://www.etsy.com/listing/1027105561/handmade-ceramic-mug-speckled-stoneware');
      assert.equal(r.query, 'handmade ceramic mug');
      assert.equal(r.page, 1);
      assert.equal(r.position, 1);
      assert.equal(r.scrapedAt, '2026-05-13T04:35:22Z');
    });

    await test('picks the highest-resolution image from srcset', () => {
      assert.match(byId['1027105561'].image, /il_570xN/);
    });

    await test('normalises protocol-relative image URLs', () => {
      assert.match(byId['1027105562'].image, /^https:\/\/i\.etsystatic\.com\//);
    });

    await test('flags sponsored placements', () => {
      const r = byId['1027105563'];
      assert.equal(r.sponsored, true);
      assert.equal(r.price, 1249.99, 'thousands separator parsed');
      assert.equal(r.shopName, 'KilnAndClayCo', 'shop recovered from the "Ad by" label');
    });

    await test('handles European decimal commas, EUR and bestseller badges', () => {
      const r = byId['1027105564'];
      assert.equal(r.price, 42);
      assert.equal(r.currency, 'EUR');
      assert.equal(r.bestseller, true);
      assert.equal(r.freeShipping, true);
      assert.equal(r.rating, 5);
      assert.equal(r.reviewCount, 1204, 'comma-grouped review count');
      assert.equal(r.shopName, 'CeramicaLisboa');
      assert.equal(r.title, 'Hand Thrown Espresso Cup Set of 2');
    });

    await test('marks records enriched by both strategies', () => {
      assert.equal(byId['1027105561']._source, 'jsonld+dom');
      assert.equal(byId['1027105564']._source, 'dom', 'DOM-only card keeps its source');
    });

    await test('never emits a row without an identifier', () => {
      for (const r of rows) assert.ok(r.listingId || r.url, JSON.stringify(r));
    });

    await test('reports no block and no "no results" state', () => {
      assert.equal(parsed.blocked, false);
      assert.equal(parsed.noResults, false);
    });

    // ------------------------------------------------- injected content script
    await session.evaluate(extractSource);

    await test('injected extract.js scrolls and returns the same rows', async () => {
      const raw = await session.evaluate(`(async () => JSON.stringify(await globalThis.__etsyExtract({
        context: { query: 'mug', page: 2, resultsPerPage: 64 },
        scrollPasses: 2,
        scrollPauseMs: 20
      })))()`);
      const viaContent = JSON.parse(raw);
      assert.equal(viaContent.records.length, 4);
      assert.equal(viaContent.records[0].page, 2);
      assert.equal(viaContent.records[0].position, 65, 'global numbering: (2-1)*64 + 1');
      assert.equal(viaContent.records[0].query, 'mug');
      assert.ok(viaContent.locationHref.endsWith('etsy-search-page.html'));
      assert.equal(viaContent.blocked, false);
    });

    await test('re-injection is idempotent', async () => {
      await session.evaluate(extractSource);
      const ok = await session.evaluate('typeof globalThis.__etsyExtract === "function"');
      assert.equal(ok, true);
    });

    session.close();
    await closePage(targetId);
  }

  // ------------------------------------------------------------ challenge page
  {
    const { session, targetId } = await openPage(challengeFixture);
    await session.evaluate(parseSource);

    await test('challenge page is detected in a live DOM', async () => {
      const raw = await session.evaluate(`JSON.stringify(EtsyParse.parsePage({
        html: document.documentElement.outerHTML, doc: document, context: { query: 'x', page: 1 }
      }))`);
      const parsed = JSON.parse(raw);
      assert.equal(parsed.blocked, true);
      assert.equal(parsed.records.length, 0);
    });

    session.close();
    await closePage(targetId);
  }

  console.log(`\n${failures.length ? '\u2717' : '\u2713'} ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`);
    exitCode = 1;
  }
} catch (err) {
  console.error(`\n\u2717 DOM check could not run: ${err.message}`);
  exitCode = 1;
} finally {
  chrome.kill('SIGKILL');
  rmSync(profileDir, { recursive: true, force: true });
}

process.exit(exitCode);
