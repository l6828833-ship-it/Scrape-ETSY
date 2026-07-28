/**
 * Engine B — load the search page in a real (background) tab.
 *
 * Slower and heavier than fetch, but the page executes its JavaScript, so
 * lazy-loaded cards appear and challenge pages can be solved by the user.
 */

const INJECT_FILES = ['src/common/parse.js', 'src/content/extract.js'];

function waitForTabComplete(tabId, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(arg);
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') finish(resolve, true);
    };
    const onRemoved = (id) => {
      if (id === tabId) finish(reject, new Error('tab closed before load finished'));
    };
    const onAbort = () => finish(reject, new Error('aborted'));
    const timer = setTimeout(() => finish(resolve, false), timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    // The tab may already be loaded before listeners attached.
    chrome.tabs.get(tabId).then((tab) => {
      if (tab && tab.status === 'complete') finish(resolve, true);
    }).catch(() => { /* handled by onRemoved/timeout */ });
  });
}

async function runExtract(tabId, context, tuning) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: INJECT_FILES,
  });
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (opts) => globalThis.__etsyExtract(opts),
    args: [{ context, ...tuning }],
  });
  return result;
}

/**
 * @param {string} url
 * @param {object} opts
 * @param {AbortSignal} [opts.signal]
 * @param {object} opts.context parser context ({query, page, sourceUrl, ...})
 * @param {boolean} [opts.keepTabsOpen]
 * @param {boolean} [opts.manualCaptchaSolve] focus the tab and wait for a human
 * @param {number} [opts.captchaWaitMs]
 * @param {(level:string, msg:string)=>void} [opts.onNotice]
 * @returns {Promise<{ok:boolean, result:?object, error:?string, blocked:boolean}>}
 */
export async function scrapeInTab(url, opts = {}) {
  const {
    signal,
    context = {},
    keepTabsOpen = false,
    manualCaptchaSolve = true,
    captchaWaitMs = 180000,
    loadTimeoutMs = 60000,
    onNotice = () => {},
    tuning = {},
  } = opts;

  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
    await waitForTabComplete(tabId, loadTimeoutMs, signal);

    let result = await runExtract(tabId, context, tuning);

    if (result && result.blocked && manualCaptchaSolve) {
      onNotice('warn', `Challenge detected on "${context.query}" p${context.page} — solve it in the opened tab.`);
      await chrome.tabs.update(tabId, { active: true });
      try {
        const t = await chrome.tabs.get(tabId);
        if (t.windowId != null) await chrome.windows.update(t.windowId, { focused: true, drawAttention: true });
      } catch (_) { /* window may be gone */ }

      const deadline = Date.now() + captchaWaitMs;
      while (Date.now() < deadline) {
        if (signal && signal.aborted) throw new Error('aborted');
        await new Promise((r) => setTimeout(r, 3000));
        try {
          result = await runExtract(tabId, context, tuning);
        } catch (_) {
          continue; // navigating — retry
        }
        if (result && !result.blocked) {
          onNotice('success', 'Challenge cleared, continuing.');
          break;
        }
      }
    }

    if (!result) return { ok: false, result: null, error: 'no result from injected script', blocked: false };
    if (result.error) return { ok: false, result, error: result.error, blocked: Boolean(result.blocked) };
    if (result.blocked) return { ok: false, result, error: `blocked: ${result.blockReason}`, blocked: true };
    return { ok: true, result, error: null, blocked: false };
  } catch (err) {
    return { ok: false, result: null, error: String((err && err.message) || err), blocked: false };
  } finally {
    if (tabId != null && !keepTabsOpen) {
      try {
        await chrome.tabs.remove(tabId);
      } catch (_) { /* already closed */ }
    }
  }
}

/** Scrape whatever Etsy search page the user is currently looking at. */
export async function scrapeExistingTab(tabId, context, tuning = {}) {
  try {
    const result = await runExtract(tabId, context, tuning);
    if (!result) return { ok: false, result: null, error: 'no result', blocked: false };
    return { ok: !result.error && !result.blocked, result, error: result.error || null, blocked: Boolean(result.blocked) };
  } catch (err) {
    return { ok: false, result: null, error: String((err && err.message) || err), blocked: false };
  }
}
