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
tests/                offline fixtures + the automated check suite
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
| `bestsellerOnly` | bool | `false` | Adds `is_best_seller=true` — only badged bestsellers |
| `freeShippingOnly` | bool | `false` | Adds `free_shipping=true` |
| `excludeSponsored` | bool | `false` | Discards "Ad by Etsy seller" placements instead of storing them |
| `scrapeDetails` | bool | `false` | Phase 2: open each collected listing for the deep dataset |
| `maxDetailListings` | int | `25` | 1–500 listings enriched per run |
| `detailConcurrency` | int | `2` | 1–4 parallel listing requests |
| `scrapeReviews` | bool | `true` | Capture reviews rendered on the listing page |
| `maxReviewsPerListing` | int | `20` | 0–100 |
| `trackHistory` | bool | `true` | Keep snapshots so velocity can be derived |
| `engine` | enum | `hybrid` | `fetch`, `tab`, `hybrid` |
| `minDelayMs` / `maxDelayMs` | int | `1000` / `3000` | Random politeness delay between requests |
| `stopOnEmptyPage` | bool | `true` | Stop paginating a keyword once a page yields nothing |
| `dedupe` | enum | `per_query` | `off`, `per_query`, `global` |
| `positionMode` | enum | `per_page` | `per_page` → 1..n; `global` → `(page-1)×resultsPerPage + n` |
| `manualCaptchaSolve` | bool | `true` | On a challenge, focus the tab and resume once you solve it |
| `keepTabsOpen` | bool | `false` | Leave scraped tabs open for debugging |

Everything is validated and clamped in the worker, so a hand-crafted message
cannot push the extension past these limits.

### Bestsellers only, and skipping ads

Both are checkboxes directly under the search fields.

**Bestsellers only** appends Etsy's own facet, so the filtering happens
server-side and your page budget is spent entirely on bestsellers:

```
https://www.etsy.com/search?q=2026+calendar+printable&is_best_seller=true&explicit=1&ref=search_bar
```

`explicit=1` is added automatically whenever any facet is active — Etsy pairs it
with narrowed searches and silently drops some facets without it. (The
`as_prefix` param in a URL copied from the browser is just autocomplete
telemetry; it has no effect on results, so we omit it.)

Rows are deliberately **not** re-filtered locally on the `bestseller` flag: the
facet already guarantees the result set, and badge detection in the DOM is
best-effort, so a local filter would silently drop valid rows whose badge we
failed to see.

**Skip ads** drops rows where `sponsored === true` before de-duplication and
storage, and counts them in the **Ads skipped** stat so you can see how much of
each page was advertising. Ads are filtered *after* the empty-page check, so a
page made up entirely of ads yields zero rows without being mistaken for the end
of the results. Because ad detection is heuristic, an unlabelled ad can still
slip through — pair it with the `sponsored` column if you need certainty.

### Proxy caveat

Chrome exposes no per-request proxy to extensions — only the browser-wide
`chrome.proxy`. We therefore install a **PAC script that routes only
`*.etsy.com` / `*.etsystatic.com`** through your proxy, leave everything else
`DIRECT`, rotate by re-installing the PAC every *N* requests, answer proxy auth
via `webRequest.onAuthRequired`, and **restore your original settings when the
run ends**. The `proxy`, `webRequest` and `webRequestAuthProvider` permissions
are *optional* and requested only when you tick the box. Because the extension
already uses your real browser identity, proxies are usually unnecessary.

## Deep listing intelligence (phase 2)

Tick **Open each listing** and the run gains a second phase: every listing the
search found is opened and mined for the full dataset. This is the slow part —
one extra page request per listing — hence the separate cap and lower
concurrency.

Three datasets come out, switchable in the **Dataset** picker and exportable
separately or as one multi-sheet workbook:

**1. Product intelligence** — `title`, `description`, `price`/`originalPrice`/
`onSale`, `currency`, `availability`, `mainImage`, `imageCount`, `categoryPath`
(from the breadcrumb), `listingCreationDate` ("Listed on …"), `favoritesCount`,
`cartCount`, `quantityAvailable`, `variations` + `variationCount`,
`isPersonalizable` / `personalizationRequired`, `materials`, `tags`/`tagCount`,
`freeShipping`, `shopName`, `shopUrl`, `shopTotalSales`, `isStarSeller`,
`shopLocation`, `shopMemberSince`, `rating`, `reviewCount`, `shopReviewCount`.

Column names are explicit rather than abbreviated, so if you are mapping from a
field list: `favorites` → `favoritesCount`, `views` → `viewsCount`, `quantity` →
`quantityAvailable`, `category` → `categoryPath`. Renaming them is a two-line
change (`DETAIL_FIELDS` in `common/constants.js` plus the key in
`finalizeDetail`).

Two of these need a note on how they are decided:

- **`freeShipping`** is stated in copy, not structured data, so it is read from
  short shipping lines and explicitly rejects conditional shop promotions —
  "Free shipping on orders over $35" and "when you spend $50" do **not** set the
  flag, while "Free shipping to United States" and "Cost to ship: FREE" do. If a
  page shows both a promo line and a genuine one, the genuine one wins.
- **`shopMemberSince`** is an integer year, because "On Etsy since 2019" is all
  Etsy renders — no invented month or day. Values before 2005 (Etsy's launch) or
  in the future are rejected as mis-parses.
- **`shopAgeMonths`** exists because many listings state tenure instead of a
  start year: "11 months on Etsy", "3 years on Etsy". Those pages leave
  `shopMemberSince` `null`, and the two fields are deliberately independent — "3
  years" is anywhere from 36 to 47 months, so deriving a start year from it would
  be a guess presented as a fact. Read whichever one is populated.
- **`categoryPath`** prefers the JSON-LD `BreadcrumbList`, then the DOM
  breadcrumb, and finally the `Product.category` string, which Etsy writes with
  `<` separators, broadest first ("Paper & Party Supplies < Paper < …"). Some
  listing pages publish only that last form.
- **`tags`** have three possible sources and `tagSource` always records which one
  produced a row. See [Why is `tags` empty?](#why-is-tags-empty) — it is the most
  common question about this tool, and the answer is usually one checkbox.

**2. Customer voice** — one row per review: `rating`, `date`, `comment`,
`reviewer`, `photos` + `photoCount`, and the purchased `variation`. This is the
dataset worth feeding to an LLM: complaints in reviews are the clearest
statement of what a competing listing is missing.

Reviews come from two places and are merged. The DOM reviews pane is richer
(photos, the purchased variation), but listing pages also ship a JSON-LD
`review[]` array in the initial HTML — which is the only source available in
fetch mode, where there is no live document to read.

Duplicates collapse on matching reviewer + date, or on one comment being the
opening of the other (the DOM renders a collapsed teaser, JSON-LD carries the
full body, so the fuller text wins). A *known* difference in reviewer or date
vetoes the match, because two buyers can post word-for-word the same thing and
that is still two reviews. `photoCount` is `null`, not `0`, on a review that only
JSON-LD supplied: that source says nothing about attachments, so claiming zero
would be a claim about the review it cannot support.

**3. Trend / velocity** — derived, not scraped. Every enriched listing appends a
compact snapshot (favourites, reviews, price, stock) to a local history, and the
series produces `firstScrapedAt`, `snapshotCount`, `daysTracked`,
`daysSinceListed`, `favoritesDelta`, `favoritesPerDay`,
`favoritesPerDayLifetime`, `reviewsDelta`, `reviewsPerDay`, plus four bounded
0–100 scores: `demandScore`, `momentumScore`, `competitiveGapScore`
(high price × few reviews = margin with weak proven competition) and a weighted
`opportunityScore`.

Two rules the metrics follow, and they matter:

- **Velocity needs two observations.** Run the scraper today and
  `favoritesDelta` is `null` — not `0`. "We don't know yet" and "it gained
  nothing" are different facts, and conflating them is how you end up trusting a
  fake trend. Re-run tomorrow on the same keywords and the deltas appear.
- **Intervals under 6 hours are ignored** for rate calculations, so scraping
  twice in one sitting cannot manufacture a rocket ship. Snapshots inside a
  1-hour window overwrite each other instead of accumulating.

`Clear` wipes the exported datasets but **keeps the snapshot history** — that
history is the baseline the whole velocity feature depends on.

### What Etsy does not publish

Being straight about this, because these are the fields people most often expect:

| Field | Reality |
|---|---|
| `viewsCount` | Etsy removed public view counters years ago. The column exists and stays `null` unless a page genuinely exposes one — it is never inferred from something else. |
| `tags` (the 13) | Not rendered verbatim in the page, and on many listings the tags module is a lazy-loaded placeholder with no links at all in the served HTML. Three routes, in descending fidelity: an Etsy API key (the literal array), the EHunt panel, or harvesting `/market/<term>` and `/search?q=<term>` links with the tab engine. `tagSource` records which you got and `tagCount` how many, so a `tagCount: 6` row never claims to be the full set. |
| sales per listing | Only *shop* totals are public (`shopTotalSales`). Per-listing sales are not, so `reviewsPerDay` and `cartCount` are the honest proxies for conversion. |
| reviews beyond page 1 | Deeper review pages load through an undocumented internal endpoint. We parse the reviews the page actually renders (its JSON-LD array plus the rendered pane) rather than depending on private API shapes. |
| exact shop start date | Listings show either a year ("On Etsy since 2019" → `shopMemberSince`) or a duration ("11 months on Etsy" → `shopAgeMonths`). Neither is converted into the other, because a duration only pins the start date to a range. |

### Why is `tags` empty?

Etsy does not print a listing's 13 tags anywhere on the page, so this is the one
field that depends on how you run the tool. Work down the list — the run log now
names whichever of these applies, so you should not have to guess:

**1. Is the deep scrape even on?** `Scrape listing details` is **off by default**,
and tags, description, favourites, stock and shop sales are collected *only* in
that phase — the search grid does not carry them at all. With it off, the run
says so in the log, and the `Listings` table has no Tags column to look at.
Tags live in the **Details** dataset, so switch the dataset picker to `details`.

**2. Which source do you want?** In descending fidelity:

| Source | `tagSource` | What you need |
|---|---|---|
| Etsy Open API | `api` | A free keystring from [etsy.com/developers/your-apps](https://www.etsy.com/developers/your-apps) pasted into **Etsy API key**. No OAuth, no app review. This is the only route that returns the **literal 13 tags**. |
| EHunt panel | `ehunt` | The *EHunt – Etsy Rank Tool* extension installed and enabled, plus **Read tags from the EHunt panel** ticked. Gives the real 13 tags *and* a search volume per tag. Forces the tab engine, because a `fetch()` of the HTML is untouched by other extensions. |
| Page links | `page-links` | Nothing extra, but it is a **proxy**, not the tag list: the `/market/` and related-search links Etsy renders, capped at 13. Requires **Engine: tab**. |

**3. On the page-link route, the module is lazy.** Etsy ships the tag section as
an empty placeholder and fills it in after load, so there are no `/market/` links
in the served HTML at all. The tab engine now scrolls that module into view and
waits for it, which is what triggers the load. A fetch-mode run legitimately
returns `tags: null` on those listings, and the log distinguishes "the module was
still an unloaded placeholder" (switch engine) from "no tag section anywhere"
(Etsy moved the markup — update `SELECTORS.tagsModule`).

**4. On the EHunt route, absent and slow look identical from outside.** The run
now separates them: EHunt's own markup detected but no tag list means raise
**EHunt wait** and leave its panel expanded; nothing detected at all means it is
not installed, not enabled, or not permitted on that page. Its panel is also
searched inside shadow roots, since injected UIs are commonly mounted in one.

#### Waiting for the tag table, not just the panel

EHunt's panel mounts in well under a second, but it then fetches that listing's
figures from its own service and draws the tag table **several seconds later**.
Waiting for the panel to merely *exist* therefore read it while the tag row was
still empty and reported "no tags" for a listing that was about to have all
thirteen. So the wait follows the panel's progress instead of a flat clock:

| Stage | Meaning | What the wait does |
|---|---|---|
| 0 | no trace of EHunt | gives up after ~3s, so a browser without EHunt does not pay the full budget on every listing |
| 1 | EHunt present, panel not drawn | waits |
| 2 | panel frame up, empty | waits, and scrolls the panel into view since it can defer work while off-screen |
| 3 | stats table in, tag row missing | waits |
| 4 | tag table rendered | reads it and moves on immediately |

Every time the panel advances a stage it earns another 10s, because visible
progress is evidence that waiting will pay off, whereas silence is evidence that
it will not — only progress buys more time. **EHunt wait** (default 20s, max
120s) is the base budget; a 45s ceiling stops a permanently half-drawn panel
stalling the run. If the tags still never arrive, the log names the furthest
stage reached, e.g. `panel frame appeared but stayed empty`, which says whether
to wait longer or to go and check EHunt itself.

Whatever did render is kept either way, so a listing that times out mid-load
still contributes the stats EHunt had already drawn.

### If a deep-scrape field comes back empty

The run now tells you. Each listing logs what it found — `1482 favs, 940 chars
desc, qty 4` — and names anything missing as `no description/shop sales`. At the
end of the phase you get one summary line, e.g.
`Deep scrape gaps — empty for: description (25/25)`, plus the likely cause:

- **empty on *every* listing with the fetch engine** — the page was probably not
  fully rendered; switch the engine to **Tab**, which runs the listing page's own
  JavaScript.
- **empty on *every* listing with the tab engine** — Etsy most likely renamed its
  markup; update the `SELECTORS` table at the top of
  `extension/src/common/detail-parse.js`. JSON-LD-backed fields keep working
  meanwhile.
- **empty on *some* listings** — normal. Not every listing states stock,
  materials or a personalisation option.

`description` specifically now tries eight containers and then falls back to the
`og:description` / `meta[name=description]` tags, which survive front-end
redesigns. Where a page renders a collapsed teaser plus the full text, the longer
one wins.

| `viewsCount` | Etsy removed public view counters years ago. The column exists and stays `null` unless a page genuinely exposes one — it is never inferred from something else. |
### Digital products only

Tick **Digital products only** to keep instant/digital downloads and drop physical
items. Etsy has no documented "digital" search facet, so this is a row filter, and
it is deliberately strict: Etsy *labels* digital listings ("Digital Download") but
says nothing at all for physical ones, so only an explicit label qualifies and an
unlabelled row is dropped. Every drop is counted in the **Non-digital** stat, so
over-filtering shows up immediately instead of quietly shrinking your dataset.

The deep scrape re-checks with much stronger evidence: a listing page states
"Instant Download" / "Digital file type(s)" for digital, and "Ships from" /
"Arrives by" for physical. `isDigital` is tri-state — `true`, `false`, or `null`
when the page never said. **Price is never used as a signal**: cheap physical
items and expensive digital ones both exist.

### Reading tags from the EHunt panel

If you already run [EHunt (Etsy Rank Tool)](https://ehunt.ai), it renders a
listing's real 13 tags — with search volumes — into the page. It injects into the
same DOM, so our content script can read it: tick **Read the EHunt panel** and the
deep scrape harvests

- `tags` (all 13) plus `tagVolumes` (`{"Editable PDF Planner": 14800000}`)
- `isDigital` and `productType` from EHunt's own Product Type row
- EHunt's estimates: `ehuntEstimatedSales`, `ehuntEstimatedRevenue`,
  `ehuntConversionRate`, `ehuntReviewRatio`
- its price view — `ehuntPrice`, `ehuntOriginalPrice`, `ehuntDiscountPercent`,
  `ehuntCurrency` — which is where the **discount percentage** comes from, a
  figure Etsy's own markup does not state outright
- `ehuntStock`, `ehuntBestSeller`, `ehuntShopRating`, `ehuntShipsFrom`, and a
  category path several levels deeper than Etsy's breadcrumb
  (`… > Design & Templates > Templates > Planner Templates`)
- the **period-over-period deltas** shown beside each figure:
  `ehuntSalesGrowth`, `ehuntRevenueGrowth`, `ehuntViewsGrowth`,
  `ehuntReviewsGrowth`, `ehuntFavoritesGrowth`, `ehuntShopSalesGrowth`

Two things about those deltas, because both are easy to get wrong:

- **Only rises are recorded.** EHunt publishes the direction solely through the
  arrow glyph's colour, and the only thing anyone has actually observed is its
  green up-arrow. A green arrow therefore becomes `+6`; anything else — no arrow
  at all (Total Revenue renders its delta bare), a rotated or flipped glyph, or a
  red-dominant fill that could equally be a warning colour — produces `null`.
  An unsigned `4.5` could be a rise or a fall, and exporting it as growth would
  be inventing the half that matters. **If you find a listing whose figures are
  falling, send that cell's HTML and the down-arrow can be supported properly.**
- **They used to corrupt the figure beside them.** The delta lives *inside* the
  same table cell as the value, so reading the cell wholesale spliced the two
  together: Total Sales `68` with a delta of `6` parsed as **686**, and Store
  Sales `775` with `43` as **77543** — which then gap-filled `shopTotalSales`
  as though Etsy had published it. The delta is now removed before the cell is
  read, and `parseCompactNumber` refuses any cell holding more than one number,
  so a future decoration produces a gap rather than a fabricated figure.

**EHunt's panel is also excluded from Etsy's page text.** It injects into the same
`<body>`, and its labels read exactly like Etsy copy — its "Ships From / United
States / Other Data" cells turned `shopLocation` into `"United States Other
Data"`, and its "Store Sales 775" row is indistinguishable from an Etsy sales
line. The panel subtree is cut out before any Etsy-side regex runs, so the two
sources stay separable and `ehuntPanel` tells you whether the panel contributed
at all.

**This now configures itself.** Ticking the option switches the deep scrape to
real tabs (a worker `fetch()` returns HTML no other extension has touched) and
opens them in a **separate, unfocused window** rather than hidden background tabs
— a hidden tab reports `visibilityState: "hidden"`, and panels like EHunt wait
for the page to be visible before rendering. Your own window keeps focus, and the
scraping window closes when the run ends.

**Open pages in** (Advanced) controls this directly:

| Mode | Behaviour |
|---|---|
| `window` *(default)* | one separate unfocused window, reused for the run — visible, so panels render |
| `background` | hidden tab in your window; fastest, but third-party panels will not appear |
| `foreground` | tab in your current window, activated — useful for watching a run |

The run reports what happened: `EHunt panel read on 3/3 listing(s)`, or a warning
naming the likely cause if the panel never appeared (extension disabled, not
allowed in all windows, or the wait too short — tune **EHunt wait**).

Precedence is explicit and conservative. `tagSource` reads `api` > `ehunt` >
`page-links`, and EHunt values only ever *fill gaps* in Etsy-observed fields —
a favourite count read from Etsy is never overwritten by EHunt's. Its
sales/revenue/conversion figures keep the `ehunt` prefix because they are
**third-party estimates, not figures Etsy published**, and `N/A` in the panel
becomes `null`, never `0`.

EHunt gap-fills `tags`, `tagVolumes`, `isDigital`, `favoritesCount`,
`viewsCount`, `shopTotalSales`, `listingCreationDate`, `categoryPath` and
`reviewCount`. Five values are deliberately *never* merged into their Etsy
equivalents, and each stays available under its own `ehunt*` name:

- **`ehuntStock` never fills `quantityAvailable`.** The trend history snapshots
  that column, and once stored an EHunt figure is indistinguishable from an
  Etsy-observed one. Since the panel is present on some runs and not others, the
  series would alternate between two independently-derived numbers and
  manufacture stock movement — in the one feature built to detect real movement.
- **`ehuntPrice` never fills `price`.** EHunt normalises to USD, so merging them
  would silently mix currencies on a non-USD listing.
- **`ehuntShopRating` never fills `rating`.** EHunt's star widget sits beside the
  *store* name, so it is the shop's rating, not this listing's — a different
  number that happens to look like the right one.
- **`ehuntShipsFrom` never fills `shopLocation`.** EHunt states a country, Etsy a
  city and state; mixing granularities makes the column unusable.
- **`ehuntShopName` never fills `shopName`.** Etsy always supplies it, and
  EHunt's cell also hosts a rating widget whose score text can leak in.

`ehuntOriginalPrice` comes from the strike-through element specifically, not from
"whichever figure is largest": on a listing showing a price *range*, the larger
number was never a former price, and treating it as one invents a discount.

### Getting the real 13 tags

Etsy never renders a listing's tags verbatim in the page, so scraping alone can
only recover a proxy for them. The tags *are* available from Etsy's Open API v3,
for any active listing, with nothing but an application keystring — only
write/private endpoints need OAuth, so no shop ownership is involved
([request standards](https://developers.etsy.com/documentation/essentials/requests),
[authentication](https://developers.etsy.com/documentation/essentials/authentication)).

1. Get a free key at [etsy.com/developers/register](https://www.etsy.com/developers/register)
2. Paste it into **Deep listing intelligence -> Etsy API key**
3. Run a deep scrape

Each listing then also gets `GET /v3/application/listings/{id}?includes=Shop`,
which supplies the **exact tag array**, plus an authoritative `description`,
`favoritesCount`, `viewsCount` (yes — the API exposes what the page hides),
`quantityAvailable`, `materials`, and `shopTotalSales` from the shop include.

Provenance is explicit: **`tagSource`** is `api` for the real tag set and
`page-links` for the scraped proxy, so a partial harvest can never be mistaken
for the full 13. Page-only signals the API does not carry (cart count, star
seller, shop location and age, review text) keep their scraped values, so the API
is purely additive.

The key is stored locally, sent only to `api.etsy.com`, and never written to the
activity log. `api.etsy.com` is an *optional* host permission, requested the
first time you run with a key set. A key Etsy rejects disables the API for the
rest of that run after one clear error rather than failing every listing, and the
scrape continues without it.

| `tags` (the 13) | Not rendered verbatim anywhere in the page, so **without an API key** we harvest both link shapes that mirror them — `/market/<term>` links and the tag-style `/search?q=<term>` chips under "Explore related searches" — dedupe case-insensitively and cap at 13 (Etsy's own limit). `tagCount` tells you how many were actually recovered, so a listing showing `tagCount: 6` is not claiming to have found all 13. Treat as a close proxy, not the literal tag list. |
| sales per listing | Only *shop* totals are public (`shopTotalSales`). Per-listing sales are not, so `reviewsPerDay` and `cartCount` are the honest proxies for conversion. |
| reviews beyond page 1 | Deeper review pages load through an undocumented internal endpoint. We parse the reviews the page actually renders (typically the first page) rather than depending on private API shapes. |

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

### Wrong data is worse than missing data

Several fields on the search grid are only inferable from copy, and a loose guess
there is actively harmful — a plausible-looking wrong number is harder to notice
than a `null`. So each of these requires positive evidence and otherwise stays
`null`/`false`:

- **`rating`** comes only from an element that declares itself rating-related — a
  `rating` input, an `aria-label`/text of the form "4.8 out of 5 stars", or a
  number inside a `rating`/`stars` element **that differs from the card's price** (a
  `rating` input, or `aria-label`/text of the form "4.8 out of 5 stars"). There is
  no "number that looks like a rating" fallback, because on the live grid Etsy
  styles the *price* with the same class the stars use. In a real run of
  `2026 calendar printable` that made every listing under $5 report its price as
  its star rating (a $2.59 PDF "rated 2.59") while everything over $5 reported
  `null`. Prices and ratings are both small decimals, so no range check can
  separate them.
- **`reviewCount`** is read first from the star widget's accessible label —
  `aria-label="Rating: 4.94 out of 5 stars, 779 reviews"` — because that is where
  Etsy actually publishes it. Nothing in the visible text states the number, so a
  `textContent`-only scan returned `null` for nearly every row of a live run.
  Only rating-scoped elements are inspected, never the whole card, since
  shop-level totals are labelled "N reviews" too. Failing that: the text beside
  the stars, or a single `(1,482)` token when a card has exactly one. Two
  candidates and no stars means we decline rather than pick. A count that repeats
  across several listings from the *same shop* is a shop total, not a per-listing
  figure, so it is cleared at the end of the page — one card cannot tell those
  apart, but a page can.
- **`isDigital`** is set when Etsy labels the listing ("Digital Download",
  "Instant Download"), whether as its own badge or inside a longer line. Absence
  means `null` (unknown), never `false`, because Etsy says nothing for physical
  items. Price is never used as a signal.
- **`bestseller` / `freeShipping`** require a short badge element, not a substring
  of the card's text. Testing the whole card matched incidental copy like
  "Bestselling shop" and shop-wide "Free shipping on orders over $35" promotions,
  which flagged most listings.
- **`shopName`** strips Etsy's `Designed by` / `By` / `Made by` / `Ad by` prefixes.

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
autofilter) written by a dependency-free writer, because MV3 forbids loading
remote scripts. Or **Copy JSON** to the clipboard.

Pick a dataset first, or choose **All datasets** to get one Excel workbook with a
sheet per dataset (search rows / listing details / reviews) or a single JSON
object containing all three. CSV and JSONL hold one table each, so they refuse
"all" rather than silently exporting only part of it. Nested values (`variations`,
`materials`, `tags`, `photos`) stay real arrays in JSON and are flattened for
spreadsheets — `Size: A4 | A3; Color: Sage`.

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
bash tools/run-checks.sh          # no network, no npm install
```

The runner prints the count for each suite as it goes, so the totals live there
rather than in this file — a hardcoded number here would only ever be a number
that used to be true, and it made every parallel branch collide on one line.

| Check | Covers |
|---|---|
| `tests/verify.mjs` | URL building incl. the `is_best_seller`/`free_shipping`/`explicit` facets, price/currency/URL normalisation, JSON-LD extraction (search + listing pages), merge rules, block detection, settings clamping, scheduler round-robin + early stop, dedupe modes, ad exclusion, **trend metrics** (deltas, rate windows, lifetime rates, score bounds, null-vs-zero semantics), the EHunt number rules (a cell holding two numbers yields null rather than a splice of both; thousands separators; "% OFF" is not a currency), tag-route accounting (telling "the module never loaded" apart from "Etsy moved the markup"), CSV/JSON/JSONL/XLSX serialisation and multi-sheet workbooks |
| `tools/check-xlsx.py` | Opens both generated workbooks with Python's `zipfile`/`ElementTree`: CRC-32 of every entry, mandatory OPC parts, header row, frozen pane, autofilter, one sheet per dataset with working relationships, and flattened nested values |
| `tests/dom-check.mjs` | The DOM parsers and both injected content scripts running in **real headless Chrome** against fixtures: search cards (sponsored/bestseller/free-shipping flags, EUR decimal commas, `srcset`, JSON-LD↔DOM merge), the data-quality regressions (price never reported as a rating, shop-name prefixes, shop-level review counts, badge false positives), and listing pages (favourites, cart count, stock, variations, personalisation, materials, tag harvesting and the 13-tag cap, free shipping vs. conditional promos, shop authority incl. member-since year validation, reviews with photos, review caps), the structures taken from a real Etsy page (review counts published only in the star widget's `aria-label`, a `<`-separated category with no breadcrumb, tenure in months with no start year, JSON-LD reviews merged with the DOM pane, an empty lazy-loaded tags module), the real EHunt panel (deltas kept out of the figures beside them, its text kept out of Etsy's fields, original price taken from the strike-through, a panel found inside a shadow root, EHunt-loading told apart from EHunt-absent), an empty tags module reported as unloaded rather than as missing markup, plus challenge detection |
| `tests/extension-check.mjs` | Manifest/permission/import/asset integrity (including "no dynamic `import()` in worker code", which service workers reject at runtime), then the **extension actually loaded in Chrome**: service worker registers, UI boots from stored settings, message round-trips for settings/state/results/details/reviews, input validation and clamping, filter and deep-scrape options persisting through the worker, dataset picker re-rendering the preview, offscreen document parsing both page types, multi-sheet workbook generation, and a full run driven to completion |

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
