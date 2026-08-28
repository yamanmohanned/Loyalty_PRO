import { RoleSchema, type AuthTokens, type LoginResponse, type Role } from '@walaa/shared-types';
import { unauthenticated } from '../lib/errors';
import {
  ACCESS_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
} from '../lib/jwt';
import { verifyPassword } from '../lib/password';
import { prisma } from '../lib/prisma';

/**
 * Authentication (CLAUDE.md §7.1).
 *
 * Refresh tokens **rotate**: every use issues a new one and revokes the old,
 * chained through `replacedById`. That chain is what makes theft detectable —
 * see `detectReuse` below.
 */

/** One deliberately vague message for every login failure. */
const LOGIN_FAILED = 'اسم المستخدم أو كلمة المرور غير صحيحة';

/**
 * SQLite stores `role` as a plain string — the database will accept anything.
 * Parse rather than cast, so a corrupted row fails loudly here instead of
 * silently granting whatever permissions a typo happens to miss.
 */
function parseRole(value: string): Role {
  const parsed = RoleSchema.safeParse(value);
  if (!parsed.success) {
    throw unauthenticated('دور المستخدم غير صالح');
  }
  return parsed.data;
}

async function issueTokens(user: {
  id: string;
  merchantId: string;
  branchId: string | null;
  role: string;
}): Promise<AuthTokens> {
  const accessToken = await signAccessToken({
    sub: user.id,
    merchantId: user.merchantId,
    branchId: user.branchId,
    role: parseRole(user.role),
  });

  const { token, hash } = generateRefreshToken();
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000),
    },
  });

  return { accessToken, refreshToken: token, expiresIn: ACCESS_TTL_SECONDS };
}

export async function login(username: string, password: string): Promise<LoginResponse> {
  const user = await prisma.user.findFirst({
    where: { username },
    include: { branch: { select: { code: true } } },
  });

  // Verify a dummy hash when the user does not exist, so a missing username and a
  // wrong password take the same time. Skipping the hash on the miss turns login
  // into a username oracle measurable over the network.
  if (!user) {
    await verifyPassword(
      '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2E$0000000000000000000000000000000000000000000',
      password,
    );
    throw unauthenticated(LOGIN_FAILED);
  }

  const valid = await verifyPassword(user.passwordHash, password);
  if (!valid) throw unauthenticated(LOGIN_FAILED);

  // Checked after the password so a deactivated account cannot be distinguished
  // from a wrong password by anyone who does not already know the password.
  if (!user.isActive) throw unauthenticated('هذا الحساب غير مفعّل');

  const tokens = await issueTokens(user);

  return {
    user: {
      id: user.id,
      name: user.name,
      username: user.username,
      role: parseRole(user.role),
      merchantId: user.merchantId,
      branchId: user.branchId,
      branchCode: user.branch?.code ?? null,
    },
    tokens,
  };
}

/**
 * Rotates a refresh token.
 *
 * **Reuse detection:** a token that was already rotated should never appear again.
 * If it does, either it was stolen and replayed, or the legitimate client is
 * replaying — and the two are indistinguishable from here. The safe response is to
 * revoke the entire chain, forcing a fresh login. Losing a session is a nuisance;
 * leaving a stolen token live is not.
 */
export async function refresh(presentedToken: string): Promise<LoginResponse> {
  const tokenHash = hashRefreshToken(presentedToken);

  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: {
      user: { include: { branch: { select: { code: true } } } },
    },
  });

  if (!stored) throw unauthenticated('رمز التجديد غير صالح');

  if (stored.revokedAt) {
    await revokeAllForUser(stored.userId);
    throw unauthenticated('تم استخدام رمز التجديد مسبقاً — سجّل الدخول مجدداً');
  }

  if (stored.expiresAt.getTime() <= Date.now()) {
    throw unauthenticated('انتهت صلاحية رمز التجديد — سجّل الدخول مجدداً');
  }

  const { user } = stored;
  if (!user.isActive) throw unauthenticated('هذا الحساب غير مفعّل');

  const tokens = await issueTokens(user);

  // Link the old token to its replacement so the chain stays walkable.
  const replacement = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashRefreshToken(tokens.refreshToken) },
    select: { id: true },
  });
  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: { revokedAt: new Date(), replacedById: replacement?.id ?? null },
  });

  return {
    user: {
      id: user.id,
      name: user.name,
      username: user.username,
      role: parseRole(user.role),
      merchantId: user.merchantId,
      branchId: user.branchId,
      branchCode: user.branch?.code ?? null,
    },
    tokens,
  };
}

/** Revokes every live refresh token for a user. Used on logout and on reuse detection. */
export async function revokeAllForUser(userId: string): Promise<number> {
  const result = await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

/** Revokes a single presented token. A token we do not recognise is not an error. */
export async function logout(presentedToken: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashRefreshToken(presentedToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
