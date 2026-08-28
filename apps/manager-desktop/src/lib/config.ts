import { load, type Store } from '@tauri-apps/plugin-store';

/**
 * First-run configuration (CLAUDE_v2.md §9).
 *
 * The API server URL is **never hardcoded** (§14). It lives in the Tauri store, in
 * the OS app-data directory, because the same installer serves every merchant and
 * each points at their own manager machine on their own LAN.
 */

const STORE_FILE = 'app_config.json';
const API_URL_KEY = 'api_url';

let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
  storePromise ??= load(STORE_FILE, { autoSave: true });
  return storePromise;
}

/** True when running inside Tauri rather than a plain browser dev server. */
export const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export async function getApiUrl(): Promise<string | null> {
  // Outside Tauri (browser dev), fall back to localStorage so the app is still
  // developable without launching the desktop shell.
  if (!isTauri()) return window.localStorage.getItem(API_URL_KEY);

  const store = await getStore();
  return (await store.get<string>(API_URL_KEY)) ?? null;
}

export async function setApiUrl(url: string): Promise<void> {
  const normalized = url.trim().replace(/\/+$/, '');
  if (!isTauri()) {
    window.localStorage.setItem(API_URL_KEY, normalized);
    return;
  }
  const store = await getStore();
  await store.set(API_URL_KEY, normalized);
  await store.save();
}

export async function clearApiUrl(): Promise<void> {
  if (!isTauri()) {
    window.localStorage.removeItem(API_URL_KEY);
    return;
  }
  const store = await getStore();
  await store.delete(API_URL_KEY);
  await store.save();
}

/**
 * Confirms a URL actually answers before it is saved (§9.2).
 *
 * Checking reachability at setup is the difference between a merchant seeing
 * "cannot reach the server" once, here, and seeing an unexplained blank dashboard
 * every day after.
 */
export async function testApiUrl(url: string): Promise<{ ok: boolean; message: string }> {
  const base = url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/.+/.test(base)) {
    return { ok: false, message: 'الرابط يجب أن يبدأ بـ http:// أو https://' };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${base}/health`, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) return { ok: false, message: `الخادم ردّ برمز ${response.status}` };

    const body = (await response.json()) as { service?: string };
    if (body.service !== 'walaa-api') {
      return { ok: false, message: 'هذا العنوان لا يشير إلى خادم ولاء' };
    }
    return { ok: true, message: 'تم الاتصال بنجاح' };
  } catch {
    return { ok: false, message: 'تعذّر الوصول إلى الخادم — تحقّق من العنوان والشبكة' };
  }
}
