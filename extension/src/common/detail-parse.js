/**
 * Etsy listing-page ("deep scrape") parser.
 *
 * Same UMD shape and the same three execution contexts as parse.js (offscreen
 * document, injected content script, Node tests) and it reuses that module's
 * primitives via `globalThis.EtsyParse`, so parse.js must be loaded first.
 *
 * Strategy mirrors the search parser: JSON-LD first (`Product` + `BreadcrumbList`
 * are both emitted on listing pages and are the most stable surface Etsy gives
 * us), then DOM/text heuristics for everything JSON-LD omits — favourites, cart
 * count, stock, variations, personalisation, materials, shop authority, reviews.
 *
 * Honesty notes about fields people often ask for:
 *   * `viewsCount` — Etsy stopped rendering view counts publicly years ago. The
 *     field exists and stays `null` unless a page actually exposes it, rather
 *     than being silently faked from something else.
 *   * `tags` — the 13 listing tags are not published verbatim either. We collect
 *     the `/market/<term>` links Etsy renders for the listing, which in practice
 *     mirror most of the tag set, and label them as such.
 *   * `cartCount` ("N people have this in their cart") IS public and is a far
 *     better real-time demand signal than views, so it is captured explicitly.
 */
(function (root, factory) {
  const api = factory();
  root.EtsyDetail = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Shared helpers from parse.js, resolved lazily so load order is flexible. */
  function base() {
    const P = globalThis.EtsyParse;
    if (!P) throw new Error('EtsyDetail requires common/parse.js to be loaded first');
    return P;
  }

  const SELECTORS = {
    title: ['h1[data-buy-box-listing-title]', 'h1.wt-text-body-01', 'h1'],
    description: [
      '[data-product-details-description-text-content]',
      '#wt-content-toggle-product-details-read-more p',
      '[data-id="description-text"]',
      '.listing-page-description',
    ],
    price: ['[data-buy-box-region="price"] .currency-value', 'p[data-buy-box-region="price"]', '.wt-text-title-larger .currency-value'],
    currencySymbol: ['[data-buy-box-region="price"] .currency-symbol', '.currency-symbol'],
    originalPrice: ['[data-buy-box-region="price"] .wt-text-strikethrough', '.wt-text-strikethrough'],
    favorites: ['a[href*="/favoriters"]', '[data-favorites-count]', 'a[href$="favoriters"]'],
    quantitySelect: ['select#inventory-quantity', 'select[name="quantity"]', 'select[data-selector="quantity"]'],
    variationSelect: ['select[data-variation-id]', 'select[id^="variation-selector"]', '.wt-select select'],
    personalization: [
      '#personalization-field',
      'textarea[data-personalization-field]',
      '[data-personalization-container] textarea',
      'textarea[maxlength][id*="personalization"]',
    ],
    shopLink: ['a[href*="/shop/"]'],
    shopName: ['[data-shop-name]', 'span.wt-text-title-small a[href*="/shop/"]'],
    breadcrumb: ['nav[aria-label="Breadcrumbs"] a', '.breadcrumb a', 'ol[data-breadcrumbs] a'],
    marketLinks: ['a[href*="/market/"]'],
    images: ['ul[data-carousel-pane-list] img', 'img[data-index]', 'img[src*="etsystatic"]'],
    detailBullets: ['[data-product-details-container] li', '#wt-content-toggle-product-details-read-more li', '.wt-product-details li'],
    reviewRegion: [
      '[data-reviews-container]',
      '#reviews',
      '[data-appears-component-name="listing_page_reviews"]',
    ],
    reviewCard: [
      '[data-review-region]',
      '.review-card',
      'li[data-region="review"]',
      '[data-appears-component-name="review_card"]',
    ],
    reviewText: ['[data-review-text]', 'p[id^="review-preview-toggle"]', '.review-text', 'p'],
    reviewPhoto: ['img[data-review-photo]', 'button img', 'img[src*="etsystatic"]'],
    reviewer: ['a[href*="/people/"]', '[data-reviewer-name]', 'p.wt-text-caption a'],
  };

  // ------------------------------------------------------------------ helpers

  function text(el) {
    if (!el) return '';
    return String(el.textContent == null ? '' : el.textContent).replace(/\s+/g, ' ').trim();
  }

  function first(root, list) {
    if (!root || typeof root.querySelector !== 'function') return null;
    for (const sel of list) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch (_) { /* invalid selector for this engine */ }
    }
    return null;
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

  function toInt(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number.parseInt(String(value).replace(/[^\d-]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  }

  /** Whole-page text, used for the many facts Etsy only renders as copy. */
  function pageText(doc) {
    const body = doc && (doc.body || doc.documentElement);
    return text(body);
  }

  /** "Jan 12, 2026" / "12 January 2026" / ISO -> ISO date string (no time). */
  function toIsoDate(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    const iso = s.match(/\d{4}-\d{2}-\d{2}/);
    if (iso) return iso[0];
    const parsed = Date.parse(s);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);
    return null;
  }

  // ----------------------------------------------------------- JSON-LD layer

  function jsonLdNodes(html) {
    const P = base();
    const blocks = P.extractJsonLdBlocks(html);
    const flat = [];
    const push = (node, depth) => {
      if (!node || depth > 5) return;
      if (Array.isArray(node)) {
        node.forEach((n) => push(n, depth + 1));
        return;
      }
      if (typeof node !== 'object') return;
      flat.push(node);
      if (Array.isArray(node['@graph'])) push(node['@graph'], depth + 1);
    };
    blocks.forEach((b) => push(b, 0));
    return flat;
  }

  function typeOf(node) {
    return [].concat(node['@type'] || node.type || []).map(String).join(' ');
  }

  /** Core listing facts from the Product node, plus the breadcrumb category. */
  function fromJsonLd(html) {
    const P = base();
    const nodes = jsonLdNodes(html);
    const product = nodes.find((n) => /Product/i.test(typeOf(n)));
    const crumbs = nodes.find((n) => /BreadcrumbList/i.test(typeOf(n)));

    const out = { detailSource: product ? 'jsonld' : null };

    if (product) {
      const offers = [].concat(product.offers || [])[0] || product.offers || null;
      const rating = product.aggregateRating || null;
      out.title = product.name ? String(product.name).replace(/\s+/g, ' ').trim() : null;
      out.description = product.description ? String(product.description).trim() : null;
      out.url = P.cleanListingUrl(product.url || (product.offers && product.offers.url) || '');
      out.listingId = P.listingIdFromUrl(out.url) || (product.sku ? String(product.sku) : null)
        || (product.productID ? String(product.productID) : null);
      out.mainImage = pickImage(product.image);
      out.imageCount = Array.isArray(product.image) ? product.image.length : (product.image ? 1 : null);
      if (offers && typeof offers === 'object') {
        out.price = P.parsePrice(offers.price ?? offers.lowPrice ?? offers.highPrice);
        out.currency = offers.priceCurrency || offers.currency || null;
        out.availability = offers.availability
          ? String(offers.availability).replace(/^.*\//, '')
          : null;
        if (offers.itemCondition) out.condition = String(offers.itemCondition).replace(/^.*\//, '');
      }
      if (rating) {
        out.rating = P.parsePrice(rating.ratingValue);
        out.reviewCount = toInt(rating.reviewCount ?? rating.ratingCount);
      }
      out.materials = normaliseList(product.material);
      const brand = product.brand || (offers && offers.seller) || product.seller;
      out.shopName = nameOf(brand);
      const published = product.datePublished || product.releaseDate;
      if (published) out.listingCreationDate = toIsoDate(published);
    }

    if (crumbs && Array.isArray(crumbs.itemListElement)) {
      const path = crumbs.itemListElement
        .map((e) => (e && (e.name || (e.item && e.item.name))) || '')
        .map((s) => String(s).trim())
        .filter(Boolean);
      if (path.length) out.categoryPath = path.join(' > ');
    }

    return out;
  }

  function pickImage(image) {
    if (!image) return null;
    if (typeof image === 'string') return image;
    if (Array.isArray(image)) return pickImage(image[0]);
    if (typeof image === 'object') return image.url || image.contentUrl || null;
    return null;
  }

  function nameOf(v) {
    if (!v) return null;
    if (typeof v === 'string') return v.trim() || null;
    if (Array.isArray(v)) return nameOf(v[0]);
    if (typeof v === 'object' && v.name) return String(v.name).trim();
    return null;
  }

  function normaliseList(v) {
    if (!v) return null;
    const items = (Array.isArray(v) ? v : String(v).split(/[,;/]/))
      .map((x) => (typeof x === 'string' ? x : nameOf(x)))
      .map((x) => String(x || '').trim())
      .filter(Boolean);
    return items.length ? items : null;
  }

  // --------------------------------------------------------------- DOM layer

  function fromDom(doc) {
    const P = base();
    if (!doc || typeof doc.querySelector !== 'function') return {};
    const blob = pageText(doc);
    const out = {};

    out.title = text(first(doc, SELECTORS.title)) || null;

    const descEl = first(doc, SELECTORS.description);
    if (descEl) out.description = text(descEl) || null;

    const priceEl = first(doc, SELECTORS.price);
    if (priceEl) out.price = P.parsePrice(text(priceEl));
    const symbol = text(first(doc, SELECTORS.currencySymbol));
    if (symbol) out.currency = P.currencyFromSymbol(symbol);
    const wasEl = first(doc, SELECTORS.originalPrice);
    if (wasEl) {
      const was = P.parsePrice(text(wasEl));
      if (was !== null) out.originalPrice = was;
    }

    // --- sales velocity signals -------------------------------------------
    const favEl = first(doc, SELECTORS.favorites);
    out.favoritesCount = toInt(
      (favEl && (favEl.getAttribute('data-favorites-count') || text(favEl))) || null,
    );
    if (out.favoritesCount === null) {
      const m = blob.match(/([\d.,]+)\s*(?:favorites?|favourites?|people have favorited)/i);
      if (m) out.favoritesCount = toInt(m[1]);
    }

    const cart = blob.match(/([\d.,]+)\s*(?:people|others?)\s+(?:have|has)\s+this\s+in\s+the(?:ir)?\s+cart/i)
      || blob.match(/in\s+(\d+)\s+cart/i);
    if (cart) out.cartCount = toInt(cart[1]);

    // Etsy no longer publishes view counts; only fill it if a page really does.
    const views = blob.match(/([\d.,]+)\s*views?\b/i);
    if (views) out.viewsCount = toInt(views[1]);

    out.quantityAvailable = readQuantity(doc, blob);

    // --- monetisation structure -------------------------------------------
    const variations = readVariations(doc);
    if (variations.length) {
      out.variations = variations;
      out.variationCount = variations.reduce((n, v) => n * Math.max(1, v.options.length), 1);
    }
    const personalization = first(doc, SELECTORS.personalization);
    out.isPersonalizable = Boolean(personalization) || /add your personalization|personalization\b/i.test(blob);
    if (out.isPersonalizable) {
      out.personalizationRequired = personalization
        ? personalization.hasAttribute('required') || /personalization\s*\(required\)/i.test(blob)
        : /personalization\s*\(required\)/i.test(blob);
    }

    const bulletMaterials = readLabelled(doc, blob, /materials?/i);
    if (bulletMaterials) out.materials = normaliseList(bulletMaterials);

    // --- SEO surface -------------------------------------------------------
    const tags = readTags(doc);
    if (tags.length) {
      out.tags = tags;
      out.tagCount = tags.length;
    }
    const crumbs = all(doc, SELECTORS.breadcrumb).map((a) => text(a)).filter(Boolean);
    if (crumbs.length > 1) out.categoryPath = crumbs.join(' > ');

    // --- seller authority --------------------------------------------------
    Object.assign(out, readShop(doc, blob));

    // --- dates -------------------------------------------------------------
    const listed = blob.match(/Listed on\s+([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i);
    if (listed) out.listingCreationDate = toIsoDate(listed[1]);

    const images = all(doc, SELECTORS.images).filter((img) => {
      const src = img.getAttribute('src') || '';
      return /etsystatic/.test(src);
    });
    if (images.length) {
      out.imageCount = images.length;
      if (!out.mainImage) out.mainImage = images[0].getAttribute('src');
    }

    const shopReviews = blob.match(/([\d.,]+)\s*(?:shop\s+)?reviews?\b/i);
    if (shopReviews) out.shopReviewCount = toInt(shopReviews[1]);

    out.detailSource = 'dom';
    return out;
  }

  function readQuantity(doc, blob) {
    const select = first(doc, SELECTORS.quantitySelect);
    if (select) {
      const options = Array.from(select.options || select.querySelectorAll('option') || []);
      const values = options.map((o) => toInt(o.getAttribute('value') || text(o))).filter((n) => n !== null);
      if (values.length) return Math.max(...values);
    }
    const only = blob.match(/Only\s+(\d+)\s+(?:left|available|remaining)/i)
      || blob.match(/(\d+)\s+in stock/i);
    return only ? toInt(only[1]) : null;
  }

  function readVariations(doc) {
    const out = [];
    for (const select of all(doc, SELECTORS.variationSelect)) {
      const label = select.getAttribute('aria-label')
        || labelTextFor(doc, select)
        || select.getAttribute('name')
        || select.getAttribute('id')
        || 'option';
      const options = Array.from(select.options || select.querySelectorAll('option') || [])
        .map((o) => text(o))
        .filter((t) => t && !/^select an option|^choose an option/i.test(t));
      if (options.length) {
        out.push({ name: String(label).replace(/\s+/g, ' ').replace(/:$/, '').trim(), options });
      }
    }
    return out;
  }

  function labelTextFor(doc, select) {
    const id = select.getAttribute('id');
    if (!id) return null;
    try {
      const label = doc.querySelector(`label[for="${id}"]`);
      return label ? text(label) : null;
    } catch (_) {
      return null;
    }
  }

  /** Read "Materials: cotton, linen" style facts from the details block. */
  function readLabelled(doc, blob, labelPattern) {
    for (const li of all(doc, SELECTORS.detailBullets)) {
      const t = text(li);
      const m = t.match(/^([A-Za-z ]{3,20}):\s*(.+)$/);
      if (m && labelPattern.test(m[1])) return m[2];
    }
    const source = String(blob || '');
    const m = source.match(new RegExp(`${labelPattern.source}\\s*:\\s*([^.|]{2,160})`, 'i'));
    return m ? m[1].trim() : null;
  }

  /**
   * Tags are not published verbatim; Etsy renders `/market/<term>` links for the
   * listing which mirror most of the tag set. Capped at 13 (Etsy's tag limit).
   */
  function readTags(doc) {
    const seen = new Set();
    const tags = [];
    for (const a of all(doc, SELECTORS.marketLinks)) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/market\/([^/?#]+)/);
      const label = text(a) || (m ? decodeURIComponent(m[1]).replace(/[_-]+/g, ' ') : '');
      const key = label.toLowerCase().trim();
      if (!key || key.length > 60 || seen.has(key)) continue;
      seen.add(key);
      tags.push(label.trim());
      if (tags.length >= 13) break;
    }
    return tags;
  }

  function readShop(doc, blob) {
    const out = {};
    const named = first(doc, SELECTORS.shopName);
    if (named) {
      out.shopName = named.getAttribute('data-shop-name') || text(named) || null;
    }
    const link = first(doc, SELECTORS.shopLink);
    if (link) {
      const href = link.getAttribute('href') || '';
      const m = href.match(/\/shop\/([^/?#]+)/);
      if (m) {
        out.shopUrl = `https://www.etsy.com/shop/${m[1]}`;
        if (!out.shopName) out.shopName = decodeURIComponent(m[1]);
      }
    }
    const sales = blob.match(/([\d.,]+)\s*(?:sales|sold)\b/i);
    if (sales) out.shopTotalSales = toInt(sales[1]);
    out.starSeller = /star seller/i.test(blob);
    const location = readLocation(doc, blob);
    if (location) out.shopLocation = location;
    return out;
  }

  const LOCATION_LABEL = /^(?:Ships? from|Located in|Shop location):?\s+(.{2,60})$/i;

  /**
   * Locations contain commas ("Portland, Oregon") and sit next to unrelated copy,
   * so scan small elements whose whole text is the location line. Falling back to
   * a regex over the flattened page text would happily swallow the next
   * paragraph, so the fallback keeps only the first few words.
   */
  function readLocation(doc, blob) {
    const candidates = all(doc, ['p, span, li, div, address']);
    for (const node of candidates) {
      const t = text(node);
      if (!t || t.length > 80) continue;
      const m = t.match(LOCATION_LABEL);
      if (m) return m[1].replace(/\s+/g, ' ').trim();
    }
    const loose = String(blob).match(/(?:Ships? from|Located in|Shop location):?\s+(.{2,60})/i);
    if (!loose) return null;
    return loose[1].split(/\s+/).slice(0, 4).join(' ').replace(/[,;]$/, '').trim() || null;
  }

  // ------------------------------------------------------------------ reviews

  const DATE_PATTERN = /([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/;

  function parseReviews(doc, options) {
    const P = base();
    const opts = options || {};
    const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 20;
    const region = first(doc, SELECTORS.reviewRegion) || doc;
    const cards = all(region, SELECTORS.reviewCard);
    const out = [];

    for (const card of cards) {
      if (out.length >= limit) break;
      const blob = text(card);
      if (!blob) continue;

      let rating = null;
      const ratingInput = first(card, ['input[name="rating"]']);
      if (ratingInput) rating = P.parsePrice(ratingInput.getAttribute('value'));
      if (rating === null) {
        const aria = findAriaRating(card);
        if (aria !== null) rating = aria;
      }
      if (rating === null) {
        const m = blob.match(/([0-5](?:[.,]\d)?)\s*out of 5/i);
        if (m) rating = P.parsePrice(m[1]);
      }

      const dateMatch = blob.match(DATE_PATTERN);
      const reviewerEl = first(card, SELECTORS.reviewer);

      const photos = all(card, SELECTORS.reviewPhoto)
        .map((img) => img.getAttribute('src') || img.getAttribute('data-src') || '')
        .filter((src) => /etsystatic/.test(src));

      const comment = readComment(card, blob);
      // A card with neither a rating nor any text is chrome, not a review.
      if (rating === null && !comment) continue;

      out.push({
        reviewer: reviewerEl ? text(reviewerEl) || null : null,
        rating,
        date: dateMatch ? toIsoDate(dateMatch[1]) : null,
        comment: comment || null,
        photoCount: photos.length,
        photos,
        variation: readVariationLine(blob),
      });
    }
    return out;
  }

  function findAriaRating(card) {
    const P = base();
    const nodes = all(card, ['[aria-label*="out of 5"]', '[aria-label*="stars"]']);
    for (const node of nodes) {
      const label = node.getAttribute('aria-label') || '';
      const m = label.match(/([0-5](?:[.,]\d)?)\s*out of 5/i);
      if (m) return P.parsePrice(m[1]);
    }
    return null;
  }

  function readComment(card, blob) {
    const el = first(card, SELECTORS.reviewText);
    let comment = el ? text(el) : '';
    if (!comment || comment.length < 3) {
      // Strip the metadata we already captured and keep what remains.
      comment = blob
        .replace(/[0-5](?:[.,]\d)?\s*out of 5 stars?/gi, ' ')
        .replace(DATE_PATTERN, ' ')
        .replace(/purchased item:?/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    if (!comment) return null;
    return comment.length > 5000 ? `${comment.slice(0, 5000)}…` : comment;
  }

  function readVariationLine(blob) {
    const m = String(blob).match(/(?:Item type|Size|Color|Format|Finish|Style):\s*([^|]{1,60})/i);
    return m ? m[0].replace(/\s+/g, ' ').trim() : null;
  }

  // ---------------------------------------------------------------- top level

  /**
   * Parse one listing page.
   * @param {{html?:string, doc?:Document, context?:object}} input
   * @returns {{record:?object, reviews:Array<object>, blocked:boolean,
   *            blockReason:?string, counts:{jsonld:number,dom:number,reviews:number}}}
   */
  function parseListingPage(input) {
    const P = base();
    const opts = input || {};
    const html = opts.html || '';
    const doc = opts.doc || null;
    const context = opts.context || {};

    const block = P.detectBlock(html, doc);
    if (block.blocked) {
      return {
        record: null,
        reviews: [],
        blocked: true,
        blockReason: block.reason,
        counts: { jsonld: 0, dom: 0, reviews: 0 },
      };
    }

    const ld = fromJsonLd(html);
    const dom = doc ? fromDom(doc) : {};
    const reviews = doc && context.scrapeReviews !== false
      ? parseReviews(doc, { limit: context.maxReviews })
      : [];

    const record = finalizeDetail(ld, dom, context, reviews);
    return {
      record,
      reviews: reviews.map((r) => finalizeReview(r, record, context)),
      blocked: false,
      blockReason: null,
      counts: {
        jsonld: Object.keys(ld).filter((k) => ld[k] !== null && ld[k] !== undefined).length,
        dom: Object.keys(dom).filter((k) => dom[k] !== null && dom[k] !== undefined).length,
        reviews: reviews.length,
      },
    };
  }

  /** DOM wins on live numbers; JSON-LD fills gaps. Mirrors parse.js's rule. */
  function finalizeDetail(ld, dom, context, reviews) {
    const P = base();
    const ctx = context || {};
    const pick = (...values) => {
      for (const v of values) {
        if (v !== null && v !== undefined && v !== '') return v;
      }
      return null;
    };
    const listingId = pick(ctx.listingId, dom.listingId, ld.listingId,
      P.listingIdFromUrl(ctx.sourceUrl || ''));
    const url = pick(ld.url, ctx.sourceUrl, listingId ? `https://www.etsy.com/listing/${listingId}` : null);
    const price = pick(dom.price, ld.price);
    const originalPrice = pick(dom.originalPrice, ld.originalPrice);

    return {
      listingId: listingId ? String(listingId) : null,
      url: url ? P.cleanListingUrl(url) : null,
      title: pick(dom.title, ld.title),
      description: pick(ld.description, dom.description),
      price: price === null ? null : price,
      currency: pick(dom.currency, ld.currency),
      originalPrice: originalPrice === null ? null : originalPrice,
      onSale: originalPrice !== null && price !== null ? originalPrice > price : false,
      availability: pick(ld.availability, dom.availability),
      mainImage: pick(ld.mainImage, dom.mainImage),
      imageCount: pick(dom.imageCount, ld.imageCount),
      categoryPath: pick(ld.categoryPath, dom.categoryPath),
      listingCreationDate: pick(dom.listingCreationDate, ld.listingCreationDate),

      favoritesCount: pick(dom.favoritesCount),
      cartCount: pick(dom.cartCount),
      viewsCount: pick(dom.viewsCount),
      quantityAvailable: pick(dom.quantityAvailable),

      variationCount: pick(dom.variationCount),
      variations: pick(dom.variations),
      isPersonalizable: Boolean(dom.isPersonalizable),
      personalizationRequired: Boolean(dom.personalizationRequired),
      materials: pick(ld.materials, dom.materials),

      tags: pick(dom.tags),
      tagCount: pick(dom.tagCount),

      shopName: pick(dom.shopName, ld.shopName),
      shopUrl: pick(dom.shopUrl),
      shopTotalSales: pick(dom.shopTotalSales),
      starSeller: Boolean(dom.starSeller),
      shopLocation: pick(dom.shopLocation),

      rating: pick(ld.rating, dom.rating),
      reviewCount: pick(ld.reviewCount, dom.reviewCount),
      shopReviewCount: pick(dom.shopReviewCount),
      reviewsCaptured: reviews ? reviews.length : 0,

      scrapedAt: ctx.scrapedAt || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      detailSource: ld.detailSource && dom.detailSource ? 'jsonld+dom' : (ld.detailSource || dom.detailSource || null),
    };
  }

  function finalizeReview(review, record, context) {
    const ctx = context || {};
    return {
      listingId: record ? record.listingId : (ctx.listingId || null),
      listingTitle: record ? record.title : null,
      reviewer: review.reviewer,
      rating: review.rating,
      date: review.date,
      comment: review.comment,
      photoCount: review.photoCount,
      photos: review.photos,
      variation: review.variation,
      scrapedAt: ctx.scrapedAt || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
  }

  return {
    SELECTORS,
    parseListingPage,
    parseReviews,
    fromJsonLd,
    fromDom,
    finalizeDetail,
    finalizeReview,
    toIsoDate,
  };
});
