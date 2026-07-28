/**
 * Where scraped pages are opened.
 *
 * This matters more than it looks. A tab created with `active: false` in your
 * current window reports `document.visibilityState === 'hidden'`, and plenty of
 * page scripts — including other extensions' panels such as EHunt — defer their
 * work until the page becomes visible. So a hidden tab renders Etsy's own markup
 * but never the third-party panel we want to read.
 *
 * Three modes:
 *   background — a hidden tab in your current window (cheapest, original
 *                behaviour; fine when nothing needs to be *visible*)
 *   window     — one separate, unfocused window reused for the whole run. Its
 *                active tab counts as visible, so panels render, while your own
 *                window keeps focus and stays uncluttered. This is the mode that
 *                makes EHunt work.
 *   foreground — a tab in your current window, activated. Useful for watching a
 *                run or solving a challenge, disruptive otherwise.
 */

export const TAB_MODES = {
  background: 'background',
  window: 'window',
  foreground: 'foreground',
};

const state = { windowId: null };

/**
 * Open a page for scraping.
 * @param {string} url
 * @param {{tabMode?:string}} [opts]
 * @returns {Promise<{tabId:number, windowId:?number}>}
 */
export async function openScrapeTab(url, opts = {}) {
  const mode = TAB_MODES[opts.tabMode] || TAB_MODES.background;

  if (mode === TAB_MODES.window) {
    const windowId = await ensureScrapeWindow();
    if (windowId !== null) {
      // Active *within* the scraping window, so the page is visible and renders,
      // while the window itself stays unfocused behind yours.
      const tab = await chrome.tabs.create({ windowId, url, active: true });
      return { tabId: tab.id, windowId };
    }
    // Window creation refused (e.g. no window access): fall back rather than fail.
  }

  const tab = await chrome.tabs.create({
    url,
    active: mode === TAB_MODES.foreground,
  });
  return { tabId: tab.id, windowId: tab.windowId == null ? null : tab.windowId };
}

async function ensureScrapeWindow() {
  if (state.windowId !== null) {
    try {
      await chrome.windows.get(state.windowId);
      return state.windowId;
    } catch (_) {
      // The user closed it; make a new one.
      state.windowId = null;
    }
  }
  try {
    const win = await chrome.windows.create({
      url: 'about:blank',
      focused: false, // your window keeps focus
      state: 'normal', // NOT minimized: minimized windows are hidden again
      width: 1280,
      height: 900,
    });
    state.windowId = win.id;
    return win.id;
  } catch (err) {
    console.warn('[etsy-scraper] could not open a scraping window', err);
    return null;
  }
}

/** Close the scraping window at the end of a run. */
export async function closeScrapeSurface() {
  if (state.windowId === null) return;
  const windowId = state.windowId;
  state.windowId = null;
  try {
    await chrome.windows.remove(windowId);
  } catch (_) {
    /* already gone */
  }
}

/**
 * Hidden tabs stop third-party panels from rendering, so a run that needs one
 * must not use `background`.
 * @returns {?string} the mode to use instead, or null when the choice is fine
 */
export function upgradeModeForVisibility(tabMode, needsVisiblePage) {
  if (!needsVisiblePage) return null;
  const mode = TAB_MODES[tabMode] || TAB_MODES.background;
  return mode === TAB_MODES.background ? TAB_MODES.window : null;
}

export function scrapeWindowId() {
  return state.windowId;
}
