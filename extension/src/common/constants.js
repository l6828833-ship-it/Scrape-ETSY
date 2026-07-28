/**
 * Shared constants, defaults and limits (ES module — used by the service worker
 * and the UI page).
 */

export const ETSY_SEARCH_URL = 'https://www.etsy.com/search';

/** Engines available for fetching a search page. */
export const ENGINES = {
  /** Background `fetch()` + offscreen HTML parsing. Fast, low resource use. */
  FETCH: 'fetch',
  /** Real (background) tab, full JS render + lazy-load scroll. Slow, complete. */
  TAB: 'tab',
  /** Try FETCH, automatically fall back to TAB when blocked / empty. */
  HYBRID: 'hybrid',
};

/** `order=` values accepted by Etsy search. */
export const SORT_ORDERS = {
  most_relevant: 'most_relevant',
  price_asc: 'price_asc',
  price_desc: 'price_desc',
  date_desc: 'date_desc',
};

export const LIMITS = {
  maxPagesPerQuery: 250,
  maxConcurrency: 8,
  maxRequestRetries: 10,
  maxQueries: 200,
  /** Hard cap on retained rows so chrome.storage.local stays healthy. */
  maxStoredRows: 50000,
  maxLogEntries: 300,
  maxDetailListings: 500,
  maxDetailConcurrency: 4,
  maxReviewsPerListing: 100,
  maxStoredDetails: 20000,
  maxStoredReviews: 100000,
  /** Snapshots retained per listing (oldest pruned first). */
  maxSnapshotsPerListing: 60,
  maxTrackedListings: 20000,
};

export const DEFAULTS = {
  queries: [],
  maxPagesPerQuery: 3,
  maxConcurrency: 4,
  maxRequestRetries: 5,
  engine: ENGINES.HYBRID,
  sortOrder: 'most_relevant',
  minPrice: null,
  maxPrice: null,
  shipTo: '',
  /** Etsy facet `is_best_seller=true` — only listings carrying the badge. */
  bestsellerOnly: false,
  /** Etsy facet `free_shipping=true`. */
  freeShippingOnly: false,
  /** Drop "Ad by Etsy seller" placements instead of storing them. */
  excludeSponsored: false,
  /** Keep only instant/digital downloads (labelled "Digital Download"). */
  digitalOnly: false,
  /** Read tags and estimates from the EHunt panel when it is on the page. */
  useEhuntPanel: true,
  /** Phase 2: open each collected listing and extract the deep dataset. */
  scrapeDetails: false,
  /** Cap on listings enriched per run (each one is an extra page request). */
  maxDetailListings: 25,
  /** Parallel listing-detail requests (kept lower than search concurrency). */
  detailConcurrency: 2,
  /** Capture the reviews rendered on the listing page. */
  scrapeReviews: true,
  maxReviewsPerListing: 20,
  /** Keep per-listing snapshots so favourites/review velocity can be derived. */
  trackHistory: true,
  /**
   * Etsy Open API v3 application keystring (free, from
   * https://www.etsy.com/developers/register). Optional: when set, the deep
   * scrape also asks the API for each listing, which is the only way to get the
   * real 13 tags plus an authoritative description, favourites and stock.
   */
  etsyApiKey: '',
  /** Random inter-request delay window, milliseconds. */
  minDelayMs: 1000,
  maxDelayMs: 3000,
  /** Stop paginating a query as soon as a page yields no listings. */
  stopOnEmptyPage: true,
  /** Drop repeated listingIds (per query by default). */
  dedupe: 'per_query', // 'off' | 'per_query' | 'global'
  /** 'per_page' → position 1..n within the page; 'global' → offset by page. */
  positionMode: 'per_page',
  /** Grid size assumed when positionMode === 'global'. */
  resultsPerPage: 64,
  /**
   * Where scraped pages open: 'background' (hidden tab in your window),
   * 'window' (one separate unfocused window — required for third-party panels
   * like EHunt, which do not render in hidden tabs), or 'foreground'.
   */
  tabMode: 'window',
  /** How long to wait for the EHunt panel to render its tags. */
  // EHunt fetches each listing's figures from its own service before it can draw
  // its tag table, so this is a budget measured in seconds, not milliseconds of
  // render time. The wait extends past this on its own while the panel is still
  // visibly filling in, and abandons it early when EHunt is not installed.
  ehuntWaitMs: 20000,
  /** Pause and surface the tab so a human can solve a CAPTCHA. */
  manualCaptchaSolve: true,
  /** Keep scraped tabs open (debugging). */
  keepTabsOpen: false,
  proxyConfiguration: {
    enabled: false,
    /** ["http://user:pass@host:port", "socks5://host:port", ...] */
    proxies: [],
    /** Re-point the PAC script at the next proxy every N requests. */
    rotateEveryRequests: 5,
  },
};

/** Output column order for CSV / Excel exports. */
export const FIELDS = [
  'query',
  'page',
  'position',
  'listingId',
  'title',
  'price',
  'currency',
  'shopName',
  'image',
  'url',
  'rating',
  'reviewCount',
  'freeShipping',
  'bestseller',
  'sponsored',
  /** true when the card carries Etsy's "Digital Download" label; null if not stated. */
  'isDigital',
  'scrapedAt',
];

/**
 * Listing-detail ("deep scrape") output columns.
 *
 * Grouped by intent: core listing facts, sales-velocity signals, monetisation
 * structure, SEO surface, seller authority, then the derived trend metrics that
 * only become meaningful once the same listing has been seen more than once.
 */
export const DETAIL_FIELDS = [
  // core
  'listingId', 'url', 'title', 'description', 'price', 'currency',
  'originalPrice', 'onSale', 'availability', 'mainImage', 'imageCount',
  'categoryPath', 'listingCreationDate', 'listingCreationDateSource',
  // sales velocity
  'favoritesCount', 'cartCount', 'viewsCount', 'quantityAvailable',
  // monetisation structure
  'variationCount', 'variations', 'isPersonalizable', 'personalizationRequired',
  'materials',
  // SEO — tagSource records whether these are the real API tags or the
  // link-derived proxy, so a partial harvest is never mistaken for the full set.
  'tags', 'tagCount', 'tagSource', 'tagVolumes',
  // Third-party estimates read from the EHunt panel when it is on the page.
  // Prefixed so they are never mistaken for figures Etsy published.
  'ehuntEstimatedSales', 'ehuntEstimatedRevenue', 'ehuntConversionRate',
  'ehuntReviewRatio', 'ehuntShopRating', 'ehuntStock', 'ehuntBestSeller',
  // EHunt's own price view: normalised to USD, so kept separate from `price`
  // rather than merged into it.
  'ehuntPrice', 'ehuntOriginalPrice', 'ehuntDiscountPercent', 'ehuntCurrency',
  'ehuntShipsFrom',
  // Period-over-period deltas EHunt shows beside each figure. Signed, and only
  // present when the arrow's direction was unambiguous — see growthDirection().
  'ehuntSalesGrowth', 'ehuntRevenueGrowth', 'ehuntViewsGrowth',
  'ehuntReviewsGrowth', 'ehuntFavoritesGrowth', 'ehuntShopSalesGrowth',
  'ehuntPanel',
  // product type: true = instant/digital download, false = physical,
  // null = the page never said (never guessed from price or category)
  'isDigital', 'productType',
  // shipping incentive
  'freeShipping',
  // seller authority
  'shopName', 'shopUrl', 'shopTotalSales', 'isStarSeller', 'shopLocation',
  // Two independent tenure fields because Etsy renders one or the other:
  // a start year ("On Etsy since 2019") or a duration ("11 months on Etsy").
  'shopMemberSince', 'shopAgeMonths',
  // ratings
  'rating', 'reviewCount', 'shopReviewCount', 'reviewsCaptured',
  // derived trend metrics (see common/metrics.js)
  'firstScrapedAt', 'lastScrapedAt', 'snapshotCount', 'daysTracked',
  'daysSinceListed', 'favoritesDelta', 'favoritesPerDay',
  'favoritesPerDayLifetime', 'reviewsDelta', 'reviewsPerDay',
  'demandScore', 'momentumScore', 'competitiveGapScore', 'opportunityScore',
  'scrapedAt',
];

/** One row per captured review. */
export const REVIEW_FIELDS = [
  'listingId', 'listingTitle', 'reviewer', 'rating', 'date', 'comment',
  'photoCount', 'photos', 'variation', 'scrapedAt',
];

/** Datasets the UI can preview and export. */
export const DATASETS = {
  search: 'search',
  details: 'details',
  reviews: 'reviews',
  // Observations and the run's own account of itself. Both were recorded and
  // then unreachable: the snapshot series is what every velocity number is
  // derived from, and the log holds the per-listing gap reporting.
  history: 'history',
  log: 'log',
  all: 'all',
};

/** One row per observation of one listing — the raw trend series. */
export const SNAPSHOT_FIELDS = [
  'listingId', 'observedAt', 'favorites', 'reviewCount', 'price', 'quantity',
];

/** One row per log entry, so a finished run can be audited after the fact. */
export const LOG_FIELDS = ['at', 'level', 'message', 'detail'];

export const RUN_STATUS = {
  IDLE: 'idle',
  RUNNING: 'running',
  STOPPING: 'stopping',
  DONE: 'done',
  ERROR: 'error',
};

/** runtime.sendMessage `type` values. */
export const MSG = {
  START_RUN: 'START_RUN',
  STOP_RUN: 'STOP_RUN',
  GET_STATE: 'GET_STATE',
  GET_RESULTS: 'GET_RESULTS',
  CLEAR_RESULTS: 'CLEAR_RESULTS',
  SCRAPE_ACTIVE_TAB: 'SCRAPE_ACTIVE_TAB',
  STATE_CHANGED: 'STATE_CHANGED',
  PARSE_HTML: 'PARSE_HTML',
  PARSE_DETAIL: 'PARSE_DETAIL',
  GET_DETAILS: 'GET_DETAILS',
  GET_REVIEWS: 'GET_REVIEWS',
  GET_HISTORY_ROWS: 'GET_HISTORY_ROWS',
  SAVE_SETTINGS: 'SAVE_SETTINGS',
  GET_SETTINGS: 'GET_SETTINGS',
};

export const STORAGE_KEYS = {
  settings: 'settings',
  state: 'runState',
  results: 'results',
  details: 'details',
  reviews: 'reviews',
  history: 'history',
};

export const ETSY_LISTING_URL = 'https://www.etsy.com/listing/';

export const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

/** HTTP statuses worth retrying (plus network errors, handled separately). */
export const RETRYABLE_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504, 520, 522, 524]);
