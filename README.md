# Etsy Search Scraper — Chrome Extension (Manifest V3)

Bulk-extracts product listings from Etsy search result pages
(`https://www.etsy.com/search`) for market research, price monitoring and
competitive analysis. Multi-keyword input, pagination, dual-strategy parsing and
JSON / JSONL / CSV / Excel export — no server, no API key, no dependencies.

```
extension/            unpacked MV3 extension (this is what you load in Chrome)
  manifest.json
  src/common/         URL builder + parser shared by every context
  src/background/     service worker: orchestrator, engines, store, proxy
  src/offscreen/      offscreen document (gives the worker a DOMParser)
  src/content/        script injected into Etsy tabs (lazy-load scroll + parse)
  src/ui/             popup / dashboard, exporters, dependency-free XLSX writer
tests/                offline fixtures + 71 automated checks
tools/                icon generator, workbook validator, check runner
```

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Choose **Load unpacked** and select the `extension/` directory.
3. Pin the extension and click its icon. Use **Open in tab** for the full
   dashboard (results table, wider layout, live log).

Chrome 116+ (uses `chrome.offscreen`, MV3 modules). Works in Edge/Brave too.

## Why a browser extension instead of Options A / B / C

The brief offered three stacks. For Etsy specifically, an extension beats all
three, because the hardest part of this job is not parsing — it is *being
allowed to load the page at all*.

| Approach | Verdict |
|---|---|
| **A. Python + Requests + BeautifulSoup** | Fastest to write, but a `requests` client is trivially fingerprinted: no real TLS/JA3 signature, no cookie jar from a genuine session, no JS. Etsy answers with a challenge page quickly, and residential proxies become mandatory (a recurring bill). |
| **B. Playwright / Selenium + proxy rotation** | Solves rendering, but you are now automating a browser that advertises itself as automated (`navigator.webdriver`, CDP artifacts), on a datacentre IP, with a fresh profile and no login. Heavy, and still blocked. |
| **C. Apify actor / Etsy Open API v3 / Bright Data** | The right answer at production scale — but the official API v3 has no public "search all listings" endpoint suitable for competitive research (it is oriented to shop/listing management via OAuth), and the commercial scrapers cost money per record. |
| **D. Chrome extension (this repo)** | Requests originate from the user's own browser: genuine Chrome TLS fingerprint, genuine User-Agent, the user's real cookies and locale, no `webdriver` flag. Etsy sees an ordinary logged-in visitor, so the block rate collapses and proxies become optional. Zero infrastructure, zero per-record cost, and the data lands where the analyst already is. |

Trade-offs we accept: it needs a human's browser open (not a cron job on a
server), throughput is one profile's worth of traffic, and MV3 service workers
can be suspended (mitigated below). Those are the right trade-offs for
market-research scale — tens of keywords, hundreds of pages, not millions.

Within the extension we implement **both** parsing strategies from the brief and
combine them:

- **Primary — JSON-LD.** `<script type="application/ld+json">` → `ItemList` →
  `itemListElement`. Immune to CSS class churn; supplies title, URL, price,
  currency, image, and sometimes rating.
- **Fallback/enrichment — DOM listing cards.** Supplies what JSON-LD omits: shop
  name, rating, review count, free-shipping / bestseller / sponsored flags, and
  true on-page ordering.

Records are merged per `listingId`: DOM wins where both have a value, JSON-LD
fills every gap. Either source alone still yields rows.

### Three engines

| Engine | How it works | When to use |
|---|---|---|
| `fetch` | `fetch()` from the service worker (real UA + cookies), parsed in an offscreen document | Fastest, lowest resource use |
| `tab` | Loads the page in a background tab, scrolls to trigger lazy loading, injects the parser | JS-dependent pages, or when you want to solve a CAPTCHA by hand |
| `hybrid` *(default)* | `fetch` first; on a challenge, an error, or an empty page 1, that keyword is escalated to `tab` for the rest of the run | Best of both |

## Input parameters

All of the brief's parameters are supported, plus a few the extension form
factor makes possible.

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `queries` | string[] | — | **Required.** One keyword per line; each gets its own pagination |
| `maxPagesPerQuery` | int | `3` | 1–250 |
| `maxConcurrency` | int | `4` | 1–8 parallel page requests |
| `maxRequestRetries` | int | `5` | 0–10, exponential backoff + jitter, capped at 30 s |
| `proxyConfiguration` | object | disabled | `{enabled, proxies[], rotateEveryRequests}`; see caveat below |
| `sortOrder` | enum | `most_relevant` | `most_relevant`, `price_asc`, `price_desc`, `date_desc` |
| `minPrice` / `maxPrice` | number | none | Emitted as both `min`/`max` and `min_price`/`max_price` |
| `shipTo` | string | none | ISO-3166 alpha-2, e.g. `US` → `ship_to=US` |
| `engine` | enum | `hybrid` | `fetch`, `tab`, `hybrid` |
| `minDelayMs` / `maxDelayMs` | int | `1000` / `3000` | Random politeness delay between requests |
| `stopOnEmptyPage` | bool | `true` | Stop paginating a keyword once a page yields nothing |
| `dedupe` | enum | `per_query` | `off`, `per_query`, `global` |
| `positionMode` | enum | `per_page` | `per_page` → 1..n; `global` → `(page-1)×resultsPerPage + n` |
| `manualCaptchaSolve` | bool | `true` | On a challenge, focus the tab and resume once you solve it |
| `keepTabsOpen` | bool | `false` | Leave scraped tabs open for debugging |

Everything is validated and clamped in the worker, so a hand-crafted message
cannot push the extension past these limits.

### Proxy caveat

Chrome exposes no per-request proxy to extensions — only the browser-wide
`chrome.proxy`. We therefore install a **PAC script that routes only
`*.etsy.com` / `*.etsystatic.com`** through your proxy, leave everything else
`DIRECT`, rotate by re-installing the PAC every *N* requests, answer proxy auth
via `webRequest.onAuthRequired`, and **restore your original settings when the
run ends**. The `proxy`, `webRequest` and `webRequestAuthProvider` permissions
are *optional* and requested only when you tick the box. Because the extension
already uses your real browser identity, proxies are usually unnecessary.

## Output

One row per listing, exactly as specified:

```json
{
  "query": "handmade ceramic mug",
  "page": 1,
  "position": 1,
  "listingId": "1027105561",
  "title": "Handmade Ceramic Mug, Speckled Stoneware Coffee Cup",
  "price": 28.0,
  "currency": "USD",
  "shopName": "ArtisanPottery",
  "image": "https://i.etsystatic.com/.../il_570xN.1234567890_abcd.jpg",
  "url": "https://www.etsy.com/listing/1027105561/handmade-ceramic-mug-speckled-stoneware",
  "rating": 4.8,
  "reviewCount": 342,
  "freeShipping": true,
  "bestseller": false,
  "sponsored": false,
  "scrapedAt": "2026-05-13T04:35:22Z"
}
```

Notes on normalisation:

- `price` is a number in the page's own currency: `"$1,249.99"` → `1249.99`,
  `"1.249,99 €"` → `1249.99`, `"42,00 €"` → `42`. `currency` is an ISO code
  resolved from the symbol or JSON-LD.
- `url` is canonicalised — `click_key`, `ref`, and other tracking params stripped.
- `image` prefers the largest `srcset` candidate; protocol-relative URLs are
  upgraded to `https`.
- Booleans are never `null`. Fields Etsy did not render are `null`.
- Tick **include `_source`/`_sourceUrl`** in Advanced to see which strategy
  produced each row (`jsonld`, `dom`, `jsonld+dom`) — useful when a selector rots.

**Export:** JSON, JSONL (one object per line, for pipelines), CSV (UTF-8 BOM,
CRLF, RFC 4180 quoting, formula-injection neutralised), and XLSX (frozen header,
autofilter) written by a dependency-free ~200-line writer, because MV3 forbids
loading remote scripts. Or **Copy JSON** to the clipboard.

## Reliability details

- **Retries:** network errors and 403/408/425/429/5xx are retried with
  `min(30s, 700ms × 2^n)` + jitter; other statuses fail fast.
- **Challenge pages** are detected by marker (PerimeterX/captcha delivery,
  "unusual traffic", interstitial titles) and never counted as data. In `hybrid`
  the keyword escalates to a real tab; with `manualCaptchaSolve` the tab is
  focused, and the run resumes automatically once you clear it.
- **Worker suspension:** MV3 suspends idle workers after ~30 s and a politeness
  delay is idle time, so the worker is kept alive on a 20 s heartbeat while a run
  is in flight. State and rows are mirrored to `chrome.storage.local`; if the
  worker is still killed, the run is marked interrupted instead of hanging.
- **Row cap:** 50 000 rows retained (`unlimitedStorage`); export and clear beyond
  that.
- Closing the popup does not stop a run — reopen it, or use **Open in tab**.

## Maintenance

Etsy reshuffles its markup regularly. When the DOM path starts returning fewer
fields, the only place to edit is the `SELECTORS` table at the top of
`extension/src/common/parse.js`; every candidate list is tried in order, so you
can prepend a new selector without removing the old one. The JSON-LD path keeps
working meanwhile — that is why it is the primary strategy.

## Tests

```bash
bash tools/run-checks.sh          # 73 checks, no network and no npm install
```

| Check | Covers |
|---|---|
| `tests/verify.mjs` (38) | URL building, price/currency/URL normalisation, JSON-LD extraction, merge rules, block detection, settings clamping, scheduler round-robin + early stop, dedupe modes, CSV/JSON/JSONL/XLSX serialisation |
| `tools/check-xlsx.py` (8) | Opens the generated workbook with Python's `zipfile`/`ElementTree`: CRC-32 of every entry, mandatory OPC parts, header row, frozen pane, autofilter |
| `tests/dom-check.mjs` (12) | The DOM card parser and the injected content script running in **real headless Chrome** against fixtures: all cards found, sponsored/bestseller/free-shipping flags, EUR decimal commas, `srcset` selection, JSON-LD↔DOM merge, challenge detection |
| `tests/extension-check.mjs` (23) | Manifest/permission/import/asset integrity (including "no dynamic `import()` in worker code", which service workers reject at runtime), then the **extension actually loaded in Chrome**: service worker registers, UI boots from stored settings, GET/SAVE_SETTINGS + GET_STATE + SCRAPE_ACTIVE_TAB + CLEAR_RESULTS round-trips, input validation, offscreen document parsing, and a full run driven to completion |

Fixtures are hand-written from the documented public page structure; no Etsy
markup is redistributed. The only leg not covered offline is the HTTP request to
`etsy.com` itself (the test sandbox has no egress), so the run test asserts
orchestration and error handling rather than live listing data.

Regenerate icons with `python3 tools/make-icons.py`.

## Scope and etiquette

This tool automates what your browser is already permitted to see, at human
scale. Keep the default delays, scrape only public search pages, and review
Etsy's Terms of Use before collecting data at volume — you are responsible for
how you use it. It does not touch private data, and it does not attempt to
defeat CAPTCHAs: it hands them to you.
