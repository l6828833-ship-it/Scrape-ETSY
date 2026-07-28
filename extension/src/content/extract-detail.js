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
      }
      const html = document.documentElement ? document.documentElement.outerHTML : '';
      const result = globalThis.EtsyDetail.parseListingPage({ html, doc: document, context });
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
