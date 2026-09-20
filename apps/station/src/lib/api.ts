import type { ApiError, AuthUser } from '@loyalty-pro/shared-types';
import { getStoredApiUrl } from './config';

/**
 * API client for the station.
 *
 * **Where the tokens live.** The access token stays in memory. The refresh token
 * goes in `sessionStorage` — not `localStorage`, and not memory alone.
 *
 * Memory alone would log the operator out on every accidental reload, which on a
 * tablet wedged beside a till happens more than anyone expects and always at the
 * worst moment. `localStorage` would leave a long-lived credential on the device
 * after the shop closes, readable by anything else that runs in that browser.
 * `sessionStorage` survives a reload and dies with the tab, which matches how the
 * appliance is actually used: opened at the start of the day, closed at the end.
 */

const REFRESH_KEY = 'loyalty.station.refresh';

let accessToken: string | null = null;
let onUnauthenticated: (() => void) | null = null;

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export function setTokens(tokens: Tokens | null): void {
  accessToken = tokens?.accessToken ?? null;
  if (tokens) {
    window.sessionStorage.setItem(REFRESH_KEY, tokens.refreshToken);
  } else {
    window.sessionStorage.removeItem(REFRESH_KEY);
  }
}

export const getAccessToken = (): string | null => accessToken;
export const getRefreshToken = (): string | null => window.sessionStorage.getItem(REFRESH_KEY);
export const hasSession = (): boolean => Boolean(accessToken ?? getRefreshToken());

export function setUnauthenticatedHandler(handler: () => void): void {
  onUnauthenticated = handler;
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Array<{ path: string; message: string }>,
    /** The envelope's `details` — e.g. whether a refused sale is held on the manager PC. */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }

  /** True when the request never reached the server — the offline queue's cue. */
  get isNetworkFailure(): boolean {
    return this.status === 0 && this.code === 'NETWORK_ERROR';
  }

  /**
   * True when a write reached the server and was not stored (docs/legacy/CLAUDE_v3.md §12.16).
   *
   * The offline queue must NOT swallow these. A network failure is benign — the
   * operation is queued and settles later. This is the opposite: the server answered
   * and the sale is gone, and retrying against a datastore that cannot write would
   * only bury the fact.
   *
   * Any 5xx counts, not only `STORAGE_UNAVAILABLE`. The API's storage detection reads
   * driver message text and can miss a signature, so the honest failure the operator
   * sees must not depend on that classification being right — only the extra hint
   * does. Erring the other way, a bug shown as "not saved" is a true statement.
   */
  get isUnsavedWrite(): boolean {
    return this.status >= 500 || this.code === 'STORAGE_UNAVAILABLE';
  }

  /** The server named storage as the cause, so the message can say so. */
  get isStorageFailure(): boolean {
    return this.code === 'STORAGE_UNAVAILABLE';
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
    envelope?.error?.message ??
      'ردّ جهاز المدير بجواب لم يُفهم. تحقّق من النتيجة قبل إعادة العملية، وإن تكرّر ذلك فأعد تحميل هذه الصفحة وأبلغ المدير.',
    envelope?.error?.fields,
    envelope?.error?.details,
  );
}

async function attemptRefresh(base: string): Promise<AuthUser | null> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return null;

  try {
    const response = await fetch(`${base}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!response.ok) return null;

    // The refresh response already carries the user, so restoring a session after a
    // reload costs one round trip rather than two — and needs no `/auth/me`
    // endpoint whose only caller would be this line.
    const body = (await response.json()) as { user: AuthUser; tokens: Tokens };
    setTokens(body.tokens);
    return body.user;
  } catch {
    // A network failure during refresh is not an expired session. Say so by
    // failing the refresh without clearing the tokens, so going offline mid-shift
    // does not log the operator out.
    return null;
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
  const base = getStoredApiUrl();
  if (!base) throw new ApiRequestError(0, 'NOT_CONFIGURED', 'لم يتم إعداد عنوان الخادم بعد');

  let response: Response;
  try {
    response = await fetch(`${base}/api/v1${path}`, {
      ...init,
      headers: {
        // Only when there is a body to describe. Fastify parses by content-type, so
        // declaring JSON on a body-less POST hands the parser an empty string and it
        // answers 400 for a well-formed request. Every call from this app currently
        // sends a body, so this is prevention rather than a fix — the manager app hit
        // exactly this and the failure looked like a broken endpoint.
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    // Distinguished from every server response so the caller can queue the work
    // instead of showing the operator a failure they cannot act on.
    throw new ApiRequestError(0, 'NETWORK_ERROR', 'تعذّر الوصول إلى الخادم');
  }

  if (response.status === 401 && options.retry !== false) {
    if (await attemptRefresh(base)) {
      return apiFetch<T>(path, init, { retry: false });
    }
    if (getRefreshToken()) {
      // The refresh token existed and was rejected: the session is over.
      setTokens(null);
      onUnauthenticated?.();
    }
  }

  return parse<T>(response);
}

export const api = {
  get: <T>(path: string) => apiFetch<T>(path),
  post: <T>(path: string, body?: unknown) =>
    apiFetch<T>(path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
};

/** Restores a session from a surviving refresh token after a page reload. */
export async function restoreSession(): Promise<AuthUser | null> {
  const base = getStoredApiUrl();
  if (!base || !getRefreshToken()) return null;
  return attemptRefresh(base);
}
