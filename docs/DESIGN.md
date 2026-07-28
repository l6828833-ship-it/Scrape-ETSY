# Design notes

Implementation detail behind the summary in [`../README.md`](../README.md):
how the pieces fit, and why each decision was made the way it was.

## 1. Context map

```
                      ┌──────────────────────────────────────┐
  popup / dashboard   │  src/ui/app.html + app.js            │  DOM, Blob,
  (extension page)    │  export.js, xlsx.js                  │  chrome.downloads
                      └───────────────┬──────────────────────┘
                                      │ runtime.sendMessage
                                      │ (START_RUN, GET_STATE, GET_RESULTS…)
                      ┌───────────────▼──────────────────────┐
  service worker      │  service-worker.js  message router   │  no DOM,
  (MV3, module)       │  runner.js          orchestrator     │  suspendable
                      │  store.js           state + rows     │
                      │  fetch-engine.js / tab-engine.js     │
                      │  proxy.js           PAC + auth       │
                      └───┬───────────────┬──────────────────┘
                          │ PARSE_HTML    │ scripting.executeScript
              ┌───────────▼──────┐   ┌────▼─────────────────────┐
  offscreen   │ offscreen.js     │   │ content/extract.js       │  runs inside
  document    │ + DOMParser      │   │ (isolated world, scroll) │  the Etsy tab
              └───────┬──────────┘   └────┬─────────────────────┘
                      │                   │
                      └──── src/common/parse.js (one parser, three contexts)
```

`parse.js` is deliberately a classic UMD-style script rather than an ES module:
it must run in the offscreen document (`<script src>`), as an injected content
script (`scripting.executeScript({files})`, which cannot load modules), and in
Node for the test harness. Importing it from the ES-module service worker still
works — the side effect publishes `globalThis.EtsyParse` — which is what makes
the JSON-LD-only fallback possible when no offscreen document is available.

## 2. Why an offscreen document exists

MV3 service workers have no `DOMParser`. Three options:

1. Regex the HTML — brittle, and cannot express "the shop name element inside
   this card".
2. Parse in a content script inside an Etsy tab — forces the heavyweight tab
   engine for every page.
3. **Offscreen document** (`reasons: ['DOM_PARSER']`) — an invisible page the
   worker can hand HTML to.

We take (3), with (1) as the graceful degradation path: if `chrome.offscreen` is
missing or the document cannot be created, the worker parses JSON-LD only —
pure string work — and logs that DOM-only fields will be absent, instead of
failing the run. The offscreen document is closed when the run ends.

## 3. Concurrency and pagination

`Scheduler` hands out `(query, page)` tasks **round-robin across keywords**
rather than draining one keyword at a time. Two reasons: consecutive requests
hit different result sets (less pattern-like), and one blocked keyword cannot
stall the others.

`maxConcurrency` workers pull from the scheduler until it is empty. Each worker
sleeps a random `minDelayMs…maxDelayMs` before every request except the very
first of the run, so with concurrency 4 the effective rate is ~4 requests per
delay window.

Early termination: pagination for a keyword stops when a page returns zero
listings (`stopOnEmptyPage`) or the page cap is reached. Because pages within a
keyword may be in flight concurrently, `markDone()` is idempotent and only the
first caller increments `queriesDone`.

An empty **page 1** from the `fetch` engine is treated as suspicious rather than
final — Etsy may have served a soft challenge — so `hybrid` re-attempts it with
a real tab before believing "no results". A genuine no-results page is
recognised by copy markers and short-circuits that escalation.

## 4. Failure taxonomy

| Signal | Classification | Response |
|---|---|---|
| Network error / timeout (45 s) | retryable | backoff, retry |
| 403, 408, 425, 429, 5xx | retryable | backoff, retry |
| Other 4xx | permanent | count as failed page, move on |
| Challenge markers in the body | **blocked** (never "no data") | count a block, escalate the keyword to `tab`, optionally hand the tab to the user |
| Parse succeeded, zero rows, page > 1 | end of results | stop paginating that keyword |
| Parse succeeded, zero rows, page 1 | suspicious | escalate to `tab`, then accept |

Backoff is `min(30 s, 700 ms × 2^(attempt-1))` plus jitter. Every transition is
written to a bounded (300-entry) log that the UI renders live, so a run that
returns few rows can always be explained after the fact.

## 5. State and durability

`store.js` is the only writer of state. It keeps an in-memory copy, mirrors to
`chrome.storage.local` on an 800 ms debounce, and broadcasts `STATE_CHANGED` to
any open UI on a 250 ms throttle (the log moves faster than a human reads).

Because the popup is a real page that dies when it closes, the UI holds no
authoritative state: on open it calls `GET_STATE` + `GET_RESULTS` and re-renders.
Runs therefore survive popup closure. They do not survive a worker kill, so:

- a 20 s heartbeat (`chrome.runtime.getPlatformInfo`) plus a 30 s alarm keeps the
  worker alive *while a run is in flight only*;
- on rehydration, a state still marked `running` is rewritten to `idle` with an
  "interrupted" message rather than lying to the user;
- rows are capped at 50 000 with an explicit warning when the cap is hit.

Exports live in the UI page, not the worker, because MV3 workers have neither
`Blob` URLs nor `document` — and `chrome.downloads` needs a URL.

## 6. Parsing strategy in detail

**JSON-LD** is extracted with a regex over the raw HTML (works with no DOM),
then walked defensively: `@graph`, arrays, `ItemList.itemListElement`, entries
wrapped in `ListItem.item`, bare `Product`, `offers` as object or array,
`priceSpecification`, `lowPrice`/`highPrice`. Malformed blocks are salvaged
(`}{` → `},{`) and, failing that, skipped silently — one bad block never breaks
a page.

**DOM cards** are located by a *list* of candidate selectors tried in order,
anchored on `data-listing-id` (the most stable attribute Etsy exposes) and
deduplicated so nested matches cannot yield the same listing twice. Field
extraction prefers structure and falls back to text heuristics:

- rating: `input[name=rating]` → screen-reader text `"4.8 out of 5 stars"` → a
  title-styled number constrained to 0–5;
- review count: `"(1,204)"` → `"1,204 reviews"`;
- shop: `[data-shop-name]` → small-caption element filtered against
  price/badge/`Ad by` noise → the `Ad by Etsy seller X` label itself;
- flags: badge text (`FREE shipping`, `Bestseller`) and ad attributes.

The price parser resolves separator ambiguity by position (the *last* separator
is the decimal one), which is what makes `1,249.99` and `1.249,99` both correct.

**Merge:** DOM order defines `position`; DOM values win where both sources have
one; JSON-LD fills gaps; records unique to either source are kept. `_source`
records the provenance of every row (`dom`, `jsonld`, `jsonld+dom`) so selector
rot is visible in the data rather than silent.

## 7. Security and privacy posture

- `host_permissions` is exactly `https://www.etsy.com/*`; nothing else is
  readable by this extension.
- No `eval`, no `new Function`, no remote scripts, no inline handlers — enforced
  by a test, not just convention.
- No telemetry, no network destination other than Etsy. Rows never leave the
  browser until the user exports them.
- The invasive permissions (`proxy`, `webRequest`, `webRequestAuthProvider`) are
  optional and requested from a user gesture, and proxy settings are reverted on
  run completion, including on abort.
- CSV export prefixes `=`, `+`, `-`, `@` with `'` to defuse spreadsheet formula
  injection from hostile listing titles.
- Preview rows are rendered with `textContent` and DOM construction, never
  `innerHTML`, so scraped titles cannot inject markup into the dashboard.

## 8. Deliberate limitations

- **Listing detail is opt-in and capped.** Phase 2 costs one page request per
  listing, so it is off by default, has its own lower concurrency, and stops at
  `maxDetailListings`. A 10-keyword × 5-page search is 50 requests; enriching
  every result would be ~3200.
- **`shipTo` filters, it does not price shipping.** Etsy computes real shipping
  cost per destination on the listing page; the search grid only tells us
  whether shipping is free.
- **Sponsored detection is heuristic** — Etsy labels ads inconsistently across
  layouts. Treat `sponsored: true` as high-confidence, `false` as "no label
  seen". This is also the reason `excludeSponsored` is a *row* filter rather
  than a URL facet: Etsy offers no "hide ads" parameter, so the ads are fetched
  and then discarded (they still consume page budget, and the count is surfaced
  in the UI so the loss is visible).
- **Facet filters are trusted, not re-checked.** `bestsellerOnly` and
  `freeShippingOnly` are pushed into the URL (`is_best_seller=true`,
  `free_shipping=true`, both with `explicit=1`) and the returned rows are kept
  as-is. Re-filtering locally on our own badge detection would compound a
  best-effort signal with a server-side guarantee and drop good rows.
- **No scheduling.** Runs are user-initiated by design; a browser extension is
  the wrong place for a cron job. For unattended, continuous collection, Option
  C from the README (a hosted actor/API) remains the right tool.

## 9. Extending it

- **More fields:** add to `FIELDS` in `common/constants.js` (drives CSV/XLSX
  column order automatically) and populate them in `finalize()`.
- **A new marketplace surface** (e.g. shop pages): add a URL builder and a
  selector set; `parsePage`, the scheduler, the store and the exporters are
  surface-agnostic.
- **A different output sink:** implement one function returning a `Blob` and add
  it to `FORMATS` in `ui/export.js`; the button wiring is data-driven.


## 10. Phase 2: deep listing intelligence

```
search phase (queries x pages)          detail phase (listings)
  scheduler -> workers -> rows            queue  -> workers -> details
       |                                    |                    |
       +--> ctx.collected (ordered ids) ----+                    +--> reviews
                                                                 +--> history
                                                                        |
                                                          metrics.js ---+--> scores
```

The two phases are sequential on purpose: phase 2's queue is exactly the listings
phase 1 discovered, in search-result order, so the cap keeps the highest-ranked
listings rather than an arbitrary slice. Everything else is shared — the same
politeness delays, the same retry/backoff ladder, the same block detection and
per-run escalation to the tab engine.

One asymmetry worth knowing: a listing page's JSON-LD carries title,
description, price and rating, but favourites, cart count, stock, variations,
personalisation and reviews exist **only** in the rendered DOM. So when the
`fetch` transport has no offscreen document available, hybrid runs upgrade the
detail phase to a real tab rather than quietly returning sparse records, and a
`fetch`-only run logs a warning naming exactly which fields will be missing.

### Why history is a separate store

`store.js` holds what the current run produced; `history.js` holds what we have
ever observed. They have different lifecycles: "Clear results" empties the former
so the next export is clean, and deliberately leaves the latter alone, because
deleting it would reset every velocity metric to `null` and silently destroy the
only data that cannot be re-scraped after the fact.

Snapshots are stored as tuples (`[ts, favorites, reviewCount, price, quantity]`)
keyed by listing id. With object keys, per-snapshot JSON overhead would exceed
the payload; this file is the one that grows monotonically across runs, so it is
capped at 60 snapshots per listing (oldest pruned) with LRU eviction of whole
listings at the ceiling.

### Metric honesty rules

`metrics.js` is pure and has no notion of Etsy — it only turns a snapshot series
into numbers, under two constraints that exist to stop the feature from lying:

1. **`null` is not `0`.** A first observation yields `favoritesDelta: null`.
   `Number(null) === 0` in JavaScript, which made this the one bug the test suite
   caught in review: an `isFinite` check quietly converted "never seen" into
   "zero growth". Everything now goes through an explicit `isNum()` guard.
2. **Rates need a real interval.** Comparison snapshots must be at least
   `MIN_INTERVAL_HOURS` (6) apart, and the comparison walks *backwards* past any
   too-recent snapshots rather than giving up, so a mid-day re-run does not blank
   out yesterday's baseline.

Scores are bounded 0–100 heuristics for ranking, with log saturation so the first
few favourites move the needle more than the four-thousandth. `opportunityScore`
re-normalises across whichever signals exist, so a listing observed once is not
penalised for having no momentum data — a listing measured at genuinely zero
growth scores lower than one never measured, which is the correct ordering.

### Reviews as a child table

Reviews are one-to-many, which is why exports are dataset-oriented rather than
one flat sheet: joining them into listing rows would either duplicate every
listing field per review or bury review text in a single cell. Re-scraping a
listing replaces its reviews (`dropReviewsFor` then insert) instead of appending,
so repeat runs do not accumulate duplicates of the same comment.
