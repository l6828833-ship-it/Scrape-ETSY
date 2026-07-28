/**
 * Bridge to the offscreen document.
 *
 * MV3 service workers have no DOMParser, so fetched HTML is shipped to an
 * offscreen document that owns the DOM-based half of the parser. If the
 * offscreen API is unavailable, callers fall back to JSON-LD-only parsing
 * (which is pure string work and runs fine in the worker).
 */

import { MSG, OFFSCREEN_PATH } from '../common/constants.js';

let creating = null;
let unavailableReason = null;

async function hasOffscreenDocument() {
  if (!chrome.runtime.getContexts) return false;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

export async function ensureOffscreen() {
  if (unavailableReason) throw new Error(unavailableReason);
  if (!chrome.offscreen) {
    unavailableReason = 'chrome.offscreen unavailable (needs Chrome 109+)';
    throw new Error(unavailableReason);
  }
  if (await hasOffscreenDocument()) return;
  if (creating) {
    await creating;
    return;
  }
  creating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['DOM_PARSER'],
      justification: 'Parse fetched Etsy search HTML into listing records.',
    })
    .catch((err) => {
      // Racing creations can throw "Only a single offscreen document" — benign.
      if (!/single offscreen document/i.test(String(err && err.message))) throw err;
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

export function offscreenAvailable() {
  return !unavailableReason && Boolean(chrome.offscreen);
}

/**
 * @param {string} html raw search-page HTML
 * @param {object} context {query, page, sourceUrl, resultsPerPage, scrapedAt}
 * @returns {Promise<object>} EtsyParse.parsePage() result
 */
export async function parseHtmlOffscreen(html, context) {
  return sendToOffscreen(MSG.PARSE_HTML, html, context);
}

/**
 * Parse a listing (detail) page in the offscreen document.
 * @returns {Promise<object>} EtsyDetail.parseListingPage() result
 */
export async function parseDetailOffscreen(html, context) {
  return sendToOffscreen(MSG.PARSE_DETAIL, html, context);
}

async function sendToOffscreen(type, html, context) {
  await ensureOffscreen();
  const response = await chrome.runtime.sendMessage({
    type,
    target: 'offscreen',
    html,
    context,
  });
  if (!response) throw new Error('offscreen parser returned no response');
  if (response.error) throw new Error(response.error);
  return response.result;
}

export async function closeOffscreen() {
  try {
    if (chrome.offscreen && (await hasOffscreenDocument())) {
      await chrome.offscreen.closeDocument();
    }
  } catch (_) {
    /* nothing to close */
  }
}
