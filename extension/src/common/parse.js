/**
 * Etsy search-result parsing.
 *
 * Written as a UMD-ish classic script (no `import`/`export`) on purpose: the
 * exact same code has to run in three very different places —
 *   1. the offscreen document (parses HTML fetched by the service worker),
 *   2. an injected content script inside a real Etsy tab,
 *   3. Node (tools/verify.mjs regression harness).
 *
 * Two extraction strategies are combined:
 *   A. JSON-LD  (`<script type="application/ld+json">` → ItemList) — stable,
 *      survives class-name churn, but only carries title/url/price/image.
 *   B. DOM listing cards — everything else (shop, rating, reviews, badges).
 * Records are merged per listingId so each row is as complete as possible.
 */
(function (root, factory) {
  const api = factory();
  root.EtsyParse = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * CSS selectors kept in one place: Etsy reshuffles its markup regularly, so
   * this is the only block that normally needs updating. Each entry is a list
   * of candidates tried in order.
   */
  const SELECTORS = {
    card: [
      'div[data-listing-id]',
      'li[data-listing-id]',
      '.v2-listing-card',
      '.js-merch-stash-check-listing',
      'li.wt-list-unstyled > div.js-merch-stash-check-listing',
      'ol.responsive-listing-grid > li',
      'div[data-search-results-container] li',
    ],
    link: ['a.listing-link', 'a[href*="/listing/"]'],
    title: [
      'h3[data-listing-card-listing-title]',
      'h3.v2-listing-card__title',
      '.v2-listing-card__title',
      'h3.wt-text-caption',
      'h3',
      '[data-listing-card-listing-title]',
    ],
    price: [
      '.currency-value',
      '[data-buy-box-region="price"] .currency-value',
      '.n-listing-card__price .currency-value',
      'span.currency-value',
    ],
    currencySymbol: ['.currency-symbol', 'span.currency-symbol'],
    shop: [
      'p.wt-text-caption span.wt-text-caption',
      '.v2-listing-card__shop p',
      '[data-shop-name]',
      'p.wt-text-body-01.wt-text-truncate',
      'span.wt-text-caption.wt-text-truncate',
    ],
    image: ['img.wt-position-absolute', 'img.wt-width-full', 'img[src*="etsystatic"]', 'img'],
    ratingInput: ['input[name="rating"]'],
    // Deliberately no generic "number that looks like a rating" selector: on the
    // live grid `.wt-text-title-01` is the price. See readRating().
    ratingLabel: ['[aria-label*="out of 5"]', '[title*="out of 5"]'],
    reviewCount: ['.wt-text-body-smaller', 'p.wt-text-body-smaller', 'span.wt-text-body-smaller'],
  };

  const CURRENCY_BY_SYMBOL = {
    $: 'USD', US$: 'USD', 'CA$': 'CAD', 'A$': 'AUD', 'NZ$': 'NZD',
    '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', '₺': 'TRY',
    '₽': 'RUB', '₪': 'ILS', 'R$': 'BRL', 'Mex$': 'MXN', 'zł': 'PLN',
    'CHF': 'CHF', 'kr': 'SEK', 'Kč': 'CZK', '₩': 'KRW', '฿': 'THB',
  };

  const BLOCK_MARKERS = [
    'captcha-delivery',
    'geo.captcha-delivery.com',
    'px-captcha',
    'perimeterx',
    'unusual traffic',
    "verify you're a human",
    'verify you are a human',
    'are you a human',
    'access to this page has been denied',
    'temporarily unavailable due to a high volume',
    'request has been blocked',
  ];

  // ---------------------------------------------------------------- utilities

  function firstMatch(root, candidates) {
    if (!root || typeof root.querySelector !== 'function') return null;
    for (const sel of candidates) {
      let el = null;
      try {
        el = root.querySelector(sel);
      } catch (_) {
        el = null;
      }
      if (el) return el;
    }
    return null;
  }

  function allMatches(root, candidates) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    for (const sel of candidates) {
      let found = [];
      try {
        found = Array.from(root.querySelectorAll(sel));
      } catch (_) {
        found = [];
      }
      if (found.length) return found;
    }
    return [];
  }

  function text(el) {
    if (!el) return '';
    const raw = el.textContent == null ? '' : String(el.textContent);
    return raw.replace(/\s+/g, ' ').trim();
  }

  /** "$1,234.56" / "1.234,56 €" / "USD 28.00" → 1234.56 / 28 */
  function parsePrice(input) {
    if (input === null || input === undefined) return null;
    if (typeof input === 'number') return Number.isFinite(input) ? input : null;
    let s = String(input).trim();
    if (!s) return null;
    // Keep the first number-ish run (handles "$28.00+" and price ranges).
    const m = s.match(/-?\d[\d.,\s\u00a0']*/);
    if (!m) return null;
    s = m[0].replace(/[\s\u00a0']/g, '');
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastComma > -1 && lastDot > -1) {
      // Whichever separator comes last is the decimal separator.
      if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
      else s = s.replace(/,/g, '');
    } else if (lastComma > -1) {
      const decimals = s.length - lastComma - 1;
      s = decimals === 3 && !/^0/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
    } else {
      s = s.replace(/(?<=\d)\.(?=\d{3}\b)/g, '');
    }
    const n = Number.parseFloat(s);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
  }

  function currencyFromSymbol(symbol) {
    const s = String(symbol || '').trim();
    if (!s) return null;
    if (/^[A-Z]{3}$/.test(s)) return s;
    if (CURRENCY_BY_SYMBOL[s]) return CURRENCY_BY_SYMBOL[s];
    for (const key of Object.keys(CURRENCY_BY_SYMBOL)) {
      if (s.includes(key)) return CURRENCY_BY_SYMBOL[key];
    }
    return null;
  }

  function listingIdFromUrl(url) {
    if (!url) return null;
    const m = String(url).match(/\/listing\/(\d+)/);
    return m ? m[1] : null;
  }

  /** Strip Etsy's tracking/telemetry query params but keep the canonical path. */
  function cleanListingUrl(url) {
    if (!url) return null;
    let raw = String(url).trim();
    if (raw.startsWith('//')) raw = 'https:' + raw;
    if (raw.startsWith('/')) raw = 'https://www.etsy.com' + raw;
    const id = listingIdFromUrl(raw);
    try {
      const u = new URL(raw);
      if (!/etsy\.com$/i.test(u.hostname) && !/\.etsy\.com$/i.test(u.hostname)) {
        return id ? 'https://www.etsy.com/listing/' + id : raw;
      }
      const slug = u.pathname.match(/\/listing\/\d+(?:\/([^/]*))?/);
      if (id) {
        return 'https://www.etsy.com/listing/' + id + (slug && slug[1] ? '/' + slug[1] : '');
      }
      u.search = '';
      u.hash = '';
      return u.toString();
    } catch (_) {
      return raw;
    }
  }

  function bestImage(el) {
    if (!el) return null;
    const srcset = el.getAttribute && (el.getAttribute('srcset') || el.getAttribute('data-srcset'));
    if (srcset) {
      // Pick the highest-density candidate.
      const parts = srcset.split(',').map((p) => p.trim()).filter(Boolean);
      let best = null;
      let bestW = -1;
      for (const part of parts) {
        const [url, size] = part.split(/\s+/);
        const w = size ? Number.parseInt(size, 10) || 0 : 0;
        if (w >= bestW) {
          bestW = w;
          best = url;
        }
      }
      if (best) return absolutize(best);
    }
    const src = (el.getAttribute && (el.getAttribute('src') || el.getAttribute('data-src'))) || el.src;
    return src ? absolutize(src) : null;
  }

  function absolutize(url) {
    const s = String(url || '').trim();
    if (!s) return null;
    if (s.startsWith('//')) return 'https:' + s;
    if (s.startsWith('/')) return 'https://www.etsy.com' + s;
    return s;
  }

  function toNumber(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/[,\s\u00a0]/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  // -------------------------------------------------------------- strategy A

  /** Pull every JSON-LD block out of raw HTML without needing a DOM. */
  function extractJsonLdBlocks(html) {
    const out = [];
    if (!html) return out;
    const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const body = m[1].replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();
      if (!body) continue;
      try {
        out.push(JSON.parse(body));
      } catch (_) {
        // Etsy occasionally emits multiple concatenated objects; try to salvage.
        const salvaged = body.replace(/}\s*{/g, '},{');
        try {
          out.push(JSON.parse('[' + salvaged + ']'));
        } catch (_e) {
          /* unparseable block — ignore */
        }
      }
    }
    return out;
  }

  /** Walk any JSON-LD shape and collect ItemList entries / bare Products. */
  function collectProductNodes(node, acc, depth) {
    if (!node || depth > 6) return acc;
    if (Array.isArray(node)) {
      for (const n of node) collectProductNodes(n, acc, depth + 1);
      return acc;
    }
    if (typeof node !== 'object') return acc;

    if (Array.isArray(node['@graph'])) collectProductNodes(node['@graph'], acc, depth + 1);

    const type = [].concat(node['@type'] || node.type || []).map(String);
    if (type.some((t) => /ItemList/i.test(t)) || Array.isArray(node.itemListElement)) {
      const items = [].concat(node.itemListElement || []);
      items.forEach((entry, idx) => {
        const item = entry && (entry.item || entry.url || entry.name ? entry.item || entry : entry);
        const positionRaw = entry && (entry.position ?? entry.Position);
        acc.push({
          node: item && typeof item === 'object' ? item : entry,
          position: toNumber(positionRaw) || idx + 1,
        });
      });
      return acc;
    }
    if (type.some((t) => /Product|Offer/i.test(t))) {
      acc.push({ node, position: null });
    }
    return acc;
  }

  function offerOf(node) {
    const offers = node && (node.offers || node.offer);
    if (!offers) return null;
    if (Array.isArray(offers)) return offers[0] || null;
    if (typeof offers === 'object') {
      if (offers.priceSpecification && typeof offers.priceSpecification === 'object') {
        return Object.assign({}, offers, offers.priceSpecification);
      }
      return offers;
    }
    return null;
  }

  /** @returns {Array<object>} partial records keyed by listingId where known. */
  function recordsFromJsonLd(html) {
    const blocks = extractJsonLdBlocks(html);
    const nodes = [];
    for (const block of blocks) collectProductNodes(block, nodes, 0);

    const records = [];
    for (const { node, position } of nodes) {
      if (!node || typeof node !== 'object') continue;
      const url = node.url || node['@id'] || (node.mainEntityOfPage && node.mainEntityOfPage['@id']);
      const listingId = listingIdFromUrl(url) || (node.sku ? String(node.sku) : null)
        || (node.productID ? String(node.productID) : null);
      const offer = offerOf(node);
      const agg = node.aggregateRating || (offer && offer.aggregateRating) || null;
      const brandOrSeller = node.brand || (offer && offer.seller) || node.seller || null;

      const rec = {
        listingId: listingId || null,
        title: node.name ? String(node.name).replace(/\s+/g, ' ').trim() : null,
        url: cleanListingUrl(url),
        price: parsePrice(offer && (offer.price ?? offer.lowPrice ?? offer.highPrice)),
        currency: (offer && (offer.priceCurrency || offer.currency)) || null,
        image: pickImage(node.image),
        shopName: nameOf(brandOrSeller),
        rating: agg ? parsePrice(agg.ratingValue) : null,
        reviewCount: agg ? toNumber(agg.reviewCount ?? agg.ratingCount) : null,
        position: position,
        _source: 'jsonld',
      };
      if (!rec.listingId && !rec.title && rec.price === null) continue;
      records.push(rec);
    }
    return records;
  }

  function pickImage(image) {
    if (!image) return null;
    if (typeof image === 'string') return absolutize(image);
    if (Array.isArray(image)) return pickImage(image[0]);
    if (typeof image === 'object') return absolutize(image.url || image.contentUrl || '');
    return null;
  }

  function nameOf(v) {
    if (!v) return null;
    if (typeof v === 'string') return v.trim() || null;
    if (Array.isArray(v)) return nameOf(v[0]);
    if (typeof v === 'object') return v.name ? String(v.name).trim() : null;
    return null;
  }

  // -------------------------------------------------------------- strategy B

  /** Collect listing cards from a DOM, de-duplicating nested matches. */
  function findCards(root) {
    const seen = new Set();
    const cards = [];
    for (const sel of SELECTORS.card) {
      let found = [];
      try {
        found = Array.from(root.querySelectorAll(sel));
      } catch (_) {
        continue;
      }
      for (const el of found) {
        const link = firstMatch(el, SELECTORS.link) || (el.matches && el.matches('a[href*="/listing/"]') ? el : null);
        const href = link && (link.getAttribute('href') || link.href);
        const id = (el.getAttribute && el.getAttribute('data-listing-id')) || listingIdFromUrl(href);
        if (!id) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        cards.push({ el, listingId: String(id) });
      }
      if (cards.length) break;
    }
    return cards;
  }

  function parseCard(el, listingId, index) {
    const link = firstMatch(el, SELECTORS.link);
    const href = link ? link.getAttribute('href') || link.href : null;
    const blob = text(el).toLowerCase();

    const titleEl = firstMatch(el, SELECTORS.title);
    let title = text(titleEl);
    if (!title && link) {
      title = (link.getAttribute('title') || link.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    }

    const priceEl = firstMatch(el, SELECTORS.price);
    let price = priceEl ? parsePrice(text(priceEl)) : null;
    let currency = currencyFromSymbol(text(firstMatch(el, SELECTORS.currencySymbol)));
    if (price === null) {
      // Last resort: sniff a currency-looking token out of the card text.
      const m = text(el).match(/(?:[$€£¥₹₺₽₪]|USD|EUR|GBP|CAD|AUD)\s?\d[\d.,]*/i);
      if (m) {
        price = parsePrice(m[0]);
        currency = currency || currencyFromSymbol(m[0].replace(/[\d.,\s]/g, ''));
      }
    }

    const shopEl = pickShopElement(el);
    const shopName = shopEl
      ? (shopEl.getAttribute && shopEl.getAttribute('data-shop-name')) || text(shopEl)
      : null;

    // Rating must come from something that identifies itself as a rating, and
    // must not simply be the price wearing the same CSS class (see readRating).
    const rating = readRating(el, price);
    const reviewCount = readReviewCount(el, rating !== null);

    return {
      listingId: String(listingId),
      title: title || null,
      url: cleanListingUrl(href) || (listingId ? 'https://www.etsy.com/listing/' + listingId : null),
      price: price,
      currency: currency,
      shopName: cleanShopName(shopName),
      image: bestImage(firstMatch(el, SELECTORS.image)),
      rating: rating,
      reviewCount: reviewCount,
      freeShipping: hasBadge(el, FREE_SHIPPING_BADGE, CONDITIONAL_SHIPPING),
      bestseller: hasBadge(el, BESTSELLER_BADGE),
      // Tri-state on purpose: Etsy labels digital items, but says nothing at all
      // for physical ones, so "no label" is unknown rather than proof of physical.
      isDigital: readIsDigital(el, blob),
      sponsored: detectSponsored(el, blob),
      position: index + 1,
      _source: 'dom',
    };
  }

  /** Elements whose class/attributes declare they are about a star rating. */
  const RATING_CONTEXT = [
    'input[name="rating"]',
    '[aria-label*="out of 5"]', '[title*="out of 5"]',
    '[class*="rating" i]', '[class*="stars" i]', '[data-rating]',
    '[data-stars]', '[aria-label*="star" i]',
  ];

  /**
   * Read a star rating, in descending order of trust.
   *
   * The bug this guards against: an earlier version accepted the first
   * `.wt-text-title-01` number in 0-5, but on the live grid that class is the
   * *price*, so every listing under $5 reported its price as its rating (a $2.59
   * PDF "rated 2.59"). Requiring explicit sources fixed that but returned null
   * for every row on live pages, because Etsy's real markup does not always use
   * a rating input or an "out of 5" label.
   *
   * The rule now: a bare number counts only if it lives in an element that
   * declares itself rating-related AND differs from the card's price. That keeps
   * the two apart without throwing the rating away.
   *
   * @param {?number} price the card's parsed price, used purely as an exclusion
   */
  function readRating(el, price) {
    const input = firstMatch(el, SELECTORS.ratingInput);
    if (input) {
      const value = clampRating(parsePrice(input.getAttribute('value')));
      if (value !== null) return value;
    }

    // "4.8 out of 5 stars" in aria-label, title, or screen-reader text.
    for (const node of allMatches(el, ['[aria-label*="out of 5"]', '[title*="out of 5"]'])) {
      const label = node.getAttribute('aria-label') || node.getAttribute('title') || '';
      const m = label.match(/([0-5](?:[.,]\d+)?)\s*out of 5/i);
      if (m) {
        const value = clampRating(parsePrice(m[1]));
        if (value !== null) return value;
      }
    }
    const srMatch = text(el).match(/([0-5](?:[.,]\d+)?)\s*out of 5(?:\s*stars?)?/i);
    if (srMatch) {
      const value = clampRating(parsePrice(srMatch[1]));
      if (value !== null) return value;
    }

    // A number inside a rating/stars element. Never accepted when it equals the
    // price, because that is exactly the collision described above.
    for (const node of allMatches(el, RATING_CONTEXT)) {
      const value = clampRating(parsePrice(text(node) || node.getAttribute('value')));
      if (value === null) continue;
      if (price !== null && price !== undefined && Math.abs(value - price) < 1e-9) continue;
      return value;
    }
    return null;
  }

  function clampRating(value) {
    if (value === null || !Number.isFinite(value)) return null;
    return value >= 0 && value <= 5 ? value : null;
  }

  /**
   * Review counts live next to the stars. Requiring that context matters: the
   * same "(1,482)" shape also appears for shop-level totals elsewhere in a card,
   * which is why several listings from one shop previously reported an identical
   * review count.
   * @param {boolean} hasRating only trust a bare "(n)" when stars were found
   */
  function readReviewCount(el, hasRating) {
    const explicit = text(el).match(/([\d.,]+)\s*(?:reviews?|ratings?)\b/i);
    if (explicit) return toNumber(explicit[1]);

    if (!hasRating) {
      // No stars found. A single "(1,204)" in the card is still the listing's
      // review count — Etsy renders exactly one. Two or more means we cannot
      // tell which is the listing's, so we decline rather than guess (that
      // ambiguity is how shop-level totals leaked in before).
      const tokens = text(el).match(/\((\d[\d.,\s]*)\)/g) || [];
      if (tokens.length !== 1) return null;
      const only = tokens[0].match(/\((\d[\d.,\s]*)\)/);
      return only ? toNumber(only[1]) : null;
    }

    const container = ratingContainer(el);
    const scope = container || el;
    // Prefer a short element whose entire text is the count, e.g. "(1,204)".
    for (const node of allMatches(scope, ['p, span, div'])) {
      const t = text(node);
      if (t.length > 12) continue;
      const m = t.match(/^\((\d[\d.,\s]*)\)$/);
      if (m) return toNumber(m[1]);
    }
    const loose = text(scope).match(/\((\d[\d.,\s]*)\)/);
    return loose ? toNumber(loose[1]) : null;
  }

  /** The smallest element that holds the rating, used to scope the count. */
  function ratingContainer(el) {
    const anchor = firstMatch(el, SELECTORS.ratingInput)
      || firstMatch(el, ['[aria-label*="out of 5"]', '[title*="out of 5"]']);
    if (!anchor) return null;
    let node = anchor.parentElement;
    for (let depth = 0; node && depth < 3; depth += 1) {
      if (/\(\s*\d/.test(text(node))) return node;
      node = node.parentElement;
    }
    return anchor.parentElement || null;
  }

  const FREE_SHIPPING_BADGE = /^free\s+(?:standard\s+)?(?:shipping|delivery)\b/i;
  /** "Free shipping on orders over $35" is a shop promotion, not this listing. */
  const CONDITIONAL_SHIPPING = /orders? over|when you spend|on orders of/i;
  const BESTSELLER_BADGE = /^best\s?seller\b/i;
  const DIGITAL_BADGE = /^(?:digital\s+(?:download|file)|instant\s+download)\b/i;
  const DIGITAL_TEXT = /digital download|instant download|digital file|digital item/i;

  /**
   * Digital vs unknown, tri-state.
   *
   * Badge-only matching proved far too strict on live pages: a strict run of
   * "2026 calendar template" kept 12 of ~61 rows because Etsy does not always
   * render the label as its own short element. The card text is checked too —
   * these phrases do not appear incidentally on physical listings, so recall
   * goes up without inviting false positives. Absence still means `null`
   * (unknown), never `false`, because Etsy says nothing for physical items.
   */
  function readIsDigital(el, blob) {
    if (hasBadge(el, DIGITAL_BADGE)) return true;
    return DIGITAL_TEXT.test(blob) ? true : null;
  }

  /**
   * Badges are their own short elements. Testing the whole card's text instead
   * matches any incidental copy ("Bestselling shop", a shop-wide shipping
   * promotion), which marked most listings as bestsellers in real runs.
   */
  function hasBadge(el, pattern, excludePattern) {
    for (const node of allMatches(el, ['span, p, div, li'])) {
      const t = text(node);
      if (!t || t.length > 40) continue;
      if (!pattern.test(t)) continue;
      if (excludePattern && excludePattern.test(t)) continue;
      return true;
    }
    return false;
  }

  const SHOP_PREFIX = /^(?:designed\s+by|made\s+by|sold\s+by|from\s+shop|shop\s+by|ad\s+by\s+etsy\s+seller|ad\s+by|by)\s+/i;

  /** Etsy prefixes the seller with "Designed by" / "By" / "Made by". */
  function cleanShopName(name) {
    if (!name) return null;
    const cleaned = String(name).replace(/\s+/g, ' ').trim().replace(SHOP_PREFIX, '').trim();
    return cleaned || null;
  }

  function pickShopElement(el) {
    const explicit = firstMatch(el, ['[data-shop-name]']);
    if (explicit) return explicit;
    // Shop name lives in a small-caption element that is not the title/price.
    const candidates = allMatches(el, [
      'p.wt-text-caption span, span.wt-text-caption, p.wt-text-body-01, .v2-listing-card__shop p',
    ]);
    for (const c of candidates) {
      const t = text(c);
      if (!t || t.length > 60) continue;
      if (/^\(|\)$|out of 5|free shipping|bestseller|ad by|from shop|star seller|\d+\+? sales/i.test(t)) continue;
      if (/^[$€£¥₹]/.test(t)) continue;
      // A bare number is a rating or a count, never a shop name. (A live card
      // put "4.8" in the same caption class the shop name uses.)
      if (/^\d+([.,]\d+)?$/.test(t)) continue;
      if (/digital download|instant download|digital file/i.test(t)) continue;
      const m = t.match(/^(?:from shop\s+)?(.+)$/i);
      return { textContent: m ? m[1] : t, getAttribute: () => null };
    }
    const adBy = text(el).match(/Ad (?:by|from) (?:Etsy seller\s+)?([\w .'&-]{2,50})/i);
    if (adBy) return { textContent: adBy[1], getAttribute: () => null };
    return null;
  }

  function detectSponsored(el, blob) {
    if (/\bad by\b|\bad from\b|sponsored/.test(blob)) return true;
    const attrs = ['data-ad-id', 'data-is-ad', 'data-osa-ad', 'data-palette-listing-image'];
    for (const a of attrs.slice(0, 3)) {
      if (el.getAttribute && el.getAttribute(a)) return true;
    }
    try {
      if (el.querySelector('[data-ad-id], .wt-badge--sponsored, [data-osa-ad]')) return true;
    } catch (_) { /* noop */ }
    return false;
  }

  function recordsFromDom(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    return findCards(root).map(({ el, listingId }, i) => parseCard(el, listingId, i));
  }

  // ------------------------------------------------------------------- merge

  const MERGE_ORDER = [
    'title', 'url', 'price', 'currency', 'shopName', 'image', 'rating',
    'reviewCount', 'freeShipping', 'bestseller', 'sponsored', 'position',
  ];

  /**
   * DOM records win on ordering/badges; JSON-LD fills any gap. Records unique
   * to either source are kept.
   */
  function mergeRecords(domRecords, jsonLdRecords) {
    const byId = new Map();
    const order = [];

    const put = (rec) => {
      const key = rec.listingId || rec.url || 'idx:' + order.length;
      if (!byId.has(key)) {
        byId.set(key, Object.assign({}, rec));
        order.push(key);
        return;
      }
      const target = byId.get(key);
      for (const f of MERGE_ORDER) {
        const incoming = rec[f];
        const currentEmpty = target[f] === null || target[f] === undefined || target[f] === '';
        const incomingEmpty = incoming === null || incoming === undefined || incoming === '';
        // Fill gaps only: whoever got there first (the DOM) keeps its value.
        if (currentEmpty && !incomingEmpty) target[f] = incoming;
      }
      target._source = target._source === rec._source ? target._source : 'jsonld+dom';
    };

    // Order matters: DOM first (it owns ordering and badges), JSON-LD second.
    domRecords.forEach((r) => put(r));
    jsonLdRecords.forEach((r) => put(r));

    return order.map((k) => byId.get(k));
  }

  // ------------------------------------------------------------- block check

  function detectBlock(html, doc) {
    const hay = String(html || (doc && doc.documentElement ? doc.documentElement.innerHTML : '') || '')
      .slice(0, 200000)
      .toLowerCase();
    for (const marker of BLOCK_MARKERS) {
      if (hay.includes(marker)) return { blocked: true, reason: marker };
    }
    if (/<title>[^<]*(just a moment|attention required|robot check)[^<]*<\/title>/i.test(hay)) {
      return { blocked: true, reason: 'interstitial title' };
    }
    return { blocked: false, reason: null };
  }

  function looksLikeNoResults(html, doc) {
    const hay = String(html || '').toLowerCase();
    if (/no results|we couldn't find any|found no results|0 results/.test(hay)) return true;
    if (doc) {
      const t = text(firstMatch(doc, ['[data-search-results-count]', 'h1', '.search-title']));
      if (/no results/i.test(t)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- top level

  /**
   * Parse one Etsy search page.
   * @param {{html?:string, doc?:Document, context?:object}} input
   *   `html` for the fetch engine, `doc` for the in-tab engine (either or both).
   * @returns {{records:Array<object>, blocked:boolean, blockReason:?string,
   *            counts:{jsonld:number,dom:number,merged:number}, noResults:boolean}}
   */
  function parsePage(input) {
    const opts = input || {};
    const html = opts.html || '';
    const doc = opts.doc || null;
    const context = opts.context || {};

    const block = detectBlock(html, doc);
    const jsonLd = recordsFromJsonLd(html || (doc ? serialize(doc) : ''));
    const dom = recordsFromDom(doc);
    let merged = mergeRecords(dom, jsonLd);

    merged = merged
      .filter((r) => r.listingId || r.url)
      .map((r, i) => finalize(r, i, context));

    return {
      records: merged,
      blocked: block.blocked,
      blockReason: block.reason,
      noResults: merged.length === 0 && looksLikeNoResults(html, doc),
      counts: { jsonld: jsonLd.length, dom: dom.length, merged: merged.length },
    };
  }

  function serialize(doc) {
    try {
      return doc.documentElement ? doc.documentElement.outerHTML : '';
    } catch (_) {
      return '';
    }
  }

  /** Shape a partial record into the documented output schema. */
  function finalize(rec, index, context) {
    const ctx = context || {};
    const perPage = Number(ctx.resultsPerPage) || 0;
    const page = Number(ctx.page) || 1;
    const localPosition = Number(rec.position) || index + 1;
    return {
      query: ctx.query != null ? String(ctx.query) : null,
      page: page,
      position: perPage ? (page - 1) * perPage + localPosition : localPosition,
      listingId: rec.listingId || listingIdFromUrl(rec.url),
      title: rec.title || null,
      price: rec.price === undefined ? null : rec.price,
      currency: rec.currency || ctx.defaultCurrency || null,
      shopName: rec.shopName || null,
      image: rec.image || null,
      url: rec.url || null,
      rating: rec.rating === undefined ? null : rec.rating,
      reviewCount: rec.reviewCount === undefined ? null : rec.reviewCount,
      freeShipping: Boolean(rec.freeShipping),
      bestseller: Boolean(rec.bestseller),
      sponsored: Boolean(rec.sponsored),
      isDigital: rec.isDigital === true ? true : (rec.isDigital === false ? false : null),
      scrapedAt: ctx.scrapedAt || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      _source: rec._source || null,
      _sourceUrl: ctx.sourceUrl || null,
    };
  }

  return {
    SELECTORS,
    parsePage,
    recordsFromJsonLd,
    recordsFromDom,
    mergeRecords,
    extractJsonLdBlocks,
    detectBlock,
    looksLikeNoResults,
    parsePrice,
    currencyFromSymbol,
    listingIdFromUrl,
    cleanListingUrl,
    finalize,
    readRating,
    readReviewCount,
    cleanShopName,
    hasBadge,
    parseCard,
  };
});
