/**
 * Offscreen document: turns raw HTML into listing records using DOMParser plus
 * the shared parser. Classic script — `EtsyParse` comes from parse.js.
 */
(function () {
  'use strict';

  const PARSE_HTML = 'PARSE_HTML';

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target !== 'offscreen' || message.type !== PARSE_HTML) return false;
    try {
      const doc = new DOMParser().parseFromString(String(message.html || ''), 'text/html');
      const result = globalThis.EtsyParse.parsePage({
        html: message.html,
        doc,
        context: message.context || {},
      });
      sendResponse({ result });
    } catch (err) {
      sendResponse({ error: String((err && err.message) || err) });
    }
    return true; // keep the channel open for the (already sent) response
  });
})();
