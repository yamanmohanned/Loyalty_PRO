import type { ApiError } from '@walaa/shared-types';
import { getApiUrl } from './config';

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
  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : null;

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
  if (!base) throw new ApiRequestError(0, 'NOT_CONFIGURED', 'لم يتم إعداد عنوان الخادم بعد');

  const response = await fetch(`${base}/api/v1${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(init.headers ?? {}),
    },
  });

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
