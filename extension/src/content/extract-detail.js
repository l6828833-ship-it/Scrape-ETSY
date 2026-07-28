/**
 * Injected into a real Etsy listing tab (isolated world). Scrolls far enough to
 * materialise the reviews block, expands truncated review text where possible,
 * then parses the live DOM.
 *
 * Injected alongside common/parse.js and common/detail-parse.js, which provide
 * `EtsyParse` and `EtsyDetail`.
 */
(function () {
  'use strict';

  if (globalThis.__etsyExtractDetail) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function scrollThroughPage(passes, pauseMs) {
    const height = () => document.documentElement.scrollHeight;
    for (let i = 0; i < passes; i += 1) {
      window.scrollTo(0, (height() / passes) * (i + 1));
      await sleep(pauseMs);
    }
    window.scrollTo(0, height());
    await sleep(pauseMs);
  }

  /**
   * Etsy's tag section is an empty placeholder in the served HTML and loads on
   * demand, so a page we merely scrolled past can still have no tag links in it.
   * Scroll the module itself into view — that is what triggers the load — and
   * poll until links appear.
   *
   * Returns the number of `/market/` links present when we stopped waiting, so
   * the run can distinguish "the module never loaded" from "Etsy renamed the
   * markup" instead of reporting a bare null.
   */
  async function waitForTagLinks(timeoutMs) {
    const countLinks = () => document.querySelectorAll('a[href*="/market/"]').length;
    if (countLinks() > 0) return countLinks();

    const selectors = (globalThis.EtsyDetail && globalThis.EtsyDetail.SELECTORS
      && globalThis.EtsyDetail.SELECTORS.tagsModule) || [];
    const findModule = () => {
      for (const sel of selectors) {
        try {
          const el = document.querySelector(sel);
          if (el) return el;
        } catch (_) { /* unsupported selector */ }
      }
      return null;
    };

    const deadline = Date.now() + timeoutMs;
    const restoreY = window.scrollY;
    while (Date.now() < deadline) {
      const module = findModule();
      if (module && typeof module.scrollIntoView === 'function') {
        try {
          module.scrollIntoView({ block: 'center' });
        } catch (_) { /* detached */ }
      }
      await sleep(300);
      if (countLinks() > 0) break;
    }
    window.scrollTo(0, restoreY);
    return countLinks();
  }

  /** Reviews are lazily rendered; wait for the region or give up quietly. */
  async function waitForReviews(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (document.querySelector('[data-review-region], .review-card, [data-reviews-container]')) return true;
      await sleep(250);
    }
    return false;
  }

  /**
   * Click "Read more" toggles so full review text is in the DOM. Only ever
   * clicks in-page disclosure controls — never pagination or anything that
   * navigates or submits.
   */
  function expandReviewText(limit) {
    let clicked = 0;
    const toggles = document.querySelectorAll(
      'button[id^="review-preview-toggle"], [data-review-text] + button, button.wt-btn--link',
    );
    for (const button of toggles) {
      if (clicked >= limit) break;
      const label = (button.textContent || '').trim().toLowerCase();
      if (!/read more|more$|show more/.test(label)) continue;
      try {
        button.click();
        clicked += 1;
      } catch (_) { /* ignore uncooperative buttons */ }
    }
    return clicked;
  }

  /**
   * Wait for the EHunt panel, then parse it. Returns null when EHunt is not
   * installed or has not rendered — an absent third-party panel is a normal
   * outcome, never an error.
   */
  async function readEhunt(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let panel = null;
    while (Date.now() < deadline) {
      if (globalThis.EtsyEhunt.isPresent(document)) {
        panel = globalThis.EtsyEhunt.parsePanel(document);
        // Its tag list fills in after the panel frame appears; wait for tags.
        if (panel && panel.tags && panel.tags.length) return panel;
      }
      await sleep(300);
    }
    return panel;
  }

  globalThis.__etsyExtractDetail = async function __etsyExtractDetail(options) {
    const opts = options || {};
    const context = opts.context || {};
    try {
      if (opts.scroll !== false) {
        await scrollThroughPage(opts.scrollPasses == null ? 4 : opts.scrollPasses,
          opts.scrollPauseMs == null ? 350 : opts.scrollPauseMs);
        if (context.scrapeReviews !== false) {
          await waitForReviews(opts.waitForReviewsMs == null ? 5000 : opts.waitForReviewsMs);
          if (expandReviewText(context.maxReviews || 20) > 0) await sleep(400);
        }
        await waitForTagLinks(opts.tagWaitMs == null ? 5000 : opts.tagWaitMs);
      }
      const html = document.documentElement ? document.documentElement.outerHTML : '';
      const result = globalThis.EtsyDetail.parseListingPage({ html, doc: document, context });

      // EHunt (Etsy Rank Tool) injects its panel into this same DOM, and it is
      // the one place a listing's real 13 tags appear on the page. It renders
      // asynchronously, so wait briefly before reading.
      if (context.useEhuntPanel !== false && globalThis.EtsyEhunt) {
        const ehunt = await readEhunt(opts.ehuntTimeoutMs == null ? 6000 : opts.ehuntTimeoutMs);
        result.record = globalThis.EtsyEhunt.mergeEhuntRecord(result.record, ehunt);
        result.ehuntFound = Boolean(ehunt);
        // "Panel never appeared" and "panel appeared but its tag list was still
        // empty" need opposite fixes, so they are reported separately.
        result.ehuntOnPage = globalThis.EtsyEhunt.isInstalledOnPage(document);
        result.ehuntTagCount = (ehunt && ehunt.tags && ehunt.tags.length) || 0;
      }

      result.locationHref = location.href;
      return result;
    } catch (err) {
      return {
        record: null,
        reviews: [],
        blocked: false,
        blockReason: null,
        counts: { jsonld: 0, dom: 0, reviews: 0 },
        error: String((err && err.message) || err),
        locationHref: location.href,
      };
    }
  };
})();
