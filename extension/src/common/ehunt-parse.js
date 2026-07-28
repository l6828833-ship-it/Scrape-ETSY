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
    panel: ['.eh-exe-tags-list', '[class*="eh-exe-"]'],
    /**
     * Evidence that EHunt is on the page even before its tag list renders.
     *
     * The extension id is EHunt's own, observed in the `chrome-extension://…`
     * icon URLs inside its panel markup. Hardcoding it is admittedly brittle, so
     * it is only ever a *hint* used to tell "EHunt is here but still loading"
     * apart from "EHunt is not installed" — two problems with different fixes.
     * Nothing is parsed from it.
     */
    presence: [
      '.eh-exe-tags-list',
      '[class*="eh-exe-"]',
      '[src*="pmpgnefoilpinnblccjddomajohmbpko"]',
      '[id^="ehunt" i]',
      '[class*="ehunt" i]',
    ],
    tagItem: ['.eh-exe-tags-list-item'],
    tagLabel: ['.el-tooltip__trigger', 'div:not([class])'],
    tagVolume: ['.eh-exe-tags-list-item-value'],
    /** Label/value pairs live in a table; scan generically. */
    cell: ['td', 'th', '.eh-exe-table-cell', 'div'],
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

  /** "14.8M" -> 14800000, "656.9K" -> 656900, "68" -> 68, "N/A" -> null. */
  function parseCompactNumber(raw) {
    const s = String(raw == null ? '' : raw).replace(/[()\s,]/g, '');
    if (!s || /^n\/?a$/i.test(s)) return null;
    const m = s.match(/^-?([\d.]+)\s*([KMB])?/i);
    if (!m) return null;
    const value = Number.parseFloat(m[1]);
    if (!Number.isFinite(value)) return null;
    const factor = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
    return Math.round(value * factor);
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

  /**
   * Every DOM root worth searching: the document plus any open shadow roots.
   *
   * Injected UIs are routinely mounted in a shadow root so their CSS cannot
   * collide with the host page's, and `document.querySelector` does not descend
   * into one. Without this, a panel that is plainly visible on screen reads as
   * "not installed". Closed shadow roots and cross-origin iframes stay
   * unreachable — nothing an extension does from the page can change that.
   */
  function domRoots(doc) {
    const roots = [doc];
    if (!doc || typeof doc.querySelectorAll !== 'function') return roots;
    const walk = (root, depth) => {
      if (depth > 5) return;
      let nodes;
      try {
        nodes = root.querySelectorAll('*');
      } catch (_) {
        return;
      }
      for (const el of nodes) {
        if (el && el.shadowRoot) {
          roots.push(el.shadowRoot);
          walk(el.shadowRoot, depth + 1);
        }
      }
    };
    try {
      walk(doc, 0);
    } catch (_) { /* hostile DOM; the document alone will do */ }
    return roots;
  }

  /** The root that actually holds EHunt's panel, or null. */
  function findPanelRoot(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return null;
    // Fast path: the overwhelmingly common case, no shadow walk needed.
    if (first(doc, SELECTORS.panel)) return doc;
    for (const root of domRoots(doc)) {
      if (root !== doc && first(root, SELECTORS.panel)) return root;
    }
    return null;
  }

  /** True when the EHunt panel has rendered on this page. */
  function isPresent(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return false;
    return Boolean(findPanelRoot(doc));
  }

  /**
   * True when EHunt is on the page but has not necessarily drawn its tag list.
   *
   * Distinguishing this from isPresent() is the whole point: "EHunt is loading"
   * means wait longer, "EHunt is absent" means install or enable it.
   */
  function isInstalledOnPage(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return false;
    for (const root of domRoots(doc)) {
      if (first(root, SELECTORS.presence)) return true;
    }
    try {
      return /\bEHunt\b/i.test(text(doc.body).slice(0, 40000));
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
   * Label/value pairs from the stats table. Finds an element whose whole text is
   * a known label, then reads the next element with content — robust to whether
   * EHunt uses a table, a grid or nested divs.
   */
  function readStats(doc) {
    const out = {};
    for (const cell of all(doc, SELECTORS.cell)) {
      const label = text(cell).replace(/[:\s]+$/, '').toLowerCase();
      const field = LABELS[label];
      if (!field || out[field] !== undefined) continue;
      const value = nextValue(cell);
      if (value) out[field] = value;
    }
    return out;
  }

  function nextValue(cell) {
    let node = cell.nextElementSibling;
    for (let i = 0; node && i < 3; i += 1) {
      const value = text(node);
      if (value) return value;
      node = node.nextElementSibling;
    }
    // Fall back to a value nested inside the same cell after the label.
    const parentText = text(cell.parentElement);
    const own = text(cell);
    if (parentText && own && parentText.length > own.length) {
      return parentText.slice(parentText.indexOf(own) + own.length).trim() || null;
    }
    return null;
  }

  /**
   * Parse everything EHunt offers on this page.
   * @param {Document} doc
   * @returns {?object} partial record, or null when the panel is absent
   */
  function parsePanel(doc) {
    // Parse from whichever root holds the panel, so a shadow-mounted panel reads
    // exactly like one in the light DOM.
    const root = findPanelRoot(doc);
    if (!root) return null;
    const { tags, tagVolumes } = readTags(root);
    const stats = readStats(root);

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

    // EHunt's own estimates keep their prefixed names.
    for (const field of ['ehuntEstimatedSales', 'ehuntEstimatedRevenue',
      'ehuntConversionRate', 'ehuntReviewRatio', 'productType']) {
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
    isPresent,
    isInstalledOnPage,
    findPanelRoot,
    domRoots,
    parsePanel,
    readTags,
    readStats,
    mergeEhuntRecord,
    parseCompactNumber,
    parsePercent,
    parseIsoDate,
  };
});
