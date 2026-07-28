/**
 * Service worker entry point: message router + worker keep-alive.
 *
 * All heavy lifting lives in runner.js; this file only wires the UI to it.
 */

import { MSG, RUN_STATUS } from '../common/constants.js';
import * as store from './store.js';
import * as runner from './runner.js';
import * as history from './history.js';

const KEEPALIVE_ALARM = 'etsy-scraper-keepalive';
let keepAliveTimer = null;

/**
 * MV3 suspends idle workers after ~30s. A run spends most of its time in
 * setTimeout (politeness delays), which does not count as activity, so we poke
 * an extension API on an interval while a run is in flight.
 */
function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 20000);
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
  chrome.alarms.clear(KEEPALIVE_ALARM).catch(() => {});
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM && !runner.isRunning()) stopKeepAlive();
});

chrome.runtime.onInstalled.addListener(async (details) => {
  await store.getSettings(); // materialise defaults
  if (details.reason === 'install') {
    await store.log('info', 'Etsy Search Scraper installed. Add keywords and press Start.');
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Messages addressed to the offscreen document are none of our business.
  if (!message || message.target === 'offscreen') return false;

  handleMessage(message)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true; // async response
});

async function handleMessage(message) {
  switch (message.type) {
    case MSG.GET_SETTINGS:
      return store.getSettings();

    case MSG.SAVE_SETTINGS:
      return store.saveSettings(message.settings);

    case MSG.GET_STATE: {
      const [state, rows, details, reviews, historyStats] = await Promise.all([
        store.getState(), store.getRows(), store.getDetails(), store.getReviews(), history.stats(),
      ]);
      return {
        state,
        rowCount: rows.length,
        detailCount: details.length,
        reviewCount: reviews.length,
        history: historyStats,
        running: runner.isRunning(),
      };
    }

    case MSG.GET_DETAILS: {
      const details = await store.getDetails();
      const limit = Number(message.limit) || 0;
      return { total: details.length, rows: limit > 0 ? details.slice(0, limit) : details };
    }

    case MSG.GET_REVIEWS: {
      const reviews = await store.getReviews();
      const limit = Number(message.limit) || 0;
      return { total: reviews.length, rows: limit > 0 ? reviews.slice(0, limit) : reviews };
    }

    case MSG.GET_HISTORY_ROWS: {
      // The snapshot series behind every velocity figure. Survives `Clear`, so it
      // can span runs and is worth exporting on its own.
      const rows = await history.exportHistory();
      const limit = Number(message.limit) || 0;
      return { total: rows.length, rows: limit > 0 ? rows.slice(0, limit) : rows };
    }

    case MSG.GET_RESULTS: {
      const rows = await store.getRows();
      const limit = Number(message.limit) || 0;
      return {
        total: rows.length,
        rows: limit > 0 ? rows.slice(0, limit) : rows,
      };
    }

    case MSG.CLEAR_RESULTS:
      await store.clearRows();
      await store.resetState({ message: 'Results cleared.' });
      return { cleared: true };

    case MSG.START_RUN: {
      if (runner.isRunning()) throw new Error('A run is already in progress');
      startKeepAlive();
      // Fire and forget: the UI follows progress through STATE_CHANGED.
      runner
        .startRun(message.settings)
        .catch(async (err) => {
          await store.patchState({
            status: RUN_STATUS.ERROR,
            message: String((err && err.message) || err),
          });
          await store.log('error', `Run failed: ${(err && err.message) || err}`);
        })
        .finally(() => {
          stopKeepAlive();
        });
      return { started: true };
    }

    case MSG.STOP_RUN:
      return { stopping: runner.stopRun() };

    case MSG.SCRAPE_ACTIVE_TAB:
      return runner.scrapeActiveTab();

    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
}
