import { NextResponse } from 'next/server';
import { z } from 'zod';
import { DASHBOARD_ROLES } from '@walaa/shared-types';
import { API_BASE } from '@/lib/server-api';
import { setSession, type SessionUser } from '@/lib/session';

/**
 * Login. Exchanges credentials for a session, then stores the tokens in httpOnly
 * cookies — the response body carries no token at all, so nothing reaches client JS.
 */

const BodySchema = z.object({ username: z.string().min(1), password: z.string().min(1) }).strict();

export async function POST(request: Request): Promise<NextResponse> {
  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_FAILED', message: 'البيانات غير مكتملة' } },
      { status: 400 },
    );
  }

  const response = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(parsed.data),
    cache: 'no-store',
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    return NextResponse.json(body ?? { error: { code: 'INTERNAL_ERROR', message: 'خطأ' } }, {
      status: response.status,
    });
  }

  const { user, tokens } = body as {
    user: SessionUser;
    tokens: { accessToken: string; refreshToken: string; expiresIn: number };
  };

  // The API lets assistants authenticate — they use the mobile app. The dashboard
  // is manager territory, so refuse the session here rather than seat a useless one.
  if (!DASHBOARD_ROLES.includes(user.role)) {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: 'هذا الحساب لا يملك صلاحية الدخول للوحة التحكم' } },
      { status: 403 },
    );
  }

  await setSession({ ...tokens, user });
  return NextResponse.json({ user });
}
