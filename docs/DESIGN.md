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

- **Search pages only.** No listing-detail fan-out (variations, stock, tags,
  full description). The schema is the brief's schema; enriching it would mean a
  second request per listing and a much slower, more conspicuous run.
- **`shipTo` filters, it does not price shipping.** Etsy computes real shipping
  cost per destination on the listing page; the search grid only tells us
  whether shipping is free.
- **Sponsored detection is heuristic** — Etsy labels ads inconsistently across
  layouts. Treat `sponsored: true` as high-confidence, `false` as "no label
  seen".
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
