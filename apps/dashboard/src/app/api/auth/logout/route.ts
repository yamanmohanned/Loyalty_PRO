import { NextResponse } from 'next/server';
import { API_BASE } from '@/lib/server-api';
import { clearSession, getRefreshToken } from '@/lib/session';

/** Revokes the refresh token server-side, then clears the cookies. */
export async function POST(): Promise<NextResponse> {
  const refreshToken = await getRefreshToken();

  if (refreshToken) {
    // Best effort: the cookies are cleared regardless, so a failure here cannot
    // leave the user apparently signed in.
    await fetch(`${API_BASE}/auth/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      cache: 'no-store',
    }).catch(() => undefined);
  }

  await clearSession();
  return NextResponse.json({ ok: true });
}
