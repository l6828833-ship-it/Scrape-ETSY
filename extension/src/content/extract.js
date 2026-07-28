/**
 * Injected into a real Etsy tab (isolated world). Scrolls to trigger Etsy's
 * lazy-loaded listing images/cards, then parses the live DOM.
 *
 * Injected together with common/parse.js, which provides `EtsyParse`.
 * Exposes `__etsyExtract(options) -> Promise<result>` for scripting.executeScript.
 */
(function () {
  'use strict';

  if (globalThis.__etsyExtract) return; // already injected in this frame

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function autoScroll(passes, pauseMs) {
    const height = () => document.documentElement.scrollHeight;
    let previous = 0;
    for (let i = 0; i < passes; i += 1) {
      window.scrollTo(0, height());
      await sleep(pauseMs);
      const current = height();
      const cards = document.querySelectorAll('[data-listing-id]').length;
      if (current === previous && cards > 0 && i > 0) break;
      previous = current;
    }
    window.scrollTo(0, 0);
    await sleep(150);
  }

  async function waitForCards(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (document.querySelector('[data-listing-id], a[href*="/listing/"]')) return true;
      await sleep(250);
    }
    return false;
  }

  globalThis.__etsyExtract = async function __etsyExtract(options) {
    const opts = options || {};
    const context = opts.context || {};
    try {
      await waitForCards(opts.waitForCardsMs == null ? 8000 : opts.waitForCardsMs);
      if (opts.scroll !== false) {
        await autoScroll(opts.scrollPasses == null ? 6 : opts.scrollPasses,
          opts.scrollPauseMs == null ? 450 : opts.scrollPauseMs);
      }
      const html = document.documentElement ? document.documentElement.outerHTML : '';
      const result = globalThis.EtsyParse.parsePage({ html, doc: document, context });
      result.title = document.title;
      result.locationHref = location.href;
      return result;
    } catch (err) {
      return {
        records: [],
        blocked: false,
        blockReason: null,
        noResults: false,
        counts: { jsonld: 0, dom: 0, merged: 0 },
        error: String((err && err.message) || err),
        locationHref: location.href,
      };
    }
  };
})();
