/**
 * Reads the EHunt (Etsy Rank Tool) panel when it is present on a listing page.
 *
 * Why: EHunt renders a listing's actual 13 tags — with their search volumes —
 * plus its own estimates for sales, revenue, views and conversion rate. All of
 * it lands in the normal page DOM, so a content script in an isolated world can
 * read it (isolated worlds share the DOM, only JS state is separated). If you
 * already run EHunt, that is the cheapest possible source for the tag set.
 *
 * Provenance rules this module follows:
 *   * Tags read here are labelled `tagSource: 'ehunt'` — a third-party panel,
 *     not Etsy. The Etsy API (tagSource 'api') still outranks it.
 *   * EHunt's sales/revenue/conversion figures are *estimates* produced by
 *     EHunt, not facts published by Etsy. They are stored under `ehunt*` names
 *     so nobody mistakes them for observed data, and they never overwrite a
 *     value we read from Etsy itself.
 *   * Requires the tab engine: EHunt only injects into a rendered page, so a
 *     worker `fetch()` of the HTML will never contain it.
 *
 * Selectors come from EHunt's rendered markup (`.eh-exe-tags-list-item` and its
 * label/value table). They are third-party markup and may change without notice,
 * so every read is optional and failure is silent.
 */
(function (root, factory) {
  const api = factory();
  root.EtsyEhunt = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SELECTORS = {
    // `#etsy-rank-tool-product-table` is the id EHunt mounts its Vue app on, and
    // is the most reliable single marker that the panel exists.
    panel: [
      '#etsy-rank-tool-product-table',
      '.eh-product-detail',
      '.eh-exe-tags-list',
      '[class*="eh-product-detail"]',
      '[class*="eh-exe-"]',
    ],
    tagItem: ['.eh-exe-tags-list-item'],
    tagLabel: ['.el-tooltip__trigger', 'div:not([class])'],
    tagVolume: ['.eh-exe-tags-list-item-value'],
    /** Label/value pairs live in a table; scan generically. */
    cell: ['td', 'th', '.eh-exe-table-cell', 'div'],
    /**
     * The period-over-period delta EHunt appends inside each value cell. It has
     * to be removed before the cell is read as a number — see parseCompactNumber.
     */
    growth: [
      '.eh-product-detail-content-value-growth',
      '[class*="value-growth"]',
      '[class*="-growth"]',
    ],
    /** Element Plus rating widget; carries the shop's rating in aria-valuenow. */
    rating: ['.el-rate[aria-valuenow]', '[role="slider"][aria-valuenow]'],
  };

  /** EHunt table labels -> our field names. */
  const LABELS = {
    'product type': 'productType',
    'total sales': 'ehuntEstimatedSales',
    'total revenue': 'ehuntEstimatedRevenue',
    'total views': 'ehuntTotalViews',
    'total reviews': 'ehuntTotalReviews',
    'total favorites': 'ehuntTotalFavorites',
    'total favourites': 'ehuntTotalFavorites',
    'avg.conv.rate': 'ehuntConversionRate',
    'avg conv rate': 'ehuntConversionRate',
    'review ratio': 'ehuntReviewRatio',
    'release time': 'ehuntReleaseDate',
    'ships from': 'ehuntShipsFrom',
    category: 'ehuntCategory',
    'store name': 'ehuntShopName',
    'store sales': 'ehuntShopSales',
    price: 'ehuntPriceLine',
    'other data': 'ehuntOtherData',
  };

  /**
   * Where a cell's delta is published, per field.
   *
   * Kept as an explicit map rather than appending "Growth" to the field name, so
   * the exported column names stay readable (`ehuntSalesGrowth`, not
   * `ehuntEstimatedSalesGrowth`).
   */
  const GROWTH_FIELDS = {
    ehuntEstimatedSales: 'ehuntSalesGrowth',
    ehuntEstimatedRevenue: 'ehuntRevenueGrowth',
    ehuntTotalViews: 'ehuntViewsGrowth',
    ehuntTotalReviews: 'ehuntReviewsGrowth',
    ehuntTotalFavorites: 'ehuntFavoritesGrowth',
    ehuntShopSales: 'ehuntShopSalesGrowth',
  };

  function text(el) {
    if (!el) return '';
    return String(el.textContent == null ? '' : el.textContent).replace(/\s+/g, ' ').trim();
  }

  function all(root, list) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    for (const sel of list) {
      try {
        const found = Array.from(root.querySelectorAll(sel));
        if (found.length) return found;
      } catch (_) { /* keep trying */ }
    }
    return [];
  }

  function first(root, list) {
    if (!root || typeof root.querySelector !== 'function') return null;
    for (const sel of list) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch (_) { /* keep trying */ }
    }
    return null;
  }

  /**
   * "14.8M" -> 14800000, "656.9K" -> 656900, "68" -> 68, "N/A" -> null.
   *
   * Refuses anything holding more than one number, and that refusal is the whole
   * point. EHunt renders a period-over-period delta immediately after each
   * figure, so the Total Sales cell reads "68" followed by "6" — and because
   * whitespace used to be stripped before matching, that silently became **686**.
   * Store Sales "775" + "43" became 77543, and both were gap-filled into
   * shopTotalSales and favoritesCount as if Etsy had published them.
   *
   * splitValueCell() removes the delta before we get here, so this is the second
   * line of defence: if EHunt ever decorates a cell in some new way, the result
   * is a missing number rather than an invented one.
   */
  function parseCompactNumber(raw) {
    const s = String(raw == null ? '' : raw).trim()
      // Space-grouped thousands ("1 234", including the non-breaking variants)
      // are one number, so they must be joined before tokenising — otherwise the
      // multi-token rule below would reject a perfectly good figure.
      .replace(/(\d)[\s\u00a0\u202f](?=\d{3}(?!\d))/g, '$1');
    if (!s || /^n\/?a$/i.test(s)) return null;
    const tokens = s.match(/-?\d[\d.,]*\s*[KMB]?/gi) || [];
    if (tokens.length !== 1) return null;
    const cleaned = tokens[0].replace(/[\s,]/g, '');
    const m = cleaned.match(/^-?([\d.]+)([KMB])?$/i);
    if (!m) return null;
    const value = Number.parseFloat(m[1]);
    if (!Number.isFinite(value)) return null;
    const factor = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
    const signed = /^-/.test(cleaned) ? -value : value;
    return Math.round(signed * factor);
  }

  /** "10.29%" -> 10.29 */
  function parsePercent(raw) {
    const m = String(raw == null ? '' : raw).match(/(-?[\d.]+)\s*%/);
    if (!m) return null;
    const n = Number.parseFloat(m[1]);
    return Number.isFinite(n) ? n : null;
  }

  function parseIsoDate(raw) {
    const s = String(raw == null ? '' : raw).trim();
    const iso = s.match(/\d{4}-\d{2}-\d{2}/);
    if (iso) return iso[0];
    const parsed = Date.parse(s);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
  }

  /** True when the EHunt panel has rendered on this page. */
  function isPresent(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return false;
    if (first(doc, SELECTORS.panel)) return true;
    try {
      return /EHunt/i.test(text(doc.body).slice(0, 40000));
    } catch (_) {
      return false;
    }
  }

  /**
   * The real tag list with EHunt's search-volume figure per tag.
   * @returns {{tags:string[], tagVolumes:Object<string,number>}}
   */
  function readTags(doc) {
    const tags = [];
    const tagVolumes = {};
    const seen = new Set();

    for (const item of all(doc, SELECTORS.tagItem)) {
      const volumeEl = first(item, SELECTORS.tagVolume);
      const volumeText = text(volumeEl);
      // The label is the item's text minus the volume suffix.
      let label = text(first(item, SELECTORS.tagLabel));
      if (!label || label === volumeText) {
        label = text(item).replace(volumeText, '').trim();
      }
      label = label.replace(/\s*\([\d.,]+[KMB]?\)\s*$/i, '').trim();
      const key = label.toLowerCase();
      if (!label || label.length > 80 || seen.has(key)) continue;
      seen.add(key);
      tags.push(label);
      const volume = parseCompactNumber(volumeText);
      if (volume !== null) tagVolumes[label] = volume;
      if (tags.length >= 13) break;
    }
    return { tags, tagVolumes };
  }

  /**
   * Separate a value cell's figure from the delta EHunt appends to it.
   *
   * Works on a clone so the live page is never mutated — this runs inside the
   * user's own browser tab, on someone else's UI.
   */
  function splitValueCell(cell) {
    if (!cell) return { value: '', growth: '' };
    let clone;
    try {
      clone = cell.cloneNode(true);
    } catch (_) {
      return { value: text(cell), growth: '' };
    }
    const deltas = all(clone, SELECTORS.growth);
    const growth = deltas.map(text).filter(Boolean).join(' ');
    for (const node of deltas) {
      if (node.parentNode) node.parentNode.removeChild(node);
    }
    return { value: text(clone), growth };
  }

  function hexToRgb(raw) {
    const m = String(raw || '').trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!m) return null;
    let hex = m[1];
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    return {
      r: Number.parseInt(hex.slice(0, 2), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      b: Number.parseInt(hex.slice(4, 6), 16),
    };
  }

  /**
   * Is the delta a rise or a fall? 1, -1, or 0 for "cannot tell".
   *
   * EHunt states direction only through the arrow glyph's colour — a green
   * up-arrow, and presumably a red down-arrow. The number itself is unsigned, so
   * exporting a bare "6" would be claiming a rise on a listing that might be
   * falling. Direction is therefore classified from the fill colour (green
   * channel dominant = up, red dominant = down) and the delta is **dropped
   * entirely** when neither applies. Some cells, such as Total Revenue, ship the
   * delta with no arrow at all, and those are exactly the ones we must not guess.
   */
  function growthDirection(cell) {
    const delta = first(cell, SELECTORS.growth);
    if (!delta || typeof delta.querySelector !== 'function') return 0;
    let arrow = null;
    try {
      arrow = delta.querySelector('svg path[fill], svg [fill], path[fill]');
    } catch (_) {
      arrow = null;
    }
    if (!arrow) return 0;

    // A flipped or rotated glyph means the same artwork is being reused to mean
    // the opposite thing, and we cannot tell which. Refuse rather than guess.
    const transform = `${arrow.getAttribute('transform') || ''} ${(arrow.getAttribute('style') || '')}`;
    const svg = arrow.ownerSVGElement || null;
    const svgTransform = svg
      ? `${svg.getAttribute('transform') || ''} ${(svg.getAttribute('style') || '')}` : '';
    if (/rotate|scale\(\s*-|scaleY\(\s*-|matrix/i.test(`${transform} ${svgTransform}`)) return 0;

    const rgb = hexToRgb(arrow.getAttribute('fill'));
    if (!rgb) return 0;
    // Green-dominant is the only direction we have ever actually observed, so it
    // is the only one claimed. A red-dominant glyph is *probably* a fall, but
    // Element Plus also paints warning states in red-dominant amber, and being
    // wrong about the sign is worse than reporting nothing — so anything that is
    // not clearly a rise yields no growth figure at all.
    return rgb.g > rgb.r + 24 ? 1 : 0;
  }

  /**
   * Label/value pairs from the stats table. Finds an element whose whole text is
   * a known label, then reads the next element with content — robust to whether
   * EHunt uses a table, a grid or nested divs.
   *
   * @returns {{stats:Object<string,string>, growth:Object<string,number>}}
   */
  /**
   * Narrow a document down to EHunt's own panel.
   *
   * Scanning the whole document for label cells is not safe: "Price" is an
   * ordinary word that sellers use as a header in their own description tables,
   * and first-match-in-document-order would let a seller's price chart become
   * `ehuntPrice`. Every label lookup is therefore scoped to the panel subtree.
   */
  function panelRoot(doc) {
    return first(doc, SELECTORS.panel) || doc;
  }

  function readStats(doc) {
    const stats = {};
    const growth = {};
    const cells = {};
    for (const cell of all(panelRoot(doc), SELECTORS.cell)) {
      const label = text(cell).replace(/[:\s]+$/, '').toLowerCase();
      const field = LABELS[label];
      if (!field || stats[field] !== undefined) continue;

      const valueCell = nextValueCell(cell);
      if (!valueCell) {
        const nested = nestedValue(cell);
        if (nested) stats[field] = nested;
        continue;
      }

      const split = splitValueCell(valueCell);
      if (split.value) {
        stats[field] = split.value;
        cells[field] = valueCell;
      }
      // A delta is only meaningful next to a figure. An "N/A" cell that still
      // carries one would otherwise export growth for a value we do not have.
      const baseIsNumeric = parseCompactNumber(split.value) !== null;
      if (split.growth && baseIsNumeric && GROWTH_FIELDS[field]) {
        const direction = growthDirection(valueCell);
        const magnitude = parseCompactNumber(split.growth);
        if (direction !== 0 && magnitude !== null) {
          growth[GROWTH_FIELDS[field]] = direction * Math.abs(magnitude);
        }
      }
    }
    return { stats, growth, cells };
  }

  function nextValueCell(cell) {
    let node = cell.nextElementSibling;
    for (let i = 0; node && i < 3; i += 1) {
      if (text(node)) return node;
      node = node.nextElementSibling;
    }
    return null;
  }

  /** A value nested inside the same element, after the label text. */
  function nestedValue(cell) {
    const parentText = text(cell.parentElement);
    const own = text(cell);
    if (parentText && own && parentText.length > own.length) {
      return parentText.slice(parentText.indexOf(own) + own.length).trim() || null;
    }
    return null;
  }

  /**
   * "USD Price:0.91 USD 1.82 50% off" -> the sale price, the struck-through
   * original, and the discount. Kept under `ehunt*` names and never merged over
   * Etsy's own price: EHunt normalises to USD, so mixing the two would silently
   * mix currencies on a non-USD listing.
   */
  /**
   * Money amounts, thousands separators included.
   *
   * A naive `\d+(?:[.,]\d+)?` stops at the group separator, so "1,234.56" was
   * read as two amounts — 1.234 and 56 — turning a $1,234.56 listing into $1.23
   * with a $56 "original price". Every four-figure listing hit that.
   */
  const AMOUNT = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

  function parseAmount(raw) {
    const m = String(raw == null ? '' : raw).match(AMOUNT);
    if (!m) return null;
    const n = Number.parseFloat(m[0].replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  function parsePriceLine(raw, cell) {
    const s = String(raw == null ? '' : raw);
    const out = {};

    const off = s.match(/(\d+(?:\.\d+)?)\s*%\s*off/i);
    if (off) {
      const pct = Number.parseFloat(off[1]);
      if (Number.isFinite(pct)) out.ehuntDiscountPercent = pct;
    }

    // Strip the discount phrase before anything else: it contributes a number
    // that is not a price, and the word "OFF" is three capitals that the currency
    // pattern below happily matched.
    const withoutDiscount = s.replace(/(\d+(?:\.\d+)?)\s*%\s*off/i, ' ');
    const currency = withoutDiscount.match(/\b(?!OFF\b)([A-Z]{3})\b/);
    if (currency) out.ehuntCurrency = currency[1];

    // The original price is marked structurally, by a strike-through, so use that
    // rather than inferring it from "whichever number is biggest" — on a listing
    // showing a price *range* the larger figure is not a former price at all, and
    // treating it as one fabricates a discount.
    let struckText = '';
    const struck = cell ? first(cell, ['[style*="line-through"]', 's', 'del', 'strike']) : null;
    if (struck) {
      struckText = text(struck);
      const original = parseAmount(struckText);
      if (original !== null) out.ehuntOriginalPrice = original;
    }

    const saleText = struckText
      ? withoutDiscount.replace(struckText, ' ')
      : withoutDiscount;
    const price = parseAmount(saleText);
    if (price !== null) out.ehuntPrice = price;

    // Guard against a strike-through that is not actually higher.
    if (out.ehuntOriginalPrice !== undefined && out.ehuntPrice !== undefined
      && out.ehuntOriginalPrice <= out.ehuntPrice) {
      delete out.ehuntOriginalPrice;
    }
    return out;
  }

  /** "BestSeller Stocks : 57" -> the badge and the stock level. */
  function parseOtherData(raw) {
    const s = String(raw == null ? '' : raw);
    const out = {};
    if (/best\s*seller/i.test(s)) out.ehuntBestSeller = true;
    const stock = s.match(/stocks?\s*:?\s*(\d[\d.,]*)/i);
    if (stock) {
      const n = parseCompactNumber(stock[1]);
      if (n !== null) out.ehuntStock = n;
    }
    return out;
  }

  /** The shop's star rating, published as aria-valuenow on the rating widget. */
  function readShopRating(doc) {
    const widget = first(panelRoot(doc), SELECTORS.rating);
    if (!widget) return null;
    const value = Number.parseFloat(widget.getAttribute('aria-valuenow'));
    if (!Number.isFinite(value) || value < 0 || value > 5) return null;
    return value;
  }

  /**
   * Parse everything EHunt offers on this page.
   * @param {Document} doc
   * @returns {?object} partial record, or null when the panel is absent
   */
  function parsePanel(doc) {
    if (!isPresent(doc)) return null;
    const { tags, tagVolumes } = readTags(panelRoot(doc));
    const { stats, growth, cells } = readStats(doc);

    const record = {};
    if (tags.length) {
      record.tags = tags;
      record.tagCount = tags.length;
      record.tagSource = 'ehunt';
      if (Object.keys(tagVolumes).length) record.tagVolumes = tagVolumes;
    }

    if (stats.productType) {
      record.productType = stats.productType;
      // "Digital" / "Digital download" vs "Physical".
      if (/digital/i.test(stats.productType)) record.isDigital = true;
      else if (/physical/i.test(stats.productType)) record.isDigital = false;
    }

    assignNumber(record, 'ehuntEstimatedSales', stats.ehuntEstimatedSales);
    assignNumber(record, 'ehuntEstimatedRevenue', stats.ehuntEstimatedRevenue);
    assignNumber(record, 'ehuntTotalViews', stats.ehuntTotalViews);
    assignNumber(record, 'ehuntTotalReviews', stats.ehuntTotalReviews);
    assignNumber(record, 'ehuntTotalFavorites', stats.ehuntTotalFavorites);
    assignNumber(record, 'ehuntShopSales', stats.ehuntShopSales);

    const conversion = parsePercent(stats.ehuntConversionRate);
    if (conversion !== null) record.ehuntConversionRate = conversion;
    const ratio = parsePercent(stats.ehuntReviewRatio);
    if (ratio !== null) record.ehuntReviewRatio = ratio;

    const released = parseIsoDate(stats.ehuntReleaseDate);
    if (released) record.ehuntReleaseDate = released;

    if (stats.ehuntCategory) record.ehuntCategory = stats.ehuntCategory.replace(/\s*>\s*/g, ' > ');
    if (stats.ehuntShipsFrom) record.ehuntShipsFrom = stats.ehuntShipsFrom;
    if (stats.ehuntShopName) record.ehuntShopName = stats.ehuntShopName;

    Object.assign(record, parsePriceLine(stats.ehuntPriceLine, cells.ehuntPriceLine));
    Object.assign(record, parseOtherData(stats.ehuntOtherData));
    Object.assign(record, growth);

    // EHunt puts its rating widget beside the store name, so this is the *shop's*
    // rating. It is never merged into the listing's `rating`, which is a
    // different number entirely.
    const shopRating = readShopRating(doc);
    if (shopRating !== null) record.ehuntShopRating = shopRating;

    record.ehuntPanel = true;
    return record;
  }

  function assignNumber(record, field, raw) {
    const value = parseCompactNumber(raw);
    if (value !== null) record[field] = value;
  }

  /**
   * Merge EHunt data onto a scraped record.
   *
   * Etsy-observed values always win; EHunt only fills gaps, except for tags,
   * where it supplies the genuine list that the page itself never exposes. The
   * Etsy API (tagSource 'api') still outranks EHunt.
   */
  function mergeEhuntRecord(scraped, panel) {
    const base = scraped || {};
    if (!panel) return { ...base, ehuntPanel: false };
    const merged = { ...base };

    const apiTags = base.tagSource === 'api' && base.tags && base.tags.length;
    if (panel.tags && panel.tags.length && !apiTags) {
      merged.tags = panel.tags;
      merged.tagCount = panel.tagCount;
      merged.tagSource = 'ehunt';
      if (panel.tagVolumes) merged.tagVolumes = panel.tagVolumes;
    } else if (panel.tagVolumes && apiTags) {
      // Keep API tags, but volumes are still useful context.
      merged.tagVolumes = panel.tagVolumes;
    }

    // Gap-fill Etsy-equivalent fields only.
    fillIfEmpty(merged, 'isDigital', panel.isDigital);
    fillIfEmpty(merged, 'favoritesCount', panel.ehuntTotalFavorites);
    fillIfEmpty(merged, 'viewsCount', panel.ehuntTotalViews);
    fillIfEmpty(merged, 'shopTotalSales', panel.ehuntShopSales);
    fillIfEmpty(merged, 'listingCreationDate', panel.ehuntReleaseDate);
    fillIfEmpty(merged, 'categoryPath', panel.ehuntCategory);
    fillIfEmpty(merged, 'reviewCount', panel.ehuntTotalReviews);
    // Deliberately NOT gap-filled, each for its own reason:
    //
    //   * `quantityAvailable` ← ehuntStock. metrics.js snapshots quantity into
    //     the trend history, and once stored an EHunt-sourced figure is
    //     indistinguishable from an Etsy-observed one. The panel is present on
    //     some runs and not others, so the series would alternate between two
    //     independently-derived numbers and manufacture stock movement — in a
    //     feature whose entire purpose is detecting real movement.
    //   * `shopLocation` ← ehuntShipsFrom. EHunt states a country; Etsy states a
    //     city and state. Mixing granularities in one column makes it unusable.
    //   * `shopName` ← ehuntShopName. Etsy's own page always supplies this, and
    //     EHunt's cell also hosts a rating widget whose score text can leak in.
    //   * `price` ← ehuntPrice. EHunt normalises to USD, so this would silently
    //     mix currencies on a non-USD listing.
    //   * `rating` ← ehuntShopRating. That widget sits beside the *store* name,
    //     so it is the shop's rating, not this listing's.
    //
    // All five stay available under their own `ehunt*` names.

    // EHunt's own estimates keep their prefixed names.
    for (const field of ['ehuntEstimatedSales', 'ehuntEstimatedRevenue',
      'ehuntConversionRate', 'ehuntReviewRatio', 'productType',
      'ehuntSalesGrowth', 'ehuntRevenueGrowth', 'ehuntViewsGrowth',
      'ehuntReviewsGrowth', 'ehuntFavoritesGrowth', 'ehuntShopSalesGrowth',
      'ehuntShopRating', 'ehuntStock', 'ehuntBestSeller', 'ehuntShipsFrom',
      'ehuntPrice', 'ehuntOriginalPrice', 'ehuntDiscountPercent', 'ehuntCurrency']) {
      if (panel[field] !== undefined && panel[field] !== null) merged[field] = panel[field];
    }
    merged.ehuntPanel = true;
    return merged;
  }

  function fillIfEmpty(target, field, value) {
    if (value === null || value === undefined) return;
    const current = target[field];
    if (current === null || current === undefined || current === '') target[field] = value;
  }

  return {
    SELECTORS,
    LABELS,
    GROWTH_FIELDS,
    isPresent,
    panelRoot,
    parseAmount,
    parsePanel,
    readTags,
    readStats,
    readShopRating,
    splitValueCell,
    growthDirection,
    parsePriceLine,
    parseOtherData,
    mergeEhuntRecord,
    parseCompactNumber,
    parsePercent,
    parseIsoDate,
  };
});
