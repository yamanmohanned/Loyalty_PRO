/**
 * Where the station's API lives.
 *
 * The URL is never hardcoded: one bundle serves every merchant, and each points at
 * their own manager machine on their own LAN.
 *
 * **The common case needs no setup at all.** In production the API serves this very
 * bundle from its own port (§12.3), so the origin the browser loaded is already the
 * answer — asking the operator to type an address they cannot know would be a
 * settings screen, which §6.4 forbids anywhere in this app. The setup screen exists
 * for the case where that guess fails: a developer on Vite's port, or a tablet
 * pointed somewhere unusual.
 */

const API_URL_KEY = 'loyalty.station.api_url';

const trimTrailingSlash = (url: string): string => url.trim().replace(/\/+$/, '');

export function getStoredApiUrl(): string | null {
  return window.localStorage.getItem(API_URL_KEY);
}

export function setApiUrl(url: string): void {
  window.localStorage.setItem(API_URL_KEY, trimTrailingSlash(url));
}

export function clearApiUrl(): void {
  window.localStorage.removeItem(API_URL_KEY);
}

export interface UrlCheck {
  ok: boolean;
  message: string;
}

/**
 * Confirms an address actually answers, and answers as Walaa, before it is saved.
 *
 * Checking at setup is the difference between the operator seeing "cannot reach the
 * server" once, here, with the address in front of them — and seeing an unexplained
 * blank screen at every shift.
 */
export async function testApiUrl(url: string): Promise<UrlCheck> {
  const base = trimTrailingSlash(url);
  if (!/^https?:\/\/.+/.test(base)) {
    return { ok: false, message: 'الرابط يجب أن يبدأ بـ http:// أو https://' };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${base}/health`, { signal: controller.signal });
    clearTimeout(timeout);

    /*
      An HTTP status is not a sentence.

      This answered «الخادم ردّ برمز 404» — "the server replied with code 404" — to a
      cashier standing at a till. A status code tells the operator nothing they can act
      on and tells them this appliance expects them to know what a 404 is; the actionable
      fact is identical to the one below, which is that whatever is at this address is
      not ولاء. The number goes to the console, where it is worth having.
    */
    if (!response.ok) {
      console.error('[station] health check refused', { base, status: response.status });
      return { ok: false, message: 'هذا العنوان لا يشير إلى خادم ولاء' };
    }

    const body = (await response.json()) as { service?: string };
    if (body.service !== 'loyalty-pro-api') {
      return { ok: false, message: 'هذا العنوان لا يشير إلى خادم ولاء' };
    }
    return { ok: true, message: 'تم الاتصال بنجاح' };
  } catch {
    return { ok: false, message: 'تعذّر الوصول إلى الخادم — تحقّق من العنوان والشبكة' };
  }
}

/**
 * Resolves the API address: a saved one, else the origin that served this page.
 *
 * Returns null only when neither works, which is when the setup screen is genuinely
 * needed.
 */
export async function resolveApiUrl(): Promise<string | null> {
  const stored = getStoredApiUrl();
  if (stored) return stored;

  const origin = trimTrailingSlash(window.location.origin);
  if (origin.startsWith('http')) {
    const check = await testApiUrl(origin);
    if (check.ok) {
      // Remember it, so a later API restart on a different port surfaces as a clear
      // connection error rather than silently re-guessing a stale origin.
      setApiUrl(origin);
      return origin;
    }
  }

  return null;
}
