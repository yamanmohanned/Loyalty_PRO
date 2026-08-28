import 'server-only';
import { cookies } from 'next/headers';

/**
 * Server-side session handling.
 *
 * Tokens live in **httpOnly cookies**, never in localStorage and never in a
 * variable client JavaScript can read. The dashboard renders untrusted-ish content
 * (customer names, branch names) and one XSS bug in a React dependency would
 * otherwise hand an attacker a working session. httpOnly means the token is not
 * reachable from script at all.
 *
 * The browser therefore never talks to the API directly — it calls this app's own
 * route handlers, which attach the token server-side. See `app/api/proxy`.
 */

const ACCESS_COOKIE = 'walaa_at';
const REFRESH_COOKIE = 'walaa_rt';

export interface SessionUser {
  id: string;
  name: string;
  username: string;
  role: 'OWNER' | 'MANAGER' | 'ASSISTANT';
  merchantId: string;
  branchId: string | null;
  branchCode: string | null;
}

const USER_COOKIE = 'walaa_user';

/** Cookie flags shared by every session cookie. */
function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    // Secure in production; a plain-HTTP localhost dev server could not read it otherwise.
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
  };
}

export async function setSession(params: {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: SessionUser;
}): Promise<void> {
  const jar = await cookies();
  jar.set(ACCESS_COOKIE, params.accessToken, cookieOptions(params.expiresIn));
  jar.set(REFRESH_COOKIE, params.refreshToken, cookieOptions(60 * 60 * 24 * 30));
  // Display-only identity (name, role) so the shell can render without a round trip.
  // Not httpOnly — it carries no capability, and nothing trusts it for authorisation.
  jar.set(USER_COOKIE, JSON.stringify(params.user), {
    ...cookieOptions(60 * 60 * 24 * 30),
    httpOnly: false,
  });
}

export async function clearSession(): Promise<void> {
  const jar = await cookies();
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, USER_COOKIE]) {
    jar.set(name, '', { ...cookieOptions(0), httpOnly: name !== USER_COOKIE });
  }
}

export async function getAccessToken(): Promise<string | null> {
  return (await cookies()).get(ACCESS_COOKIE)?.value ?? null;
}

export async function getRefreshToken(): Promise<string | null> {
  return (await cookies()).get(REFRESH_COOKIE)?.value ?? null;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const raw = (await cookies()).get(USER_COOKIE)?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}

export { ACCESS_COOKIE, REFRESH_COOKIE, USER_COOKIE };
