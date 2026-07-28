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
const detailParseSource = readFileSync(path.join(root, 'extension/src/common/detail-parse.js'), 'utf8');
const extractSource = readFileSync(path.join(root, 'extension/src/content/extract.js'), 'utf8');
const extractDetailSource = readFileSync(path.join(root, 'extension/src/content/extract-detail.js'), 'utf8');
const searchFixture = pathToFileURL(path.join(root, 'tests/fixtures/etsy-search-page.html')).href;
const regressionFixture = pathToFileURL(path.join(root, 'tests/fixtures/etsy-search-page-regressions.html')).href;
const listingFixture = pathToFileURL(path.join(root, 'tests/fixtures/etsy-listing-page.html')).href;
const ehuntFixture = pathToFileURL(path.join(root, 'tests/fixtures/etsy-listing-page-ehunt.html')).href;
const ehuntParseSource = readFileSync(path.join(root, 'extension/src/common/ehunt-parse.js'), 'utf8');
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

  // -------------------------------------------------- listing (deep) parser
  {
    const { session, targetId } = await openPage(listingFixture);
    await session.evaluate(parseSource);
    await session.evaluate(detailParseSource);

    const raw = await session.evaluate(`JSON.stringify(EtsyDetail.parseListingPage({
      html: document.documentElement.outerHTML,
      doc: document,
      context: { listingId: '1544102938', scrapeReviews: true, maxReviews: 20,
                 scrapedAt: '2026-05-13T04:35:22Z' }
    }))`);
    const parsed = JSON.parse(raw);
    const d = parsed.record;

    await test('extracts the listing core', () => {
      assert.ok(d, 'no record returned');
      assert.equal(d.listingId, '1544102938');
      assert.equal(d.title, '2026 Calendar Printable, Minimalist Wall Calendar Digital Download');
      assert.match(d.description, /Instant download 2026 wall calendar/);
      assert.equal(d.price, 9.6);
      assert.equal(d.currency, 'USD');
      assert.equal(d.originalPrice, 12);
      assert.equal(d.onSale, true);
      assert.equal(d.availability, 'InStock');
      assert.equal(d.categoryPath, 'Home & Living > Office > Calendars & Planners');
      assert.equal(d.listingCreationDate, '2026-01-12');
      assert.equal(d.imageCount, 3, 'DOM carousel wins over the 2 JSON-LD images');
      assert.equal(d.detailSource, 'jsonld+dom');
    });

    await test('extracts sales-velocity signals', () => {
      assert.equal(d.favoritesCount, 1482);
      assert.equal(d.cartCount, 20);
      assert.equal(d.quantityAvailable, 4);
      assert.equal(d.viewsCount, null, 'Etsy does not publish view counts — must stay null');
    });

    await test('extracts monetisation structure', () => {
      assert.equal(d.variations.length, 2);
      assert.deepEqual(d.variations[0], { name: 'Size', options: ['A4', 'A3', 'US Letter'] });
      assert.deepEqual(d.variations[1].options, ['Black & White', 'Sage']);
      assert.equal(d.variationCount, 6, '3 sizes x 2 colours');
      assert.equal(d.isPersonalizable, true);
      assert.equal(d.personalizationRequired, true);
      assert.deepEqual(d.materials, ['Recycled paper', 'Archival ink']);
    });

    await test('extracts the SEO surface from both link shapes', () => {
      assert.ok(d.tags.includes('2026 calendar'));
      assert.ok(d.tags.includes('printable calendar'));
      assert.ok(d.tags.includes('wall calendar'), 'search-style tag chips included');
      assert.ok(d.tags.includes('canva template'));
      assert.ok(!d.tags.some((t) => /see more/i.test(t)), 'navigation links excluded');
      assert.equal(d.tagCount, 6, 'duplicates collapse case-insensitively');
      assert.ok(d.tagCount <= 13, 'never exceeds Etsy\'s own tag limit');
    });

    await test('caps tags at 13 however many links exist', async () => {
      const capped = await session.evaluate(`(() => {
        const html = '<html><body>' + Array.from({length: 30},
          (_, i) => '<a href="/market/tag' + i + '">tag ' + i + '</a>').join('') + '</body></html>';
        const doc = new DOMParser().parseFromString(html, 'text/html');
        return EtsyDetail.readTags(doc).length;
      })()`);
      assert.equal(capped, 13);
    });

    await test('extracts seller authority incl. shop age', () => {
      assert.equal(d.shopName, 'PaperMoonStudioCo');
      assert.equal(d.shopUrl, 'https://www.etsy.com/shop/PaperMoonStudioCo');
      assert.equal(d.shopTotalSales, 12345);
      assert.equal(d.isStarSeller, true);
      assert.equal(d.shopLocation, 'Portland, Oregon');
      assert.equal(d.shopMemberSince, 2019);
      assert.equal(d.rating, 4.9);
      assert.equal(d.reviewCount, 128);
    });

    await test('detects genuine free shipping', () => {
      assert.equal(d.freeShipping, true);
    });

    await test('ignores conditional shop-wide free-shipping promotions', async () => {
      const results = JSON.parse(await session.evaluate(`(() => {
        const check = (body) => {
          const doc = new DOMParser().parseFromString('<html><body>' + body + '</body></html>', 'text/html');
          return EtsyDetail.readFreeShipping(doc, doc.body.textContent);
        };
        return JSON.stringify({
          promo: check('<p>Free shipping on orders over $35</p>'),
          spend: check('<p>Free delivery when you spend $50</p>'),
          genuine: check('<p>Free shipping to United States</p>'),
          zeroCost: check('<p>Cost to ship: FREE</p>'),
          none: check('<p>Shipping: $4.50</p>'),
          bothPresent: check('<p>Free shipping on orders over $35</p><p>Free shipping to Canada</p>')
        });
      })()`));
      assert.equal(results.promo, false, 'a spend threshold is not per-listing free shipping');
      assert.equal(results.spend, false);
      assert.equal(results.genuine, true);
      assert.equal(results.zeroCost, true);
      assert.equal(results.none, false);
      assert.equal(results.bothPresent, true, 'a real line still wins over a promo line');
    });

    await test('description survives Etsy renaming its markup', async () => {
      const out = JSON.parse(await session.evaluate(`(() => {
        const read = (body, head) => {
          const doc = new DOMParser().parseFromString(
            '<html><head>' + (head || '') + '</head><body>' + body + '</body></html>', 'text/html');
          return EtsyDetail.readDescription(doc);
        };
        return JSON.stringify({
          // The current container.
          primary: read('<div data-product-details-description-text-content>Full listing text here.</div>'),
          // Every known selector renamed: must fall back to the meta tags.
          renamed: read('<div class="brand-new-2027-class">Full listing text here.</div>',
            '<meta property="og:description" content="Meta fallback description">'),
          // Collapsed teaser plus the full text: longest must win.
          collapsed: read('<div data-id="description-text">Short teaser…</div>'
            + '<div id="listing-page-description">The complete description with much more detail.</div>'),
          // Container present but holding only the toggle label.
          chromeOnly: read('<div data-id="description-text">Read more</div>'),
          nothing: read('<div>unrelated</div>')
        });
      })()`));
      assert.equal(out.primary, 'Full listing text here.');
      assert.equal(out.renamed, 'Meta fallback description',
        'og:description must rescue a markup rename');
      assert.equal(out.collapsed, 'The complete description with much more detail.',
        'the teaser must not win over the full text');
      assert.equal(out.chromeOnly, null, '"Read more" is not a description');
      assert.equal(out.nothing, null);
    });

        await test('detects a digital listing from the page copy', () => {
      // The main fixture is a printable download.
      assert.equal(d.isDigital, true);
      assert.equal(d.productType, 'Digital');
    });

    await test('the fixture description is the full text, not the JSON-LD summary', () => {
      assert.match(d.description, /Instant download 2026 wall calendar/);
      assert.ok(d.description.length > 40, `suspiciously short: ${d.description}`);
    });

    await test('reads shop age only as a plausible year', async () => {
      const years = JSON.parse(await session.evaluate(`JSON.stringify({
        onEtsy: EtsyDetail.readMemberSince(null, 'On Etsy since 2019'),
        seller: EtsyDetail.readMemberSince(null, 'Etsy seller since 2007'),
        tooEarly: EtsyDetail.readMemberSince(null, 'Established since 1998'),
        future: EtsyDetail.readMemberSince(null, 'since 2099'),
        absent: EtsyDetail.readMemberSince(null, 'no dates here')
      })`));
      assert.equal(years.onEtsy, 2019);
      assert.equal(years.seller, 2007);
      assert.equal(years.tooEarly, null, 'predates Etsy — must be rejected');
      assert.equal(years.future, null);
      assert.equal(years.absent, null);
    });

    await test('captures reviews with ratings, dates and photos', () => {
      assert.equal(parsed.counts.reviews, 3);
      assert.equal(d.reviewsCaptured, 3);
      const [one, two, three] = parsed.reviews;
      assert.equal(one.rating, 5);
      assert.equal(one.date, '2026-03-03');
      assert.equal(one.reviewer, 'quietmornings');
      assert.match(one.comment, /matching\s+weekly planner page/);
      assert.equal(one.photoCount, 1);
      assert.match(one.photos[0], /^https:\/\/i\.etsystatic\.com\//);
      assert.equal(two.photoCount, 0, 'no photo on the second review');
      assert.equal(three.rating, 4, 'the outlier keeps its lower rating');
      assert.equal(three.photoCount, 2);
      assert.equal(one.listingId, '1544102938');
      assert.equal(one.scrapedAt, '2026-05-13T04:35:22Z');
    });

    await test('respects the review cap', async () => {
      const capped = JSON.parse(await session.evaluate(`JSON.stringify(EtsyDetail.parseListingPage({
        html: document.documentElement.outerHTML, doc: document,
        context: { listingId: '1', scrapeReviews: true, maxReviews: 2 }
      }))`));
      assert.equal(capped.reviews.length, 2);
    });

    await test('reviews can be switched off entirely', async () => {
      const none = JSON.parse(await session.evaluate(`JSON.stringify(EtsyDetail.parseListingPage({
        html: document.documentElement.outerHTML, doc: document,
        context: { listingId: '1', scrapeReviews: false }
      }))`));
      assert.deepEqual(none.reviews, []);
      assert.equal(none.record.reviewsCaptured, 0);
      assert.equal(none.record.favoritesCount, 1482, 'the rest of the record is unaffected');
    });

    await test('injected extract-detail.js scrolls, expands and returns the record', async () => {
      await session.evaluate(extractDetailSource);
      const viaContent = JSON.parse(await session.evaluate(`(async () => JSON.stringify(
        await globalThis.__etsyExtractDetail({
          context: { listingId: '1544102938', scrapeReviews: true, maxReviews: 20 },
          scrollPasses: 2, scrollPauseMs: 20, waitForReviewsMs: 500
        })
      ))()`));
      assert.equal(viaContent.record.listingId, '1544102938');
      assert.equal(viaContent.record.favoritesCount, 1482);
      assert.equal(viaContent.reviews.length, 3);
      assert.equal(viaContent.blocked, false);
      assert.ok(viaContent.locationHref.endsWith('etsy-listing-page.html'));
    });

    session.close();
    await closePage(targetId);
  }

  // ------------------------------------- regressions from a real "2026 calendar
  // printable" run: price leaking into rating, shop-name prefixes, shop-level
  // review counts, and badge false positives.
  {
    const { session, targetId } = await openPage(regressionFixture);
    await session.evaluate(parseSource);

    const rows = JSON.parse(await session.evaluate(`JSON.stringify(EtsyParse.parsePage({
      html: document.documentElement.outerHTML, doc: document,
      context: { query: '2026 calendar printable', page: 1 }
    }).records)`));
    const byId = Object.fromEntries(rows.map((r) => [r.listingId, r]));

    await test('price is never reported as a rating', () => {
      const cheap = byId['9001'];
      assert.equal(cheap.price, 2.59);
      assert.equal(cheap.rating, null, 'a $2.59 PDF is not "rated 2.59"');
      // Guard the whole page: no row may echo its price as its rating.
      for (const row of rows) {
        if (row.rating !== null && row.price !== null) {
          assert.notEqual(row.rating, row.price, `rating echoes price on ${row.listingId}`);
        }
      }
    });

    await test('shop names drop the "Designed by" / "By" / "Made by" prefix', () => {
      assert.equal(byId['9001'].shopName, 'TheProductiveCompany');
      assert.equal(byId['9002'].shopName, 'JolieDaily');
      assert.equal(byId['9003'].shopName, 'GroundedGrowStudio');
    });

    await test('a lone "(N)" is taken as the listing count', () => {
      // One card cannot tell a listing count from a shop total; the run-level
      // rule in runner.resolveAmbiguousReviewCounts() settles it using repeats
      // across a shop's listings (covered in tests/verify.mjs).
      assert.equal(byId['9003'].rating, null);
      assert.equal(byId['9003'].reviewCount, 144);
    });

    await test('badges require a badge element, not incidental copy', () => {
      const promo = byId['9004'];
      assert.equal(promo.bestseller, false, '"Bestselling shop" is not a Bestseller badge');
      assert.equal(promo.freeShipping, false, 'a spend-threshold promo is not free shipping');
    });

    await test('genuine ratings, counts and badges still come through', () => {
      const good = byId['9005'];
      assert.equal(good.rating, 4.9);
      assert.equal(good.reviewCount, 103);
      assert.equal(good.bestseller, true);
      assert.equal(good.freeShipping, true);
      assert.equal(good.shopName, 'LoveLaurenJoy');
      assert.equal(good.price, 4.24);
    });

    await test('reads a rating from a stars container with no aria label', () => {
      // Regression: a live run returned rating null on every row because Etsy's
      // cards do not always use a rating input or "out of 5" text.
      const r = byId['9006'];
      assert.equal(r.rating, 4.8, 'rating recovered from the stars container');
      assert.equal(r.price, 2.59);
      assert.notEqual(r.rating, r.price, 'and it is not the price');
      assert.equal(r.reviewCount, 325, 'a single "(N)" is the listing count');
      assert.equal(r.shopName, 'MyPlanPrintable');
      assert.equal(r.isDigital, true);
    });

    await test('the digital label is found inside a longer line too', () => {
      // Regression: badge-only matching kept 12 of ~61 rows on a live page.
      const r = byId['9007'];
      assert.equal(r.isDigital, true, '"Instant Download · Ready in minutes"');
      assert.equal(r.shopName, 'PrintableCo');
      assert.equal(r.rating, null, 'no stars on this card, so still null');
    });

    await test('a price-styled number is still never a rating', () => {
      // The original bug must stay fixed while recall is restored.
      assert.equal(byId['9001'].rating, null);
      assert.equal(byId['9001'].price, 2.59);
      for (const row of rows) {
        if (row.rating !== null && row.price !== null) {
          assert.notEqual(row.rating, row.price, `rating echoes price on ${row.listingId}`);
        }
      }
    });

    await test('two parenthesised numbers stay ambiguous, not guessed', async () => {
      const out = await session.evaluate(`(() => {
        const doc = new DOMParser().parseFromString(
          '<html><body><div data-listing-id="1">'
          + '<a class="listing-link" href="/listing/1/x"></a>'
          + '<p>(144)</p><p>(8,214)</p></div></body></html>', 'text/html');
        return EtsyParse.readReviewCount(doc.querySelector('[data-listing-id]'), false);
      })()`);
      assert.equal(out, null, 'two candidates and no stars: decline rather than pick');
    });

    await test('ratings outside 0-5 are rejected outright', async () => {
      const out = JSON.parse(await session.evaluate(`(() => {
        const mk = (body) => {
          const doc = new DOMParser().parseFromString(
            '<html><body><div data-listing-id="1"><a class="listing-link" href="/listing/1/x"></a>'
            + body + '</div></body></html>', 'text/html');
          return EtsyParse.readRating(doc.querySelector('[data-listing-id]'));
        };
        return JSON.stringify({
          tooHigh: mk('<input name="rating" value="28.30">'),
          negative: mk('<input name="rating" value="-1">'),
          valid: mk('<input name="rating" value="4.8">'),
          ariaOnly: mk('<div aria-label="3.5 out of 5 stars"></div>'),
          none: mk('<span class="wt-text-title-01">$2.59</span>')
        });
      })()`));
      assert.equal(out.tooHigh, null);
      assert.equal(out.negative, null);
      assert.equal(out.valid, 4.8);
      assert.equal(out.ariaOnly, 3.5);
      assert.equal(out.none, null, 'a price-styled number is not a rating');
    });

    session.close();
    await closePage(targetId);
  }

  // ------------------------------------------ EHunt panel on a listing page
  {
    const { session, targetId } = await openPage(ehuntFixture);
    await session.evaluate(parseSource);
    await session.evaluate(detailParseSource);
    await session.evaluate(ehuntParseSource);

    const out = JSON.parse(await session.evaluate(`(() => {
      const scraped = EtsyDetail.parseListingPage({
        html: document.documentElement.outerHTML, doc: document,
        context: { listingId: '4451164796', scrapeReviews: false }
      });
      const panel = EtsyEhunt.parsePanel(document);
      const merged = EtsyEhunt.mergeEhuntRecord(scraped.record, panel);
      return JSON.stringify({ present: EtsyEhunt.isPresent(document), panel, merged });
    })()`));

    await test('finds the EHunt panel in the page DOM', () => {
      assert.equal(out.present, true);
      assert.ok(out.panel, 'panel parsed');
      assert.equal(out.panel.ehuntPanel, true);
    });

    await test('reads all 13 real tags with their search volumes', () => {
      assert.equal(out.panel.tags.length, 13, 'the complete tag set, not a proxy');
      assert.equal(out.panel.tags[0], 'Editable PDF Planner');
      assert.equal(out.panel.tags[12], 'Teacher Planner');
      assert.equal(out.panel.tagVolumes['Editable PDF Planner'], 14800000, '14.8M');
      assert.equal(out.panel.tagVolumes['Activities Calendar'], 656900, '656.9K');
      assert.ok(!out.panel.tags.some((t) => /\(/.test(t)), 'volume suffix stripped from labels');
      assert.equal(out.merged.tagSource, 'ehunt');
      assert.equal(out.merged.tags.length, 13);
    });

    await test('reads the stats table incl. product type', () => {
      assert.equal(out.panel.isDigital, true);
      assert.equal(out.panel.productType, 'Digital');
      assert.equal(out.panel.ehuntEstimatedSales, 68);
      assert.equal(out.panel.ehuntEstimatedRevenue, 51);
      assert.equal(out.panel.ehuntTotalReviews, 7);
      assert.equal(out.panel.ehuntTotalFavorites, 11);
      assert.equal(out.panel.ehuntShopSales, 775);
      assert.equal(out.panel.ehuntReviewRatio, 10.29);
      assert.equal(out.panel.ehuntReleaseDate, '2026-02-02');
    });

    await test('"N/A" stays null instead of becoming zero', () => {
      assert.equal(out.panel.ehuntTotalViews, undefined, 'Total Views was N/A');
      assert.equal(out.panel.ehuntConversionRate, undefined, 'Avg.Conv.Rate was N/A');
      assert.notEqual(out.merged.viewsCount, 0, 'a gap must never be filled with 0');
    });

    await test('the merged record keeps Etsy-observed values', () => {
      assert.equal(out.merged.price, 0.91, 'price still from the page');
      assert.equal(out.merged.isDigital, true);
      assert.match(out.merged.description, /cute and practical/);
      assert.equal(out.merged.listingId, '4451164796');
    });

    await test('a physical listing is labelled physical, not digital', async () => {
      const kind = JSON.parse(await session.evaluate(`(() => {
        const read = (body) => {
          const doc = new DOMParser().parseFromString(
            '<html><body><div data-listing-id="1">' + body + '</div></body></html>', 'text/html');
          const r = EtsyDetail.fromDom(doc);
          return { isDigital: r.isDigital === undefined ? null : r.isDigital, type: r.productType || null };
        };
        return JSON.stringify({
          digital: read('<p>Instant Download</p><p>Digital file type(s): PDF</p>'),
          physical: read('<p>Ships from Portland, Oregon</p><p>Arrives by Feb 20</p>'),
          silent: read('<p>A lovely thing</p>')
        });
      })()`));
      assert.equal(kind.digital.isDigital, true);
      assert.equal(kind.physical.isDigital, false);
      assert.equal(kind.physical.type, 'Physical');
      assert.equal(kind.silent.isDigital, null, 'never guessed when the page is silent');
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
