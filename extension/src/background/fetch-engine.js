/**
 * Engine A — plain `fetch()` from the service worker.
 *
 * Runs inside the user's browser profile, so the request carries the real
 * Chrome UA, the real TLS fingerprint and the user's Etsy cookies. That is why
 * this is dramatically harder to fingerprint than a Python/requests client.
 */

const ACCEPT_HTML =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';

/**
 * @param {string} url
 * @param {{signal?:AbortSignal, timeoutMs?:number, acceptLanguage?:string}} [opts]
 * @returns {Promise<{ok:boolean,status:number,html:string,finalUrl:string,error:?string}>}
 */
export async function fetchHtml(url, opts = {}) {
  const { signal, timeoutMs = 45000, acceptLanguage = 'en-US,en;q=0.9' } = opts;

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      // Cookies make Etsy serve the normal page instead of a challenge.
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        // Note: User-Agent / Referer are forbidden headers for fetch(); Chrome
        // supplies its genuine values automatically, which is what we want.
        Accept: ACCEPT_HTML,
        'Accept-Language': acceptLanguage,
        'Upgrade-Insecure-Requests': '1',
      },
    });

    const html = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      html,
      finalUrl: response.url || url,
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (err) {
    const aborted = controller.signal.aborted;
    const byUser = Boolean(signal && signal.aborted);
    return {
      ok: false,
      status: 0,
      html: '',
      finalUrl: url,
      error: aborted && !byUser ? `timeout after ${timeoutMs}ms` : String((err && err.message) || err),
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** Search pages and listing pages are the same GET; kept for readability. */
export const fetchSearchPage = fetchHtml;
export const fetchListingPage = fetchHtml;
