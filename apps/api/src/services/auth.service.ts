import {
  PaperWidthSchema,
  RoleSchema,
  type AuthTokens,
  type LoginResponse,
  type PaperWidth,
  type Role,
} from '@loyalty-pro/shared-types';
import { unauthenticated } from '../lib/errors';
import {
  ACCESS_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
} from '../lib/jwt';
import { verifyPassword } from '../lib/password';
import { demoSeedHasPublishedAccount } from '../lib/demo-guard';
import {
  clearFailedAttempts,
  isLocked,
  lockLimitsFor,
  lockedMessage,
  recordFailedAttempt,
} from './lockout.service';
import { prisma } from '../lib/prisma';

/**
 * Authentication (CLAUDE.md §7.1).
 *
 * Refresh tokens **rotate**: every use issues a new one and revokes the old,
 * chained through `replacedById`. That chain is what makes theft detectable —
 * see `detectReuse` below.
 */

/**
 * One deliberately vague message for every login failure.
 *
 * Vague on purpose in production: distinguishing "no such user" from "wrong password"
 * turns login into a username oracle for anyone on the shop's network.
 */
const LOGIN_FAILED = 'اسم المستخدم أو كلمة المرور غير صحيحة';

/**
 * The demo's version of the same failure, when the cause is the database.
 *
 * ── The message that was true three different ways ───────────────────────────
 *
 * «اسم المستخدم أو كلمة المرور غير صحيحة» was the visible symptom of at least three
 * causes: genuinely wrong credentials, a stale or foreign database, and a backend
 * attached to a data directory nobody was looking at. A merchant reading it re-types
 * the credentials — which is the correct response to one cause and useless for the
 * other two — and concludes the software is broken when they fail again.
 *
 * In a demo build there is nothing to protect: the accounts are printed in the
 * merchant's own instructions, so naming the real cause leaks nothing. In production
 * the vague message stays exactly as it was, because there the account list is not
 * public and the oracle is real.
 */
const DEMO_WRONG_DATABASE =
  'قاعدة البيانات التجريبية على هذا الجهاز ليست النسخة التي وصلت مع البرنامج، ' +
  'ولا تحتوي على الحساب المذكور في تعليمات التشغيل. ' +
  'أغلق البرنامج، احذف مجلد LoyaltyPro من %LOCALAPPDATA%، ثم افتح البرنامج من جديد.';

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

/**
 * The same discipline for the paper width: parse, never cast.
 *
 * SQLite holds it as a plain integer and would accept 72 as happily as 80. A width
 * nothing has been measured at must not reach the print stylesheet, so an unexpected
 * value falls back to 80 — the default, the width v3 hardcoded, and the one every
 * existing layout was checked against. Falling back rather than throwing because a bad
 * number here should not stop a shop logging in; it should print on the roll everyone
 * already knows works.
 */
function parsePaperWidth(value: number): PaperWidth {
  const parsed = PaperWidthSchema.safeParse(value);
  return parsed.success ? parsed.data : 80;
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

/**
 * Finds the account to authenticate, tolerating the case the merchant typed.
 *
 * ── Why case-insensitively, and why that is safe ─────────────────────────────
 *
 * `username` is an internal handle — `owner`, `manager`, `station`, `agent` — not an
 * email and not PII. Matching it case-sensitively buys nothing and costs a login: a
 * shop owner who types `Owner`, or whose keyboard capitalises the first letter of a
 * field, gets «اسم المستخدم أو كلمة المرور غير صحيحة» for credentials that are
 * correct in every way he can see. Measured against the shipped demo seed: `owner`
 * authenticates, `Owner` and `OWNER` are rejected — same password, same database.
 *
 * The exact match is tried first, so an installation that deliberately holds both
 * `Sara` and `sara` keeps whatever behaviour it has today. The fallback only runs when
 * nothing matched exactly, and only accepts an unambiguous single row — two accounts
 * differing only in case are not silently collapsed into one.
 *
 * The password remains byte-exact. Trimming or folding a password would be a real
 * weakening; this is only about which row to compare it against.
 */
async function findAccount(username: string) {
  const include = {
    branch: { select: { code: true } },
    merchant: { select: { name: true, paperWidth: true } },
  } as const;

  const exact = await prisma.user.findFirst({ where: { username }, include });
  if (exact) return exact;

  // SQLite's `=` is case-sensitive and Prisma's `mode: 'insensitive'` is unsupported on
  // this provider, so the fold is done in SQL. Parameterised — §7.7 forbids building
  // this string by interpolation.
  const matches = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "user" WHERE username = ${username} COLLATE NOCASE
  `;
  if (matches.length !== 1) return null;

  return prisma.user.findUnique({ where: { id: matches[0]!.id }, include });
}

export async function login(username: string, password: string): Promise<LoginResponse> {
  const user = await findAccount(username);

  // Verify a dummy hash when the user does not exist, so a missing username and a
  // wrong password take the same time. Skipping the hash on the miss turns login
  // into a username oracle measurable over the network.
  if (!user) {
    await verifyPassword(
      '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2E$0000000000000000000000000000000000000000000',
      password,
    );
    // A demo whose database has lost the published account is not a credentials
    // problem, and saying so costs nothing here — see `DEMO_WRONG_DATABASE`.
    if (!(await demoSeedHasPublishedAccount())) {
      throw unauthenticated(DEMO_WRONG_DATABASE);
    }
    throw unauthenticated(LOGIN_FAILED);
  }

  /*
    The lock is checked BEFORE the password, which breaks this function's own rule that
    nothing is revealed until the password is right. Deliberately — see the note in
    `lockout.service.ts`. Checked afterwards, a lock stops no guessing at all: the
    attacker carries on, and the only thing that changes is what happens on the guess
    that was already going to work. What it costs is that a guessed username can be
    known to exist and be locked, which against `owner`, `manager` and `station` on a
    shop's own network buys an attacker almost nothing — and buys a cashier who is
    typing the right password an explanation instead of a lie.
  */
  const now = new Date();
  if (isLocked(user, now)) throw unauthenticated(lockedMessage(user, now));

  const valid = await verifyPassword(user.passwordHash, password);
  if (!valid) {
    const limits = await lockLimitsFor(user.merchantId);
    const next = await recordFailedAttempt(user, limits, prisma, now);
    // The attempt that trips the lock says so, rather than making the person discover it
    // on the next try. It is the same information either way, one attempt earlier.
    if (next.justLocked) throw unauthenticated(lockedMessage(next, now));
    throw unauthenticated(LOGIN_FAILED);
  }

  // Checked after the password so a deactivated account cannot be distinguished
  // from a wrong password by anyone who does not already know the password.
  if (!user.isActive) throw unauthenticated('هذا الحساب غير مفعّل');

  await clearFailedAttempts(user);

  const tokens = await issueTokens(user);

  return {
    user: {
      id: user.id,
      name: user.name,
      username: user.username,
      role: parseRole(user.role),
      merchantId: user.merchantId,
      merchantName: user.merchant.name,
      paperWidth: parsePaperWidth(user.merchant.paperWidth),
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
      user: {
        include: { branch: { select: { code: true } }, merchant: { select: { name: true, paperWidth: true } } },
      },
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
      merchantName: user.merchant.name,
      paperWidth: parsePaperWidth(user.merchant.paperWidth),
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
