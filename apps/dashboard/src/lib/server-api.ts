import 'server-only';
import { getAccessToken, getRefreshToken, setSession, type SessionUser } from './session';

/**
 * Server-side calls to the loyalty API.
 *
 * The browser never reaches the API directly — everything goes through this app,
 * which attaches the httpOnly access token. That is what lets the token stay out of
 * client JavaScript entirely.
 */

export const API_URL = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
export const API_BASE = `${API_URL}/api/v1`;

export interface ApiResult<T = unknown> {
  status: number;
  data: T | null;
  /** The shared error envelope, when the API returned one. */
  error: { code: string; message: string; fields?: Array<{ path: string; message: string }> } | null;
}

async function parse<T>(response: Response): Promise<ApiResult<T>> {
  const text = await response.text();
  if (!text) return { status: response.status, data: null, error: null };

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return {
      status: response.status,
      data: null,
      error: { code: 'INTERNAL_ERROR', message: 'استجابة غير صالحة من الخادم' },
    };
  }

  if (response.ok) return { status: response.status, data: body as T, error: null };

  const envelope = body as { error?: { code: string; message: string } };
  return {
    status: response.status,
    data: null,
    error: envelope.error ?? { code: 'INTERNAL_ERROR', message: 'حدث خطأ غير متوقع' },
  };
}

/**
 * Calls the API with the current access token, transparently refreshing once on a
 * 401. The retry is deliberately single: a refresh that itself fails means the
 * session is genuinely gone, and looping would just delay the redirect to login.
 */
export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
  options: { retryOnUnauthorized?: boolean } = {},
): Promise<ApiResult<T>> {
  const token = await getAccessToken();

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
    cache: 'no-store',
  });

  if (response.status !== 401 || options.retryOnUnauthorized === false) {
    return parse<T>(response);
  }

  const refreshed = await tryRefresh();
  if (!refreshed) return parse<T>(response);

  return apiFetch<T>(path, init, { retryOnUnauthorized: false });
}

/** Rotates the refresh token and re-seats the session cookies. */
export async function tryRefresh(): Promise<boolean> {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) return false;

  const response = await fetch(`${API_BASE}/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
    cache: 'no-store',
  });

  if (!response.ok) return false;

  const body = (await response.json()) as {
    user: SessionUser;
    tokens: { accessToken: string; refreshToken: string; expiresIn: number };
  };

  await setSession({
    accessToken: body.tokens.accessToken,
    refreshToken: body.tokens.refreshToken,
    expiresIn: body.tokens.expiresIn,
    user: body.user,
  });

  return true;
}
