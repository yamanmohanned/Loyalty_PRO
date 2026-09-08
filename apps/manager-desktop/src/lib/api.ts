import type { ApiError } from '@walaa/shared-types';
import { getApiUrl } from './config';
import { locale } from './locale';

/**
 * API client.
 *
 * Tokens live in memory for the process lifetime plus the OS-backed Tauri store
 * for the refresh token. They are deliberately NOT in localStorage: a desktop app
 * still runs a WebView, and localStorage is readable by any script that gets in.
 */

let accessToken: string | null = null;
let refreshToken: string | null = null;
let onUnauthenticated: (() => void) | null = null;

export function setTokens(tokens: { accessToken: string; refreshToken: string } | null): void {
  accessToken = tokens?.accessToken ?? null;
  refreshToken = tokens?.refreshToken ?? null;
}

export function setUnauthenticatedHandler(handler: () => void): void {
  onUnauthenticated = handler;
}

export const getAccessToken = (): string | null => accessToken;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  NOTHING BUT AN ARABIC SENTENCE LEAVES THIS MODULE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Twelve call sites across the screens render `error.message` straight into a panel
 * the merchant reads. That is correct for an `ApiRequestError`, whose message is the
 * API's own Arabic envelope — and it was a leak for everything else. A dropped Wi-Fi
 * link threw a `TypeError: Failed to fetch`; a reply that was not JSON threw
 * `SyntaxError: Unexpected token`. Both were rendered verbatim, in English, to a shop
 * owner in Baghdad, on a screen that was supposed to tell him what to do next.
 *
 * The fix is at the boundary rather than at the call sites, because fixing twelve call
 * sites fixes them until somebody writes the thirteenth. Every throw out of `apiFetch`
 * is now an `ApiRequestError` carrying a sentence written for this reader; the
 * browser's own words go to the console, where they were the useful thing all along.
 *
 * `status` still carries the real HTTP status where there was one, and `0` where the
 * request never completed — which is how the login screen tells "your password is
 * wrong" apart from "the shop's network is down" without reading message text.
 */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function parse<T>(response: Response): Promise<T> {
  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    // The connection died while the body was still arriving.
    console.error('[api] response body could not be read', cause);
    throw new ApiRequestError(0, 'NETWORK', locale.common.networkError);
  }

  let body: unknown;
  try {
    body = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    /*
      Something answered on the API's address and it was not this API — a router's
      login page, a proxy's error page, a half-written response. `JSON.parse` throws a
      `SyntaxError` whose message quotes the offending HTML, and that used to be what
      the merchant saw.
    */
    console.error('[api] response was not JSON', { status: response.status, text: text.slice(0, 500) });
    throw new ApiRequestError(response.status, 'BAD_RESPONSE', locale.common.badResponse);
  }

  if (response.ok) return body as T;

  const envelope = body as ApiError | null;
  throw new ApiRequestError(
    response.status,
    envelope?.error?.code ?? 'INTERNAL_ERROR',
    envelope?.error?.message ?? 'حدث خطأ غير متوقع',
    envelope?.error?.fields,
  );
}

async function attemptRefresh(base: string): Promise<boolean> {
  if (!refreshToken) return false;

  /*
    Every failure here is the same answer — "no, the session was not renewed" — and
    the caller's next move is identical for all of them: return to the login screen.
    A throw would instead escape as whatever the browser said, from inside a call the
    screen did not make.
  */
  try {
    const response = await fetch(`${base}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!response.ok) return false;

    const body = (await response.json()) as {
      tokens: { accessToken: string; refreshToken: string };
    };
    setTokens(body.tokens);
    return true;
  } catch (cause) {
    console.error('[api] token refresh failed', cause);
    return false;
  }
}

/**
 * Performs an API call, refreshing once on a 401.
 *
 * The retry is deliberately single: a refresh that itself fails means the session
 * is genuinely gone, and looping would only delay the return to the login screen.
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
  options: { retry?: boolean } = {},
): Promise<T> {
  const base = await getApiUrl();
  /*
    Reached only if `BackendGate` was bypassed — it blocks the app on this exact
    condition — so the sentence points at the remedy rather than describing a setting
    that no longer exists as a first-run step.
  */
  if (!base) throw new ApiRequestError(0, 'NOT_CONFIGURED', locale.common.noServer);

  let response: Response;
  try {
    response = await fetch(`${base}/api/v1${path}`, {
      ...init,
      headers: {
        // Only when there is actually a body to describe.
        //
        // Fastify parses a request by its content-type, so declaring JSON on a body-less
        // POST hands the parser an empty string and it answers 400 — for a request that is
        // perfectly well formed. Found the hard way: `POST /backup/key/reveal` takes no
        // body, and the key ceremony failed with "الطلب غير صالح" while every curl call to
        // the same endpoint worked, because curl sends no content-type without `-d`.
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch (cause) {
    /*
      The request never completed: the service is down, the LAN cable is out, the
      manager PC is asleep, or a firewall dropped it. `fetch` rejects with a
      `TypeError: Failed to fetch` — six English words that every screen in this app
      was rendering into an Arabic panel.
    */
    console.error('[api] request failed', { path, cause });
    throw new ApiRequestError(0, 'NETWORK', locale.common.networkError);
  }

  if (response.status === 401 && options.retry !== false) {
    if (await attemptRefresh(base)) {
      return apiFetch<T>(path, init, { retry: false });
    }
    setTokens(null);
    onUnauthenticated?.();
  }

  return parse<T>(response);
}

export const api = {
  get: <T>(path: string) => apiFetch<T>(path),
  post: <T>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) }),
  delete: <T>(path: string) => apiFetch<T>(path, { method: 'DELETE' }),
};
