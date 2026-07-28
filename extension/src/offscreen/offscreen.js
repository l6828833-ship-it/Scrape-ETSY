/**
 * Offscreen document: turns raw HTML into records using DOMParser plus the
 * shared parsers. Classic script — `EtsyParse` / `EtsyDetail` come from the
 * scripts included by offscreen.html.
 */
(function () {
  'use strict';

  const PARSE_HTML = 'PARSE_HTML';
  const PARSE_DETAIL = 'PARSE_DETAIL';

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target !== 'offscreen') return false;
    if (message.type !== PARSE_HTML && message.type !== PARSE_DETAIL) return false;

    try {
      const doc = new DOMParser().parseFromString(String(message.html || ''), 'text/html');
      const context = message.context || {};
      const result = message.type === PARSE_DETAIL
        ? globalThis.EtsyDetail.parseListingPage({ html: message.html, doc, context })
        : globalThis.EtsyParse.parsePage({ html: message.html, doc, context });
      sendResponse({ result });
    } catch (err) {
      sendResponse({ error: String((err && err.message) || err) });
    }
    return true; // keep the channel open for the (already sent) response
  });
})();
