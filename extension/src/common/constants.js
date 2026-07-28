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
  'scrapedAt',
];

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
  SAVE_SETTINGS: 'SAVE_SETTINGS',
  GET_SETTINGS: 'GET_SETTINGS',
};

export const STORAGE_KEYS = {
  settings: 'settings',
  state: 'runState',
  results: 'results',
};

export const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

/** HTTP statuses worth retrying (plus network errors, handled separately). */
export const RETRYABLE_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504, 520, 522, 524]);
