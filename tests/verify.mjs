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

await test('dedupe global collapses across queries; off keeps everything', () => {
  const g = new runnerTesting.Dedupe('global');
  g.filter([{ listingId: '1' }], 'mug');
  assert.equal(g.filter([{ listingId: '1' }], 'apron').duplicates, 1);

  const off = new runnerTesting.Dedupe('off');
  assert.equal(off.filter([{ listingId: '1' }, { listingId: '1' }], 'mug').kept.length, 2);
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

// ------------------------------------------------------------------ summary

console.log(`\n${failures.length ? '\u2717' : '\u2713'} ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`);
  process.exitCode = 1;
}
