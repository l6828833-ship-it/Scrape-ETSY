/**
 * Optional enrichment through Etsy's Open API v3.
 *
 * Why this exists: a listing's 13 tags are not rendered verbatim anywhere in the
 * public HTML, so scraping can only ever recover a proxy for them (the
 * `/market/` and `/search?q=` links). The API returns the actual `tags` array —
 * along with the full description, favourite count and stock — for any active
 * listing, using nothing but an application key. `GET /v3/application/listings/
 * {listing_id}` needs the `x-api-key` header; only write/private endpoints
 * require an OAuth scope, so no shop ownership or user consent is involved.
 *   https://developers.etsy.com/documentation/essentials/requests
 *   https://developers.etsy.com/documentation/essentials/authentication
 *
 * A key is free from https://www.etsy.com/developers/register. This module is a
 * strict upgrade path: with no key configured, nothing here runs and the scraper
 * behaves exactly as before.
 *
 * The mapper is deliberately defensive — every field is read through a type
 * guard and absent fields stay null — because the response shape is documented
 * but not verifiable from this repo's offline test environment.
 */

const API_ROOT = 'https://api.etsy.com/v3/application';

/** Etsy publishes 10 requests/second; stay well under it. */
export const API_RATE = { minIntervalMs: 150, dailyGuess: 10000 };

export const API_PERMISSION = { origins: ['https://api.etsy.com/*'] };

// ------------------------------------------------------------------ coercion

function str(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s || null;
}

function int(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function bool(value) {
  return value === true || value === 'true' || value === 1;
}

function strArray(value) {
  if (!Array.isArray(value)) return null;
  const out = value.map((v) => str(v)).filter(Boolean);
  return out.length ? out : null;
}

/** v3 money objects are {amount, divisor, currency_code}. */
function money(value) {
  if (!value || typeof value !== 'object') return { price: null, currency: null };
  const amount = Number(value.amount);
  const divisor = Number(value.divisor);
  const price = Number.isFinite(amount) && Number.isFinite(divisor) && divisor > 0
    ? Math.round((amount / divisor) * 100) / 100
    : null;
  return { price, currency: str(value.currency_code) };
}

function isoFromEpoch(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString().slice(0, 10);
}

const STATE_TO_AVAILABILITY = {
  active: 'InStock',
  sold_out: 'OutOfStock',
  inactive: 'Discontinued',
  expired: 'Discontinued',
  draft: 'PreOrder',
};

// -------------------------------------------------------------------- mapping

/**
 * Translate an API listing into this project's detail-record vocabulary.
 * @param {object} payload raw JSON from getListing (optionally ?includes=Shop)
 * @returns {?object} partial detail record, or null when unusable
 */
export function mapApiListing(payload) {
  const listing = payload && Array.isArray(payload.results) ? payload.results[0] : payload;
  if (!listing || typeof listing !== 'object') return null;
  const id = str(listing.listing_id);
  if (!id) return null;

  const { price, currency } = money(listing.price);
  const record = {
    listingId: id,
    url: str(listing.url),
    title: str(listing.title),
    description: str(listing.description),
    // The reason this module exists: the real tag array, not a link-derived proxy.
    tags: strArray(listing.tags),
    materials: strArray(listing.materials),
    favoritesCount: int(listing.num_favorers),
    viewsCount: int(listing.views),
    quantityAvailable: int(listing.quantity),
    price,
    currency,
    availability: STATE_TO_AVAILABILITY[str(listing.state) || ''] || null,
    listingCreationDate: isoFromEpoch(
      listing.original_creation_timestamp || listing.creation_timestamp,
    ),
    isPersonalizable: bool(listing.is_personalizable),
    personalizationRequired: bool(listing.personalization_is_required),
    taxonomyId: int(listing.taxonomy_id),
  };
  record.tagCount = record.tags ? record.tags.length : null;

  // `?includes=Shop` attaches the shop, which carries the sales total.
  const shop = listing.shop && typeof listing.shop === 'object' ? listing.shop : null;
  if (shop) {
    record.shopName = str(shop.shop_name);
    record.shopTotalSales = int(shop.transaction_sold_count);
    record.shopReviewCount = int(shop.review_count);
    if (shop.review_average !== undefined && shop.review_average !== null) {
      const avg = Number(shop.review_average);
      if (Number.isFinite(avg) && avg >= 0 && avg <= 5) record.shopRating = avg;
    }
    if (shop.url) record.shopUrl = str(shop.url);
  }

  // Drop keys we could not populate so the merge never overwrites scraped data
  // with an API null.
  for (const key of Object.keys(record)) {
    if (record[key] === null || record[key] === undefined) delete record[key];
  }
  return record;
}

/**
 * Fetch one listing.
 * @param {string} listingId
 * @param {string} apiKey Etsy App API keystring
 * @param {{signal?:AbortSignal, includeShop?:boolean, timeoutMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, record:?object, status:number, error:?string,
 *   retryable:boolean, fatal:boolean}>} `fatal` means stop using the API for
 *   this run (bad key, suspended app) rather than retrying every listing.
 */
export async function fetchListingFromApi(listingId, apiKey, opts = {}) {
  const { signal, includeShop = true, timeoutMs = 20000 } = opts;
  if (!listingId) return fail(0, 'missing listing id', { fatal: false });
  if (!apiKey) return fail(0, 'no API key configured', { fatal: true });

  const url = `${API_ROOT}/listings/${encodeURIComponent(listingId)}`
    + (includeShop ? '?includes=Shop' : '');

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      // No cookies: this is a keyed API call, not a browsing request.
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'x-api-key': apiKey, Accept: 'application/json' },
    });

    if (!response.ok) {
      const status = response.status;
      // 401/403 = the key itself is the problem; retrying every listing with a
      // broken key just burns the run.
      const fatal = status === 401 || status === 403;
      let detail = `HTTP ${status}`;
      try {
        const body = await response.json();
        if (body && body.error) detail = `HTTP ${status}: ${String(body.error).slice(0, 160)}`;
      } catch (_) { /* non-JSON error body */ }
      return fail(status, detail, { fatal, retryable: status === 429 || status >= 500 });
    }

    const json = await response.json();
    const record = mapApiListing(json);
    if (!record) return fail(response.status, 'API returned no usable listing', { fatal: false });
    return { ok: true, record, status: response.status, error: null, retryable: false, fatal: false };
  } catch (err) {
    const timedOut = controller.signal.aborted && !(signal && signal.aborted);
    return fail(0, timedOut ? `timeout after ${timeoutMs}ms` : String((err && err.message) || err),
      { retryable: true });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function fail(status, error, flags = {}) {
  return {
    ok: false,
    record: null,
    status,
    error,
    retryable: Boolean(flags.retryable),
    fatal: Boolean(flags.fatal),
  };
}

/**
 * Merge API data over a scraped record.
 *
 * The API wins for everything it actually returns — it is the authoritative
 * source, and it is the only place the real tags exist. Fields the API does not
 * cover (cart count, star seller, shop location/age, reviews, ratings) keep
 * their scraped values, so this is additive rather than a replacement.
 *
 * @returns {object} merged record with `tagSource` provenance
 */
export function mergeApiRecord(scraped, apiRecord) {
  const base = scraped || {};
  // Whatever produced the tags already recorded how it got them. Re-deriving the
  // provenance here overwrote it: tags read from the EHunt panel came out
  // labelled "page-links", so the one field whose job is to say how much to
  // trust the tags was lying about them.
  const keepSource = () => base.tagSource
    || (base.tags && base.tags.length ? 'page-links' : null);

  if (!apiRecord) {
    return { ...base, tagSource: keepSource(), apiEnriched: false };
  }
  const merged = { ...base };
  for (const [key, value] of Object.entries(apiRecord)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && !value.length) continue;
    merged[key] = value;
  }
  merged.tagSource = apiRecord.tags && apiRecord.tags.length ? 'api' : keepSource();
  merged.apiEnriched = true;
  return merged;
}
