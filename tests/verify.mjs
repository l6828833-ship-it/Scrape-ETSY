/**
 * Dependency-free regression harness.
 *
 *   node tests/verify.mjs
 *
 * Covers the parts that run outside a browser DOM:
 *   * URL construction (all input parameters)
 *   * JSON-LD extraction + record normalisation
 *   * price / currency / listing-URL parsing edge cases
 *   * anti-bot detection
 *   * settings validation & clamping
 *   * scheduler + de-duplication logic
 *   * CSV and XLSX serialisation (the .xlsx is validated with Python's zipfile
 *     in tools/check-xlsx.py, invoked by tools/run-checks.sh)
 *
 * The DOM card parser is verified separately in a real browser via
 * tests/dom-check.mjs (Playwright) because Node has no DOMParser.
 */

import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ext = path.join(root, 'extension');

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  \u2717 ${name}\n      ${err.message.split('\n').join('\n      ')}`);
  }
}

function group(name) {
  console.log(`\n${name}`);
}

// parse.js is a classic script: importing it for side effects publishes
// globalThis.EtsyParse, exactly like it does in the offscreen document.
await import(path.join(ext, 'src/common/parse.js'));
const P = globalThis.EtsyParse;
assert.ok(P, 'EtsyParse should be published on globalThis');

const { buildSearchUrl } = await import(path.join(ext, 'src/common/url-builder.js'));
const { DEFAULTS, LIMITS, FIELDS } = await import(path.join(ext, 'src/common/constants.js'));

const searchHtml = readFileSync(path.join(root, 'tests/fixtures/etsy-search-page.html'), 'utf8');
const challengeHtml = readFileSync(path.join(root, 'tests/fixtures/etsy-challenge-page.html'), 'utf8');

// --------------------------------------------------------------- url builder

group('URL builder');

await test('builds a minimal page-1 URL', () => {
  const url = new URL(buildSearchUrl({ query: 'handmade ceramic mug' }));
  assert.equal(url.origin + url.pathname, 'https://www.etsy.com/search');
  assert.equal(url.searchParams.get('q'), 'handmade ceramic mug');
  assert.equal(url.searchParams.get('page'), null, 'page is omitted on page 1');
  assert.equal(url.searchParams.get('order'), null, 'default sort is omitted');
});

await test('applies every optional parameter', () => {
  const url = new URL(buildSearchUrl({
    query: 'linen apron',
    page: 7,
    sortOrder: 'price_asc',
    minPrice: 10,
    maxPrice: 49.99,
    shipTo: 'de',
    freeShippingOnly: true,
  }));
  assert.equal(url.searchParams.get('page'), '7');
  assert.equal(url.searchParams.get('order'), 'price_asc');
  assert.equal(url.searchParams.get('min'), '10');
  assert.equal(url.searchParams.get('min_price'), '10');
  assert.equal(url.searchParams.get('max'), '49.99');
  assert.equal(url.searchParams.get('ship_to'), 'DE');
  assert.equal(url.searchParams.get('free_shipping'), 'true');
  assert.equal(url.searchParams.get('ref'), 'pagination');
});

await test('encodes special characters in the keyword', () => {
  const url = buildSearchUrl({ query: 'mug & cup "gift" 100%' });
  assert.match(url, /q=mug\+%26\+cup\+%22gift%22\+100%25/);
  assert.equal(new URL(url).searchParams.get('q'), 'mug & cup "gift" 100%');
});

await test('ignores unknown sort orders and blank filters', () => {
  const url = new URL(buildSearchUrl({ query: 'x', sortOrder: 'nope', minPrice: '', maxPrice: null, shipTo: '  ' }));
  assert.equal(url.searchParams.get('order'), null);
  assert.equal(url.searchParams.get('min'), null);
  assert.equal(url.searchParams.get('ship_to'), null);
});

await test('bestsellerOnly adds the is_best_seller facet plus explicit=1', () => {
  const url = new URL(buildSearchUrl({ query: '2026 calendar printable', bestsellerOnly: true }));
  assert.equal(url.searchParams.get('q'), '2026 calendar printable');
  assert.equal(url.searchParams.get('is_best_seller'), 'true');
  assert.equal(url.searchParams.get('explicit'), '1');
});

await test('free shipping and bestseller facets combine', () => {
  const url = new URL(buildSearchUrl({
    query: 'linen apron', bestsellerOnly: true, freeShippingOnly: true, minPrice: 20,
  }));
  assert.equal(url.searchParams.get('is_best_seller'), 'true');
  assert.equal(url.searchParams.get('free_shipping'), 'true');
  assert.equal(url.searchParams.get('min'), '20');
  assert.equal(url.searchParams.get('explicit'), '1');
});

await test('explicit=1 is omitted when no facet is active', () => {
  const url = new URL(buildSearchUrl({ query: 'mug' }));
  assert.equal(url.searchParams.get('explicit'), null);
  assert.equal(url.searchParams.get('is_best_seller'), null);
});

await test('rejects an empty query', () => {
  assert.throws(() => buildSearchUrl({ query: '   ' }), /query.*required/i);
});

// ------------------------------------------------------------------- prices

group('Price and currency parsing');

await test('parses the common currency formats', () => {
  assert.equal(P.parsePrice('$28.00'), 28);
  assert.equal(P.parsePrice('28.00'), 28);
  assert.equal(P.parsePrice('$1,249.99'), 1249.99);
  assert.equal(P.parsePrice('1.249,99 €'), 1249.99);
  assert.equal(P.parsePrice('42,00'), 42);
  assert.equal(P.parsePrice('1 234,56 kr'), 1234.56);
  assert.equal(P.parsePrice('USD 19.50'), 19.5);
  assert.equal(P.parsePrice('$28.00+'), 28, 'price ranges keep the lower bound');
  assert.equal(P.parsePrice(''), null);
  assert.equal(P.parsePrice(null), null);
  assert.equal(P.parsePrice('Free'), null);
  assert.equal(P.parsePrice(19.5), 19.5);
});

await test('maps symbols to ISO currency codes', () => {
  assert.equal(P.currencyFromSymbol('$'), 'USD');
  assert.equal(P.currencyFromSymbol('€'), 'EUR');
  assert.equal(P.currencyFromSymbol('£'), 'GBP');
  assert.equal(P.currencyFromSymbol('CA$'), 'CAD');
  assert.equal(P.currencyFromSymbol('JPY'), 'JPY');
  assert.equal(P.currencyFromSymbol(''), null);
});

await test('extracts listing ids and strips tracking params', () => {
  assert.equal(P.listingIdFromUrl('https://www.etsy.com/listing/1027105561/foo?click_key=x'), '1027105561');
  assert.equal(P.listingIdFromUrl('/listing/999/bar'), '999');
  assert.equal(P.listingIdFromUrl('https://www.etsy.com/shop/Foo'), null);
  assert.equal(
    P.cleanListingUrl('/listing/1027105561/handmade-ceramic-mug?ref=search_grid-1&click_key=a'),
    'https://www.etsy.com/listing/1027105561/handmade-ceramic-mug',
  );
  assert.equal(
    P.cleanListingUrl('//www.etsy.com/listing/42/x?y=1'),
    'https://www.etsy.com/listing/42/x',
  );
});

// -------------------------------------------------------------- JSON-LD path

group('JSON-LD extraction');

await test('finds the ItemList block in the fixture', () => {
  const blocks = P.extractJsonLdBlocks(searchHtml);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]['@type'], 'ItemList');
  assert.equal(blocks[0].itemListElement.length, 3);
});

await test('produces normalised records from JSON-LD', () => {
  const records = P.recordsFromJsonLd(searchHtml);
  assert.equal(records.length, 3);

  const first = records[0];
  assert.equal(first.listingId, '1027105561');
  assert.equal(first.title, 'Handmade Ceramic Mug, Speckled Stoneware Coffee Cup');
  assert.equal(first.price, 28);
  assert.equal(first.currency, 'USD');
  assert.equal(first.shopName, 'ArtisanPottery');
  assert.equal(first.rating, 4.8);
  assert.equal(first.reviewCount, 342);
  assert.equal(first.position, 1);
  assert.equal(first.url, 'https://www.etsy.com/listing/1027105561/handmade-ceramic-mug-speckled-stoneware');
  assert.match(first.image, /^https:\/\/i\.etsystatic\.com\//);

  assert.equal(records[1].price, 19.5, 'falls back to offers.lowPrice');
  assert.equal(records[2].price, 1249.99, 'handles thousands separators');
});

await test('handles @graph, arrays and bare Product shapes', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'BreadcrumbList', itemListElement: [] },
      {
        '@type': 'Product',
        name: 'Solo Product',
        url: 'https://www.etsy.com/listing/555/solo',
        offers: { '@type': 'Offer', price: 12.34, priceCurrency: 'GBP' },
      },
    ],
  })}</script>`;
  const records = P.recordsFromJsonLd(html);
  assert.equal(records.length, 1);
  assert.equal(records[0].listingId, '555');
  assert.equal(records[0].price, 12.34);
  assert.equal(records[0].currency, 'GBP');
});

await test('survives malformed JSON-LD without throwing', () => {
  const records = P.recordsFromJsonLd('<script type="application/ld+json">{not json,,,}</script>');
  assert.deepEqual(records, []);
});

await test('finalize() emits the documented output schema', () => {
  const [record] = P.recordsFromJsonLd(searchHtml);
  const row = P.finalize(record, 0, {
    query: 'handmade ceramic mug',
    page: 1,
    sourceUrl: 'https://www.etsy.com/search?q=handmade+ceramic+mug',
    scrapedAt: '2026-05-13T04:35:22Z',
    resultsPerPage: 0,
  });
  for (const field of FIELDS) {
    assert.ok(Object.prototype.hasOwnProperty.call(row, field), `missing field: ${field}`);
  }
  assert.equal(row.query, 'handmade ceramic mug');
  assert.equal(row.page, 1);
  assert.equal(row.position, 1);
  assert.equal(row.scrapedAt, '2026-05-13T04:35:22Z');
  assert.equal(row.freeShipping, false, 'booleans are never null');
  assert.equal(row.sponsored, false);
  assert.equal(typeof row.bestseller, 'boolean');
});

await test('global position numbering offsets by page', () => {
  const row = P.finalize({ listingId: '1', position: 4 }, 3, { page: 3, resultsPerPage: 64 });
  assert.equal(row.position, 132, '(3-1)*64 + 4');
});

// ---------------------------------------------------------------- merge path

group('Record merging');

await test('JSON-LD fills gaps left by the DOM without overwriting it', () => {
  const dom = [{ listingId: '1', title: 'DOM title', price: null, sponsored: true, position: 2, _source: 'dom' }];
  const jsonld = [{ listingId: '1', title: 'LD title', price: 9.99, currency: 'USD', position: 1, _source: 'jsonld' }];
  const [merged] = P.mergeRecords(dom, jsonld);
  assert.equal(merged.title, 'DOM title', 'DOM wins where both have a value');
  assert.equal(merged.price, 9.99, 'JSON-LD fills the missing price');
  assert.equal(merged.currency, 'USD');
  assert.equal(merged.sponsored, true);
  assert.equal(merged._source, 'jsonld+dom');
});

await test('keeps records that only one strategy saw', () => {
  const merged = P.mergeRecords(
    [{ listingId: 'only-dom', title: 'a' }],
    [{ listingId: 'only-ld', title: 'b' }],
  );
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((r) => r.listingId), ['only-dom', 'only-ld']);
});

// ------------------------------------------------------------ block handling

group('Anti-bot detection');

await test('flags a challenge page', () => {
  const res = P.detectBlock(challengeHtml);
  assert.equal(res.blocked, true);
  assert.ok(res.reason);
});

await test('does not flag a normal results page', () => {
  assert.equal(P.detectBlock(searchHtml).blocked, false);
});

await test('parsePage reports blocked pages and yields no rows', () => {
  const result = P.parsePage({ html: challengeHtml, context: { query: 'x', page: 1 } });
  assert.equal(result.blocked, true);
  assert.equal(result.records.length, 0);
});

await test('recognises a genuine "no results" page', () => {
  assert.equal(P.looksLikeNoResults('<h1>We couldn\'t find any results</h1>'), true);
  assert.equal(P.looksLikeNoResults(searchHtml), false);
});

await test('parsePage works with HTML only (worker fallback, no DOM)', () => {
  const result = P.parsePage({ html: searchHtml, context: { query: 'mug', page: 2 } });
  assert.equal(result.counts.jsonld, 3);
  assert.equal(result.counts.dom, 0, 'no DOM available in Node');
  assert.equal(result.records.length, 3);
  assert.equal(result.records[0].page, 2);
  assert.equal(result.records[0].query, 'mug');
});

// -------------------------------------------------------- settings + runner

group('Settings validation');

const { normalizeSettings } = await import(path.join(ext, 'src/background/store.js'));

await test('clamps out-of-range numbers to the documented limits', () => {
  const s = normalizeSettings({
    queries: [' mug ', '', 'apron'],
    maxPagesPerQuery: 9999,
    maxConcurrency: 0,
    maxRequestRetries: -3,
    minDelayMs: -100,
    maxDelayMs: 10,
  });
  assert.deepEqual(s.queries, ['mug', 'apron']);
  assert.equal(s.maxPagesPerQuery, LIMITS.maxPagesPerQuery);
  assert.equal(s.maxConcurrency, 1);
  assert.equal(s.maxRequestRetries, 0);
  assert.equal(s.minDelayMs, 0);
  assert.ok(s.maxDelayMs >= s.minDelayMs);
});

await test('accepts a newline-delimited query string', () => {
  const s = normalizeSettings({ queries: 'mug\n\n  apron  \ncandle' });
  assert.deepEqual(s.queries, ['mug', 'apron', 'candle']);
});

await test('falls back to defaults for invalid enums', () => {
  const s = normalizeSettings({ sortOrder: 'cheapest', engine: 'magic', dedupe: 'maybe' });
  assert.equal(s.sortOrder, DEFAULTS.sortOrder);
  assert.equal(s.engine, DEFAULTS.engine);
  assert.equal(s.dedupe, DEFAULTS.dedupe);
});

await test('normalises prices and country codes', () => {
  const s = normalizeSettings({ minPrice: '10', maxPrice: '', shipTo: 'usa' });
  assert.equal(s.minPrice, 10);
  assert.equal(s.maxPrice, null);
  assert.equal(s.shipTo, 'US');
});

await test('coerces the filter flags to real booleans', () => {
  const s = normalizeSettings({ bestsellerOnly: 'on', excludeSponsored: 1, freeShippingOnly: null });
  assert.equal(s.bestsellerOnly, true);
  assert.equal(s.excludeSponsored, true);
  assert.equal(s.freeShippingOnly, false);
  const d = normalizeSettings({});
  assert.equal(d.bestsellerOnly, false);
  assert.equal(d.excludeSponsored, false);
});

group('Scheduler and de-duplication');

const { __testing: runnerTesting } = await import(path.join(ext, 'src/background/runner.js'));

await test('scheduler round-robins queries and respects the page cap', () => {
  const s = new runnerTesting.Scheduler(['a', 'b'], 2);
  const order = [];
  for (let i = 0; i < 5; i += 1) {
    const t = s.next();
    if (!t) break;
    order.push(`${t.query}${t.page}`);
  }
  assert.deepEqual(order, ['a1', 'b1', 'a2', 'b2']);
  assert.equal(s.next(), null);
});

await test('scheduler stops a query early when asked', () => {
  const s = new runnerTesting.Scheduler(['a', 'b'], 5);
  const first = s.next();
  s.markDone(first.queueIndex, 'empty page');
  const rest = [];
  for (let i = 0; i < 6; i += 1) {
    const t = s.next();
    if (!t) break;
    rest.push(`${t.query}${t.page}`);
  }
  assert.ok(!rest.some((x) => x.startsWith('a')), 'query "a" must not be scheduled again');
  assert.equal(s.markDone(first.queueIndex), false, 'markDone is idempotent');
});

await test('dedupe per_query keeps the same listing across different queries', () => {
  const d = new runnerTesting.Dedupe('per_query');
  const rows = [{ listingId: '1' }, { listingId: '2' }, { listingId: '1' }];
  const a = d.filter(rows, 'mug');
  assert.equal(a.kept.length, 2);
  assert.equal(a.duplicates, 1);
  const b = d.filter([{ listingId: '1' }], 'apron');
  assert.equal(b.kept.length, 1, 'other query gets its own namespace');
});

group('Ad exclusion');

await test('excludeSponsored drops sponsored rows and counts them', () => {
  const rows = [
    { listingId: '1', sponsored: false },
    { listingId: '2', sponsored: true },
    { listingId: '3', sponsored: false },
    { listingId: '4', sponsored: true },
  ];
  const out = runnerTesting.applyRowFilters(rows, { excludeSponsored: true });
  assert.deepEqual(out.rows.map((r) => r.listingId), ['1', '3']);
  assert.equal(out.adsSkipped, 2);
});

await test('rows pass through untouched when the option is off', () => {
  const rows = [{ listingId: '1', sponsored: true }, { listingId: '2', sponsored: false }];
  const out = runnerTesting.applyRowFilters(rows, { excludeSponsored: false });
  assert.equal(out.rows.length, 2);
  assert.equal(out.adsSkipped, 0);
  assert.equal(runnerTesting.applyRowFilters(rows, undefined).rows.length, 2);
});

await test('bestsellerOnly does not filter rows locally (facet does the work)', () => {
  // Badge detection is best-effort; filtering locally too would drop good rows.
  const rows = [{ listingId: '1', bestseller: false }, { listingId: '2', bestseller: true }];
  const out = runnerTesting.applyRowFilters(rows, { bestsellerOnly: true });
  assert.equal(out.rows.length, 2);
});

await test('a page of nothing but ads still yields zero rows without erroring', () => {
  const out = runnerTesting.applyRowFilters(
    [{ listingId: '1', sponsored: true }], { excludeSponsored: true },
  );
  assert.deepEqual(out.rows, []);
  assert.equal(out.adsSkipped, 1);
});

group('Scheduler and de-duplication (continued)');

await test('dedupe global collapses across queries; off keeps everything', () => {
  const g = new runnerTesting.Dedupe('global');
  g.filter([{ listingId: '1' }], 'mug');
  assert.equal(g.filter([{ listingId: '1' }], 'apron').duplicates, 1);

  const off = new runnerTesting.Dedupe('off');
  assert.equal(off.filter([{ listingId: '1' }, { listingId: '1' }], 'mug').kept.length, 2);
});

// ------------------------------------------------- deep scrape: JSON-LD layer

group('Listing detail parser (JSON-LD layer)');

await import(path.join(ext, 'src/common/detail-parse.js'));
const D = globalThis.EtsyDetail;
const listingHtml = readFileSync(path.join(root, 'tests/fixtures/etsy-listing-page.html'), 'utf8');
const { DETAIL_FIELDS, REVIEW_FIELDS } = await import(path.join(ext, 'src/common/constants.js'));

await test('reads the Product node', () => {
  const ld = D.fromJsonLd(listingHtml);
  assert.equal(ld.listingId, '1544102938');
  assert.equal(ld.title, '2026 Calendar Printable, Minimalist Wall Calendar Digital Download');
  assert.match(ld.description, /^Instant download 2026 wall calendar/);
  assert.equal(ld.price, 9.6);
  assert.equal(ld.currency, 'USD');
  assert.equal(ld.availability, 'InStock');
  assert.equal(ld.rating, 4.9);
  assert.equal(ld.reviewCount, 128);
  assert.equal(ld.shopName, 'PaperMoonStudioCo');
  assert.equal(ld.imageCount, 2);
  assert.equal(ld.url, 'https://www.etsy.com/listing/1544102938/2026-calendar-printable-minimalist',
    'tracking params stripped');
});

await test('reads the breadcrumb category path', () => {
  const ld = D.fromJsonLd(listingHtml);
  assert.equal(ld.categoryPath, 'Home & Living > Office > Calendars & Planners');
});

await test('detail records always carry the documented schema', () => {
  const record = D.finalizeDetail(D.fromJsonLd(listingHtml), {}, {
    scrapedAt: '2026-05-13T04:35:22Z',
  }, []);
  for (const field of DETAIL_FIELDS) {
    if (['firstScrapedAt', 'lastScrapedAt', 'snapshotCount', 'daysTracked', 'daysSinceListed',
      'favoritesDelta', 'favoritesPerDay', 'favoritesPerDayLifetime', 'reviewsDelta',
      'reviewsPerDay', 'demandScore', 'momentumScore', 'competitiveGapScore',
      'opportunityScore'].includes(field)) continue; // added later by metrics
    assert.ok(Object.prototype.hasOwnProperty.call(record, field), `missing field: ${field}`);
  }
  assert.equal(record.isPersonalizable, false, 'booleans never null');
  assert.equal(record.starSeller, false);
  assert.equal(record.reviewsCaptured, 0);
  assert.equal(record.scrapedAt, '2026-05-13T04:35:22Z');
});

await test('a blocked listing page yields no record', () => {
  const out = D.parseListingPage({ html: challengeHtml, context: { listingId: '1' } });
  assert.equal(out.blocked, true);
  assert.equal(out.record, null);
  assert.deepEqual(out.reviews, []);
});

await test('parses ISO and human dates, ignores nonsense', () => {
  assert.equal(D.toIsoDate('Jan 12, 2026'), '2026-01-12');
  assert.equal(D.toIsoDate('2026-01-12T10:00:00Z'), '2026-01-12');
  assert.equal(D.toIsoDate('sometime last spring'), null);
  assert.equal(D.toIsoDate(''), null);
});

// -------------------------------------------------------- trend metrics

group('Trend metrics');

const metrics = await import(path.join(ext, 'src/common/metrics.js'));
const DAY = 86400000;
const T0 = Date.parse('2026-05-01T00:00:00Z');

await test('a single observation cannot produce a velocity', () => {
  const m = metrics.summarizeHistory([{ ts: T0, favorites: 100, reviewCount: 4 }], { now: T0 });
  assert.equal(m.snapshotCount, 1);
  assert.equal(m.favoritesDelta, null, 'unknown, not zero');
  assert.equal(m.favoritesPerDay, null);
  assert.equal(m.firstScrapedAt, '2026-05-01T00:00:00Z');
});

await test('computes delta and per-day rate across a day', () => {
  const m = metrics.summarizeHistory([
    { ts: T0, favorites: 100, reviewCount: 4 },
    { ts: T0 + DAY, favorites: 115, reviewCount: 6 },
  ], { now: T0 + DAY });
  assert.equal(m.favoritesDelta, 15);
  assert.equal(m.favoritesPerDay, 15);
  assert.equal(m.reviewsDelta, 2);
  assert.equal(m.reviewsPerDay, 2);
  assert.equal(m.daysTracked, 1);
  assert.equal(m.snapshotCount, 2);
});

await test('halves the rate when the same gain took two days', () => {
  const m = metrics.summarizeHistory([
    { ts: T0, favorites: 100 },
    { ts: T0 + 2 * DAY, favorites: 115 },
  ], { now: T0 + 2 * DAY });
  assert.equal(m.favoritesPerDay, 7.5);
});

await test('ignores intervals too short to be meaningful', () => {
  // Two scrapes minutes apart must not manufacture a growth rate.
  const m = metrics.summarizeHistory([
    { ts: T0, favorites: 100 },
    { ts: T0 + 60000, favorites: 101 },
  ], { now: T0 + 60000 });
  assert.equal(m.favoritesDelta, null);
  assert.equal(m.favoritesPerDay, null);
  assert.equal(m.snapshotCount, 2, 'the snapshot is still retained');
});

await test('skips back to the newest usable snapshot', () => {
  const m = metrics.summarizeHistory([
    { ts: T0, favorites: 100 },
    { ts: T0 + DAY, favorites: 130 },
    { ts: T0 + DAY + 60000, favorites: 131 },
  ], { now: T0 + DAY + 60000 });
  assert.equal(m.favoritesDelta, 31, 'compares against T0, not the 1-minute-old snapshot');
});

await test('lifetime rate uses the listing age when known', () => {
  const m = metrics.summarizeHistory([{ ts: T0, favorites: 300 }], {
    listedAt: '2026-04-01',
    now: T0,
  });
  assert.equal(m.daysSinceListed, 30);
  assert.equal(m.favoritesPerDayLifetime, 10);
});

await test('missing favourite counts do not fabricate deltas', () => {
  const m = metrics.summarizeHistory([
    { ts: T0, favorites: null },
    { ts: T0 + DAY, favorites: 115 },
  ], { now: T0 + DAY });
  assert.equal(m.favoritesDelta, null);
});

await test('empty history is all nulls, not zeros', () => {
  const m = metrics.summarizeHistory([]);
  assert.equal(m.snapshotCount, 0);
  assert.equal(m.firstScrapedAt, null);
  assert.equal(m.favoritesPerDay, null);
  assert.equal(m.daysTracked, null);
});

await test('scores stay within 0-100 and reward price with low competition', () => {
  const cheapCrowded = metrics.computeScores({ price: 5, reviewCount: 1800, favoritesCount: 50 });
  const pricyQuiet = metrics.computeScores({ price: 120, reviewCount: 3, favoritesCount: 50 });
  assert.ok(pricyQuiet.competitiveGapScore > cheapCrowded.competitiveGapScore,
    `${pricyQuiet.competitiveGapScore} should beat ${cheapCrowded.competitiveGapScore}`);
  for (const v of Object.values(pricyQuiet)) {
    if (v === null) continue;
    assert.ok(v >= 0 && v <= 100, `score out of range: ${v}`);
  }
});

await test('momentum dominates when a listing is climbing fast', () => {
  const slow = metrics.computeScores({ price: 20, reviewCount: 50, favoritesCount: 100, favoritesPerDay: 0 });
  const rocket = metrics.computeScores({ price: 20, reviewCount: 50, favoritesCount: 100, favoritesPerDay: 15 });
  assert.ok(rocket.opportunityScore > slow.opportunityScore);
  assert.equal(slow.momentumScore, 0, 'a measured zero is 0, not null');
});

await test('unknown momentum re-weights instead of scoring zero', () => {
  const unknown = metrics.computeScores({ price: 20, reviewCount: 50, favoritesCount: 100 });
  const zero = metrics.computeScores({ price: 20, reviewCount: 50, favoritesCount: 100, favoritesPerDay: 0 });
  assert.equal(unknown.momentumScore, null);
  assert.ok(unknown.opportunityScore > zero.opportunityScore,
    'never observed should not be penalised like observed-no-growth');
});

await test('scores are null when their inputs are missing', () => {
  const s = metrics.computeScores({});
  assert.equal(s.demandScore, null);
  assert.equal(s.competitiveGapScore, null);
  assert.equal(s.opportunityScore, null);
});

await test('applyMetrics merges history and scores onto a detail record', () => {
  const detail = {
    listingId: '1', price: 40, reviewCount: 10, favoritesCount: 500,
    listingCreationDate: '2026-04-01',
  };
  const merged = metrics.applyMetrics(detail, [
    { ts: T0, favorites: 480 },
    { ts: T0 + DAY, favorites: 500 },
  ], { now: T0 + DAY });
  assert.equal(merged.listingId, '1');
  assert.equal(merged.favoritesDelta, 20);
  assert.equal(merged.favoritesPerDay, 20);
  assert.ok(merged.opportunityScore > 0);
  assert.equal(merged.daysSinceListed, 31, 'Apr 1 -> May 2');
});

await test('snapshotFromDetail keeps only the tracked numbers', () => {
  const s = metrics.snapshotFromDetail({
    favoritesCount: 10, reviewCount: 2, price: 9.6, quantityAvailable: 4, title: 'x',
  }, T0);
  assert.deepEqual(s, { ts: T0, favorites: 10, reviewCount: 2, price: 9.6, quantity: 4 });
  const empty = metrics.snapshotFromDetail({}, T0);
  assert.equal(empty.favorites, null);
});

// ------------------------------------------------------------------- exports

group('Exports');

const { toCsv, toJson, toJsonl, toXlsx, pickFields } = await import(path.join(ext, 'src/ui/export.js'));
const { __testing: xlsxTesting } = await import(path.join(ext, 'src/ui/xlsx.js'));

const sampleRows = P.parsePage({ html: searchHtml, context: { query: 'handmade ceramic mug', page: 1, scrapedAt: '2026-05-13T04:35:22Z' } }).records;

await test('CSV has a header plus one line per row, in field order', async () => {
  const blob = toCsv(sampleRows);
  // Blob.text() performs a UTF-8 decode, which strips the BOM — check bytes.
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.deepEqual([bytes[0], bytes[1], bytes[2]], [0xef, 0xbb, 0xbf], 'UTF-8 BOM present for Excel');

  const text = await blob.text();
  const lines = text.replace(/^\ufeff/, '').trim().split('\r\n');
  assert.equal(lines[0], FIELDS.join(','));
  assert.equal(lines.length, sampleRows.length + 1);
  assert.equal(new Uint8Array(await toCsv(sampleRows, { bom: false }).arrayBuffer())[0], 0x71, 'bom:false starts at "q"');
});

await test('CSV quotes separators, quotes and newlines', async () => {
  const text = await toCsv([{ ...sampleRows[0], title: 'Mug, "large"\nblue', shopName: 'A' }]).text();
  const body = text.replace(/^\ufeff/, '').split('\r\n')[1];
  assert.ok(body.includes('"Mug, ""large""\nblue"'), `unexpected CSV body: ${body}`);
});

await test('CSV neutralises formula injection', async () => {
  const text = await toCsv([{ ...sampleRows[0], title: '=HYPERLINK("http://evil")' }]).text();
  assert.ok(text.includes('"\'=HYPERLINK'), 'leading = must be escaped');
});

await test('JSON export contains only schema fields by default', async () => {
  const parsed = JSON.parse(await toJson(sampleRows).text());
  assert.equal(parsed.length, sampleRows.length);
  assert.deepEqual(Object.keys(parsed[0]), FIELDS);
  const withDebug = JSON.parse(await toJson(sampleRows, { includeDebug: true }).text());
  assert.ok('_source' in withDebug[0]);
});

await test('JSONL emits one object per line', async () => {
  const text = await toJsonl(sampleRows).text();
  const lines = text.trim().split('\n');
  assert.equal(lines.length, sampleRows.length);
  assert.equal(JSON.parse(lines[0]).listingId, sampleRows[0].listingId);
});

await test('pickFields fills missing keys with null', () => {
  const { rows } = pickFields([{ listingId: 'x' }]);
  assert.equal(rows[0].title, null);
  assert.equal(Object.keys(rows[0]).length, FIELDS.length);
});

await test('XLSX is a non-trivial ZIP starting with PK', async () => {
  const blob = toXlsx(sampleRows);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.equal(bytes[0], 0x50);
  assert.equal(bytes[1], 0x4b);
  assert.ok(bytes.length > 1200, `unexpectedly small workbook: ${bytes.length} bytes`);
  mkdirSync(path.join(root, 'tests/out'), { recursive: true });
  writeFileSync(path.join(root, 'tests/out/sample.xlsx'), bytes);
});

await test('XLSX cell serialisation covers strings, numbers, booleans, blanks', () => {
  const x = xlsxTesting;
  const xml = x.sheetXml(['a', 'b', 'c', 'd'], [{ a: 'text', b: 12.5, c: true, d: null }]);
  assert.ok(xml.includes('<c r="A2" t="inlineStr"><is><t xml:space="preserve">text</t></is></c>'));
  assert.ok(xml.includes('<c r="B2"><v>12.5</v></c>'));
  assert.ok(xml.includes('<c r="C2" t="b"><v>1</v></c>'));
  assert.ok(xml.includes('<c r="D2"/>'));
  assert.equal(x.colName(0), 'A');
  assert.equal(x.colName(25), 'Z');
  assert.equal(x.colName(26), 'AA');
  assert.ok(x.sheetXml(['a'], []).includes('<autoFilter'));
});

await test('XLSX escapes XML metacharacters in values', () => {
  const x = xlsxTesting;
  const xml = x.sheetXml(['t'], [{ t: 'Mug & <Cup> "x"' }]);
  assert.ok(xml.includes('Mug &amp; &lt;Cup&gt; &quot;x&quot;'));
  assert.ok(!xml.includes('<Cup>'));
});

group('Deep-scrape exports');

const { toWorkbook, DATASET_FIELDS, exportDataset } = await import(path.join(ext, 'src/ui/export.js'));

const detailRow = {
  listingId: '1544102938',
  url: 'https://www.etsy.com/listing/1544102938/x',
  title: '2026 Calendar Printable',
  price: 9.6,
  currency: 'USD',
  materials: ['Recycled paper', 'Archival ink'],
  tags: ['2026 calendar', 'printable calendar'],
  variations: [{ name: 'Size', options: ['A4', 'A3'] }, { name: 'Color', options: ['Sage'] }],
  favoritesCount: 1482,
  favoritesPerDay: 15,
  opportunityScore: 71,
};
const reviewRow = {
  listingId: '1544102938',
  rating: 5,
  date: '2026-03-03',
  comment: 'Printed beautifully, would buy a planner too',
  photoCount: 1,
  photos: ['https://i.etsystatic.com/iap/review1.jpg'],
};

await test('CSV flattens arrays and variation groups into readable cells', async () => {
  const text = await toCsv([detailRow], { fields: DATASET_FIELDS.details }).text();
  const [header, body] = text.replace(/^\ufeff/, '').trim().split('\r\n');
  assert.equal(header.split(',')[0], 'listingId');
  assert.ok(body.includes('Recycled paper; Archival ink'), `materials not flattened: ${body}`);
  assert.ok(body.includes('Size: A4 | A3; Color: Sage'), `variations not flattened: ${body}`);
  assert.ok(!body.includes('[object Object]'));
});

await test('JSON keeps nested values as real arrays', async () => {
  const parsed = JSON.parse(await toJson([detailRow], { fields: DATASET_FIELDS.details }).text());
  assert.deepEqual(parsed[0].materials, ['Recycled paper', 'Archival ink']);
  assert.equal(parsed[0].variations[0].name, 'Size');
  assert.deepEqual(Object.keys(parsed[0]), DATASET_FIELDS.details);
});

await test('review export uses the review schema', async () => {
  const parsed = JSON.parse(await toJson([reviewRow], { fields: DATASET_FIELDS.reviews }).text());
  assert.deepEqual(Object.keys(parsed[0]), REVIEW_FIELDS);
  assert.equal(parsed[0].comment, reviewRow.comment);
});

await test('workbook holds one sheet per non-empty dataset', async () => {
  const blob = toWorkbook({ search: sampleRows, details: [detailRow], reviews: [reviewRow] });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.equal(bytes[0], 0x50);
  writeFileSync(path.join(root, 'tests/out/sample-workbook.xlsx'), bytes);

  const xml = new TextDecoder().decode(bytes);
  assert.ok(xml.includes('sheet1.xml') && xml.includes('sheet2.xml') && xml.includes('sheet3.xml'),
    'three worksheet parts expected');
  assert.ok(xml.includes('Listing details') && xml.includes('Reviews'));
});

await test('workbook skips datasets with no rows', async () => {
  const blob = toWorkbook({ search: sampleRows, details: [], reviews: [] });
  const xml = new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()));
  assert.ok(xml.includes('sheet1.xml'));
  assert.ok(!xml.includes('sheet2.xml'));
  assert.throws(() => toWorkbook({ search: [], details: [], reviews: [] }), /Nothing to export/);
});

await test('sheet names are sanitised for Excel', () => {
  assert.equal(xlsxTesting.safeSheetName('a/b:c*d?e[f]g', 0), 'a b c d e f g');
  assert.equal(xlsxTesting.safeSheetName('', 2), 'Sheet3');
  assert.ok(xlsxTesting.safeSheetName('x'.repeat(50), 0).length <= 31);
});

await test('"all datasets" is refused for single-table formats', async () => {
  await assert.rejects(
    () => exportDataset('all', 'csv', { search: sampleRows, details: [], reviews: [] }),
    /pick a single dataset/i,
  );
});

// ------------------------------------------------------------------ summary

console.log(`\n${failures.length ? '\u2717' : '\u2713'} ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`);
  process.exitCode = 1;
}
