/**
 * Optional proxy support.
 *
 * Caveat worth understanding: an extension cannot set a proxy per request. The
 * only knob available is chrome.proxy, which is browser-wide. To keep the blast
 * radius small we install a PAC script that routes ONLY *.etsy.com through the
 * proxy and sends everything else DIRECT, and we rotate by re-installing the
 * PAC script with the next proxy every N requests.
 *
 * Permissions are optional and requested at runtime, so users who don't need
 * proxies never see the scary install-time warnings.
 */

const OPTIONAL_PERMS = { permissions: ['proxy', 'webRequest', 'webRequestAuthProvider'] };

const state = {
  applied: false,
  proxies: [],
  index: 0,
  requestsSinceRotate: 0,
  credentials: new Map(), // "host:port" -> {username, password}
  authListener: null,
};

/** Parse "http://user:pass@host:8080" into PAC + auth pieces. */
export function parseProxyUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const withScheme = /^[a-z0-9]+:\/\//i.test(text) ? text : `http://${text}`;
  let u;
  try {
    u = new URL(withScheme);
  } catch (_) {
    return null;
  }
  if (!u.hostname || !u.port) {
    if (!u.hostname) return null;
  }
  const scheme = u.protocol.replace(':', '').toLowerCase();
  const pacScheme = {
    http: 'PROXY',
    https: 'HTTPS',
    socks: 'SOCKS',
    socks4: 'SOCKS',
    socks5: 'SOCKS5',
  }[scheme] || 'PROXY';
  const port = u.port || (scheme === 'https' ? '443' : '8080');
  return {
    pac: `${pacScheme} ${u.hostname}:${port}`,
    host: u.hostname,
    port: Number(port),
    username: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || ''),
    label: `${scheme}://${u.hostname}:${port}`,
  };
}

export async function hasProxyPermissions() {
  if (!chrome.permissions) return false;
  return chrome.permissions.contains(OPTIONAL_PERMS);
}

/** Must be called from a user gesture (i.e. the UI), not the worker. */
export async function requestProxyPermissions() {
  return chrome.permissions.request(OPTIONAL_PERMS);
}

function buildPac(entry) {
  return `function FindProxyForURL(url, host) {
  if (shExpMatch(host, "*etsy.com") || shExpMatch(host, "*.etsy.com") || shExpMatch(host, "*etsystatic.com")) {
    return "${entry.pac}; DIRECT";
  }
  return "DIRECT";
}`;
}

function installAuthListener() {
  if (state.authListener || !chrome.webRequest || !chrome.webRequest.onAuthRequired) return;
  state.authListener = (details, callback) => {
    if (!details.isProxy) {
      if (callback) callback({});
      return;
    }
    const key = `${details.challenger && details.challenger.host}:${details.challenger && details.challenger.port}`;
    const creds = state.credentials.get(key);
    if (callback) callback(creds ? { authCredentials: creds } : {});
  };
  try {
    chrome.webRequest.onAuthRequired.addListener(
      state.authListener,
      { urls: ['<all_urls>'] },
      ['asyncBlocking'],
    );
  } catch (err) {
    console.warn('[etsy-scraper] proxy auth listener unavailable', err);
    state.authListener = null;
  }
}

function removeAuthListener() {
  if (state.authListener && chrome.webRequest && chrome.webRequest.onAuthRequired) {
    try {
      chrome.webRequest.onAuthRequired.removeListener(state.authListener);
    } catch (_) { /* noop */ }
  }
  state.authListener = null;
}

/**
 * @param {{enabled:boolean, proxies:string[], rotateEveryRequests:number}} config
 * @returns {Promise<{applied:boolean, reason?:string, label?:string, count?:number}>}
 */
export async function applyProxyConfiguration(config) {
  const cfg = config || {};
  if (!cfg.enabled) return { applied: false, reason: 'disabled' };

  const entries = (cfg.proxies || []).map(parseProxyUrl).filter(Boolean);
  if (!entries.length) return { applied: false, reason: 'no valid proxy URLs' };
  if (!(await hasProxyPermissions())) return { applied: false, reason: 'proxy permission not granted' };
  if (!chrome.proxy) return { applied: false, reason: 'chrome.proxy unavailable' };

  state.proxies = entries;
  state.index = 0;
  state.requestsSinceRotate = 0;
  state.credentials.clear();
  for (const e of entries) {
    if (e.username) state.credentials.set(`${e.host}:${e.port}`, { username: e.username, password: e.password });
  }
  installAuthListener();
  await setPac(entries[0]);
  state.applied = true;
  return { applied: true, label: entries[0].label, count: entries.length };
}

async function setPac(entry) {
  await chrome.proxy.settings.set({
    value: { mode: 'pac_script', pacScript: { data: buildPac(entry), mandatory: false } },
    scope: 'regular',
  });
}

/**
 * Called once per request; rotates to the next proxy when the interval elapses.
 * @returns {Promise<?string>} label of the newly active proxy, if rotated
 */
export async function noteRequestAndMaybeRotate(rotateEveryRequests) {
  if (!state.applied || state.proxies.length < 2) return null;
  const every = Math.max(1, Number(rotateEveryRequests) || 5);
  state.requestsSinceRotate += 1;
  if (state.requestsSinceRotate < every) return null;
  state.requestsSinceRotate = 0;
  state.index = (state.index + 1) % state.proxies.length;
  const entry = state.proxies[state.index];
  await setPac(entry);
  return entry.label;
}

export async function clearProxyConfiguration() {
  removeAuthListener();
  state.applied = false;
  state.proxies = [];
  state.credentials.clear();
  if (!chrome.proxy) return;
  try {
    await chrome.proxy.settings.clear({ scope: 'regular' });
  } catch (err) {
    console.warn('[etsy-scraper] failed clearing proxy settings', err);
  }
}

export function proxyStatus() {
  return {
    applied: state.applied,
    count: state.proxies.length,
    active: state.applied ? state.proxies[state.index].label : null,
  };
}
