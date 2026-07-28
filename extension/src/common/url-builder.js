/**
 * Etsy search URL construction.
 *
 * Etsy has used both `min`/`max` and `min_price`/`max_price` for the price
 * facet depending on the surface, so we emit both — extra params are ignored
 * server-side and this keeps the filter working across A/B variants.
 */

import { ETSY_SEARCH_URL, SORT_ORDERS } from './constants.js';

/**
 * @param {object} opts
 * @param {string} opts.query        search keyword (required)
 * @param {number} [opts.page=1]     1-based page number
 * @param {string} [opts.sortOrder]  most_relevant | price_asc | price_desc | date_desc
 * @param {number|null} [opts.minPrice]
 * @param {number|null} [opts.maxPrice]
 * @param {string} [opts.shipTo]     ISO-3166 alpha-2 country code, e.g. "US"
 * @param {boolean} [opts.freeShippingOnly]
 * @returns {string} absolute Etsy search URL
 */
export function buildSearchUrl({
  query,
  page = 1,
  sortOrder = 'most_relevant',
  minPrice = null,
  maxPrice = null,
  shipTo = '',
  freeShippingOnly = false,
} = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('buildSearchUrl: "query" is required');

  const url = new URL(ETSY_SEARCH_URL);
  url.searchParams.set('q', q);

  const pageNum = Number(page) || 1;
  if (pageNum > 1) url.searchParams.set('page', String(pageNum));

  const order = SORT_ORDERS[sortOrder];
  if (order && order !== 'most_relevant') url.searchParams.set('order', order);

  if (isFiniteNumber(minPrice)) {
    url.searchParams.set('min', trimNum(minPrice));
    url.searchParams.set('min_price', trimNum(minPrice));
  }
  if (isFiniteNumber(maxPrice)) {
    url.searchParams.set('max', trimNum(maxPrice));
    url.searchParams.set('max_price', trimNum(maxPrice));
  }

  const country = String(shipTo ?? '').trim().toUpperCase();
  if (country) url.searchParams.set('ship_to', country);

  if (freeShippingOnly) url.searchParams.set('free_shipping', 'true');

  // Mirrors what the site itself appends when you page through results.
  url.searchParams.set('ref', pageNum > 1 ? 'pagination' : 'search_bar');

  return url.toString();
}

function isFiniteNumber(v) {
  return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
}

function trimNum(v) {
  const n = Number(v);
  return Number.isInteger(n) ? String(n) : String(n);
}
