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
      '[data-id="description-text"]',
      '[data-appears-component-name="listing_page_description"]',
      '[data-component="listing-page-description"]',
      '#wt-content-toggle-product-details-read-more',
      '#listing-page-description',
      '.listing-page-description',
      '[data-buy-box-region="description"]',
    ],
    /**
     * Last-resort description sources. These meta tags are part of Etsy's SEO /
     * social markup, so they survive front-end redesigns that rename classes —
     * which is exactly when the selectors above stop matching. They hold a
     * truncated description, so they are only used when nothing better is found.
     */
    descriptionMeta: [
      'meta[property="og:description"]',
      'meta[name="twitter:description"]',
      'meta[name="description"]',
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
    shippingRegion: [
      '[data-shipping-and-returns]',
      '[data-buy-box-region="shipping"]',
      '[data-selector="shipping-cost"]',
      '.shipping-section',
    ],
    textLine: ['p, span, li, div, address'],
    shopName: ['[data-shop-name]', 'span.wt-text-title-small a[href*="/shop/"]'],
    breadcrumb: ['nav[aria-label="Breadcrumbs"] a', '.breadcrumb a', 'ol[data-breadcrumbs] a'],
    marketLinks: ['a[href*="/market/"]'],
    searchChips: ['a[href*="/search?q="]'],
    // Etsy ships the tag section as an empty placeholder and fills it in after
    // load. Finding this element with no links inside it is the difference
    // between "Etsy renamed the markup" and "the module never loaded" — two
    // problems with completely different fixes.
    tagsModule: [
      '[data-appears-component-name="listing_page_tags"]',
      '[data-appears-component-name*="tag" i]',
      '[data-click-queries*="tag" i]',
      '[data-tags-module]',
    ],
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

    // Etsy also states the taxonomy on the Product node as a single string with
    // "<" separators, broadest first: "Paper & Party Supplies < Paper < ...".
    // Kept separate from `categoryPath` so the structured BreadcrumbList and the
    // DOM breadcrumb both still take precedence over this flattened form.
    if (product && product.category) {
      const parts = String(product.category)
        .split(/\s*<\s*/)
        .map((s) => s.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      if (parts.length) out.categoryPathFallback = parts.join(' > ');
    }

    return out;
  }

  /**
   * Reviews straight out of the listing's JSON-LD `review[]` array.
   *
   * This matters beyond redundancy: in fetch mode there is no live DOM at all, so
   * before this the reviews list was always empty for fetched pages. The JSON-LD
   * block is served in the initial HTML, which makes reviews available without a
   * tab. DOM reviews are still richer (photos, variation lines), so these only
   * fill in — see mergeReviews().
   */
  function reviewsFromJsonLd(html) {
    const P = base();
    const out = [];
    // Only the listing's own Product node. Reading `review[]` off every node
    // would stamp this listing's id onto an Organization's shop reviews or a
    // related product's reviews if Etsy ever emits either.
    const product = jsonLdNodes(html).find((n) => /Product/i.test(typeOf(n)));
    if (!product) return out;

    for (const raw of [].concat(product.review || product.reviews || [])) {
      if (!raw || typeof raw !== 'object') continue;
      if (!/Review/i.test(typeOf(raw)) && !raw.reviewBody && !raw.reviewRating) continue;
      const ratingNode = raw.reviewRating || raw.aggregateRating || null;
      // Deliberately not `raw.name`: that is schema.org's headline, not the
      // review body, and exporting a title as a comment misrepresents it.
      const comment = raw.reviewBody || raw.description || '';
      const rating = ratingNode ? P.parsePrice(ratingNode.ratingValue ?? ratingNode.value) : null;
      if (!comment && rating === null) continue;
      out.push({
        reviewer: nameOf(raw.author) || nameOf(raw.creator) || null,
        rating,
        date: toIsoDate(raw.datePublished || raw.dateCreated || ''),
        comment: comment ? String(comment).replace(/\s+/g, ' ').trim() : null,
        // Null, not 0: JSON-LD says nothing about attachments, and "0 photos" is
        // a claim about the review that this source cannot support. The DOM pass
        // fills both in when it can see the card.
        photoCount: null,
        photos: null,
        variation: null,
        _source: 'jsonld',
      });
    }
    return out;
  }

  /** Trailing "read more" affordances and ellipses are truncation, not content. */
  const TEASER_TAIL = /(?:\s|…|\.{3})*\b(?:read|show|see)\s+(?:more|less)\b\s*$/i;

  function normalizeComment(review) {
    return String((review && review.comment) || '')
      .replace(TEASER_TAIL, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  /** One comment is the opening of the other, i.e. teaser vs. full body. */
  function commentsOverlap(a, b) {
    const x = normalizeComment(a);
    const y = normalizeComment(b);
    if (x.length < 24 || y.length < 24) return false;
    return x.startsWith(y) || y.startsWith(x);
  }

  function sameField(a, b, field) {
    if (!a[field] || !b[field]) return null; // unknown, not a mismatch
    return String(a[field]).toLowerCase().trim() === String(b[field]).toLowerCase().trim();
  }

  /**
   * Do two review objects describe the same review?
   *
   * Index-based matching is useless here: the two sources order and paginate
   * differently. Two signals are used, both vetoed by contradictions:
   *
   *   1. Same reviewer on the same date. Within a single listing that is
   *      conclusive — two buyers sharing a display name and a day is negligible
   *      next to the certainty of the match.
   *   2. One comment is the opening of the other, because the DOM renders a
   *      collapsed teaser while JSON-LD carries the full body. A minimum length
   *      is required so short pleasantries ("Love it, thank you!") cannot merge
   *      distinct reviews, and a *known* difference in reviewer or date vetoes
   *      the match outright — two buyers posting identical text on different
   *      days are two reviews, however similar they read.
   */
  function isSameReview(a, b) {
    const sameReviewer = sameField(a, b, 'reviewer');
    const sameDate = sameField(a, b, 'date');
    if (sameReviewer === false || sameDate === false) return false;
    if (sameReviewer && sameDate) return true;
    return commentsOverlap(a, b);
  }

  /**
   * DOM reviews first (only they carry photos and variation lines), then any
   * JSON-LD review the DOM pass did not already produce. When both describe the
   * same review the DOM copy is kept and its gaps are filled from JSON-LD.
   */
  function mergeReviews(domReviews, ldReviews) {
    const out = (domReviews || []).slice();
    for (const review of ldReviews || []) {
      const match = out.find((existing) => isSameReview(existing, review));
      if (!match) {
        out.push(review);
        continue;
      }
      for (const field of ['reviewer', 'rating', 'date', 'variation', 'photos', 'photoCount']) {
        if (match[field] === null || match[field] === undefined || match[field] === '') {
          match[field] = review[field];
        }
      }
      // Etsy collapses long reviews in the DOM, so the longer text is the fuller
      // one — but only when it is demonstrably the same text continued. Replacing
      // the comment on a reviewer+date match alone would let one review's body be
      // grafted onto another's photos.
      if (commentsOverlap(match, review)
        && String(review.comment || '').length > String(match.comment || '').length) {
        match.comment = review.comment;
      }
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

    out.description = readDescription(doc);

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

    // --- product type ------------------------------------------------------
    Object.assign(out, readProductType(doc, blob));

    // --- shipping incentive ------------------------------------------------
    out.freeShipping = readFreeShipping(doc, blob);

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

  /** UI chrome that ends up inside the description container. */
  const DESCRIPTION_NOISE = /^(?:read (?:more|less)|show (?:more|less)|loading…?|more)$/i;

  /**
   * Collect every plausible description and keep the longest.
   *
   * Two reasons this is not simply "first selector that matches":
   *   * Etsy renames the description container periodically, so a single miss
   *     used to yield null with no fallback at all.
   *   * The container is often rendered collapsed, with a short teaser in one
   *     element and the full text in a sibling — taking the first match gets the
   *     teaser. Longest wins instead.
   */
  function readDescription(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return null;
    const candidates = [];

    for (const selector of SELECTORS.description) {
      let nodes = [];
      try {
        nodes = Array.from(doc.querySelectorAll(selector));
      } catch (_) {
        continue;
      }
      for (const node of nodes) candidates.push(text(node));
    }

    for (const selector of SELECTORS.descriptionMeta) {
      const node = first(doc, [selector]);
      const content = node && node.getAttribute ? node.getAttribute('content') : null;
      if (content) candidates.push(String(content).replace(/\s+/g, ' ').trim());
    }

    return pickLongestText(candidates);
  }

  function pickLongestText(candidates) {
    let best = null;
    for (const raw of candidates) {
      const value = String(raw || '').replace(/\s+/g, ' ').trim();
      if (!value || DESCRIPTION_NOISE.test(value)) continue;
      if (!best || value.length > best.length) best = value;
    }
    if (!best) return null;
    return best.length > 20000 ? `${best.slice(0, 20000)}…` : best;
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
   * Tag harvesting.
   *
   * Etsy does not publish a listing's 13 tags verbatim anywhere in the page, so
   * this collects the two link shapes that do mirror them — the `/market/<term>`
   * links and the tag-style `/search?q=<term>` links rendered under "Explore
   * related searches" — dedupes case-insensitively and caps at 13 (Etsy's own
   * limit). Treat the result as a close proxy for the tag set, not the literal
   * list; `tagCount` tells you how many we actually recovered.
   */
  /**
   * Why did tag harvesting find nothing?
   *
   * "tags: null" has three completely different causes and one useless message,
   * so the run reports which one it hit instead of leaving the user to guess:
   *
   *   * `modulePresent && moduleEmpty` — Etsy's tag section is on the page but
   *     still an unfilled placeholder. Nothing is wrong with our selectors; the
   *     page simply never loaded that module, which is what happens in fetch
   *     mode and can happen in a tab that was never scrolled to it.
   *   * `!modulePresent` with no links anywhere — Etsy changed the markup, or
   *     this listing genuinely has no tag section.
   *   * links present but no tags kept — the labels were filtered out.
   */
  function describeTagSources(doc) {
    if (!doc) return null;
    const module = first(doc, SELECTORS.tagsModule);
    const marketLinks = all(doc, SELECTORS.marketLinks).length;
    const chips = all(doc, SELECTORS.searchChips).length;
    return {
      marketLinks,
      searchChips: chips,
      modulePresent: Boolean(module),
      // A placeholder Etsy has not filled in yet: present, but with no links of
      // its own and effectively no content.
      moduleEmpty: Boolean(module) && !module.querySelector('a[href]'),
    };
  }

  function readTags(doc) {
    const seen = new Set();
    const tags = [];
    const push = (label) => {
      const clean = String(label || '').replace(/\s+/g, ' ').trim();
      const key = clean.toLowerCase();
      if (!clean || clean.length > 60 || seen.has(key)) return;
      seen.add(key);
      tags.push(clean);
    };

    for (const a of all(doc, SELECTORS.marketLinks)) {
      if (tags.length >= 13) break;
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/market\/([^/?#]+)/);
      push(text(a) || (m ? decodeURIComponent(m[1]).replace(/[_+-]+/g, ' ') : ''));
    }

    // Tag chips also appear as search links; skip navigation/category links.
    for (const a of all(doc, SELECTORS.searchChips)) {
      if (tags.length >= 13) break;
      const label = text(a);
      if (!label || /^see more|^more like this/i.test(label)) continue;
      push(label);
    }

    return tags;
  }

  /**
   * Digital vs physical.
   *
   * Etsy states this positively for digital listings ("Instant Download",
   * "Digital download", "Digital file type(s): PDF") and describes delivery for
   * physical ones ("Ships from", "Arrives by", "Cost to ship"). Price is NOT used
   * as a signal — cheap physical items exist and expensive digital ones do too.
   * Unknown stays null rather than defaulting to physical.
   */
  const DIGITAL_MARKERS = /instant download|digital download|digital file|digital files|digital item|downloadable file/i;
  const PHYSICAL_MARKERS = /ships? from|arrives by|cost to ship|shipping upgrades available|ready to ship/i;

  function readProductType(doc, blob) {
    const out = {};
    const hay = String(blob || '');
    const digital = DIGITAL_MARKERS.test(hay);
    const physical = PHYSICAL_MARKERS.test(hay);
    if (digital) {
      out.isDigital = true;
      out.productType = 'Digital';
    } else if (physical) {
      out.isDigital = false;
      out.productType = 'Physical';
    }
    return out;
  }

  const FREE_SHIPPING = /\bfree\s+(?:standard\s+|domestic\s+)?(?:shipping|delivery|postage)\b/i;
  /** "Free shipping on orders over $35" is a shop promotion, not this listing. */
  const CONDITIONAL_SHIPPING = /orders? over|when you spend|spend \$|on orders of/i;
  const ZERO_SHIPPING_COST = /(?:cost to ship|shipping)\s*:?\s*(?:free|\$?0(?:[.,]00)?\b)/i;

  /**
   * Free shipping is stated in copy rather than structured data, so scan short
   * text lines and ignore the conditional shop-wide promotions that would
   * otherwise turn every listing into a false positive.
   */
  function readFreeShipping(doc, blob) {
    const region = first(doc, SELECTORS.shippingRegion);
    const lines = all(region || doc, SELECTORS.textLine);
    let sawConditional = false;

    for (const node of lines) {
      const t = text(node);
      if (!t || t.length > 160) continue;
      if (!FREE_SHIPPING.test(t) && !ZERO_SHIPPING_COST.test(t)) continue;
      if (CONDITIONAL_SHIPPING.test(t)) {
        sawConditional = true;
        continue;
      }
      return true;
    }

    // No usable line: fall back to the flattened text, but only when the page
    // never mentioned a spend threshold (which would make this ambiguous).
    if (!sawConditional && ZERO_SHIPPING_COST.test(blob)) return true;
    if (!sawConditional && FREE_SHIPPING.test(blob) && !CONDITIONAL_SHIPPING.test(blob)) return true;
    return false;
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
    out.isStarSeller = /star seller/i.test(blob);
    out.shopMemberSince = readMemberSince(doc, blob);
    out.shopAgeMonths = readShopAgeMonths(doc, blob);
    const location = readLocation(doc, blob);
    if (location) out.shopLocation = location;
    return out;
  }

  /**
   * Shop tenure as Etsy actually renders it on many listings: "11 months on
   * Etsy", "3 years on Etsy". A real listing page carried exactly this and no
   * "since <year>" string anywhere, which is why `shopMemberSince` came back
   * null for it.
   *
   * Reported in months, and deliberately NOT converted into a start year:
   * "3 years on Etsy" could mean anywhere from 36 to 47 months, so a derived
   * year would be a guess dressed up as a fact. `shopMemberSince` stays null in
   * that case and this field carries what the page really said.
   */
  const TENURE_COMBINED = /(\d{1,3})\s*years?(?:[,\s]+(?:and\s+)?(\d{1,2})\s*months?)?\s+(?:on|selling on)\s+Etsy\b/i;
  const TENURE_MONTHS = /(\d{1,3})\s*months?\s+(?:on|selling on)\s+Etsy\b/i;

  function tenureFrom(source) {
    const s = String(source || '');
    // Years first, so "3 years, 2 months on Etsy" is not read as 2 months.
    const combined = s.match(TENURE_COMBINED);
    if (combined) {
      const years = toInt(combined[1]) || 0;
      const months = combined[2] ? toInt(combined[2]) || 0 : 0;
      const total = years * 12 + months;
      return total > 0 && total <= 300 ? total : null;
    }
    const monthsOnly = s.match(TENURE_MONTHS);
    if (monthsOnly) {
      const total = toInt(monthsOnly[1]);
      return total !== null && total > 0 && total <= 300 ? total : null;
    }
    return null;
  }

  function readShopAgeMonths(doc, blob) {
    // Scoped to short lines first, the same way readLocation is: a buyer writing
    // "I've been on Etsy 6 years" in a review must not become the shop's age.
    for (const node of all(doc, SELECTORS.textLine)) {
      const t = text(node);
      if (!t || t.length > 80) continue;
      const months = tenureFrom(t);
      if (months !== null) return months;
    }
    return tenureFrom(blob);
  }

  /**
   * Shop age. Etsy renders this as "On Etsy since 2019" / "Etsy seller since
   * 2019", i.e. a year and nothing finer, so we return the year as an integer
   * rather than inventing a month and day.
   */
  function readMemberSince(doc, blob) {
    const patterns = [
      /(?:on Etsy since|Etsy seller since|seller since|member since|On Etsy for)\s+((?:19|20)\d{2})/i,
      /since\s+((?:19|20)\d{2})/i,
    ];
    for (const pattern of patterns) {
      const m = String(blob).match(pattern);
      if (m) {
        const year = toInt(m[1]);
        // Sanity: Etsy launched in 2005; anything earlier is a mis-parse.
        if (year && year >= 2005 && year <= new Date().getFullYear()) return year;
      }
    }
    return null;
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

    const wantReviews = context.scrapeReviews !== false;
    const limit = Number(context.maxReviews) > 0 ? Number(context.maxReviews) : 20;
    const domReviews = wantReviews && doc ? parseReviews(doc, { limit }) : [];
    // Works with `html` alone, so fetch-mode runs get reviews too.
    const ldReviews = wantReviews ? reviewsFromJsonLd(html) : [];
    const reviews = mergeReviews(domReviews, ldReviews).slice(0, limit);

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
        reviewsFromJsonLd: ldReviews.length,
        tagSources: describeTagSources(doc),
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
      // Etsy's JSON-LD description is frequently a truncated summary, so take
      // whichever source actually carries more text.
      description: pickLongestText([ld.description, dom.description]),
      price: price === null ? null : price,
      currency: pick(dom.currency, ld.currency),
      originalPrice: originalPrice === null ? null : originalPrice,
      onSale: originalPrice !== null && price !== null ? originalPrice > price : false,
      availability: pick(ld.availability, dom.availability),
      mainImage: pick(ld.mainImage, dom.mainImage),
      imageCount: pick(dom.imageCount, ld.imageCount),
      categoryPath: pick(ld.categoryPath, dom.categoryPath, ld.categoryPathFallback),
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
      // Provenance for the tag list. Scraping can only ever produce the
      // link-derived proxy; the Etsy API layer upgrades this to 'api' when it
      // supplies the real tag array. Never left implicit.
      tagSource: dom.tags && dom.tags.length ? 'page-links' : null,

      isDigital: dom.isDigital === undefined ? null : dom.isDigital,
      productType: pick(dom.productType),

      freeShipping: Boolean(dom.freeShipping),

      shopName: pick(dom.shopName, ld.shopName),
      shopUrl: pick(dom.shopUrl),
      shopTotalSales: pick(dom.shopTotalSales),
      isStarSeller: Boolean(dom.isStarSeller),
      shopLocation: pick(dom.shopLocation),
      shopMemberSince: pick(dom.shopMemberSince),
      // Etsy shows either a start year or a tenure ("11 months on Etsy"), rarely
      // both, so these two are independent rather than derived from each other.
      shopAgeMonths: pick(dom.shopAgeMonths),

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
    readDescription,
    pickLongestText,
    readFreeShipping,
    readMemberSince,
    readShopAgeMonths,
    readTags,
    describeTagSources,
    fromJsonLd,
    reviewsFromJsonLd,
    mergeReviews,
    isSameReview,
    fromDom,
    finalizeDetail,
    finalizeReview,
    toIsoDate,
  };
});
