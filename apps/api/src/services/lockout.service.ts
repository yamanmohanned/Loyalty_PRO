import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultClient } from '../lib/prisma';
import { AUDIT_ACTIONS, recordAudit } from './audit.service';
import { effectiveSettings } from './settings.service';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  TEMPORARY ACCOUNT LOCKOUT — AND WHY IT IS ALWAYS TEMPORARY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PRD FND-01: «قفل مؤقت بعد محاولات خاطئة», with the attempt count and the lock
 * duration set by the merchant. Those two values come from the settings engine
 * (§13.16), which is what makes them settings rather than constants somebody has to
 * find in the source.
 *
 * ── The lock is a liability as well as a defence ─────────────────────────────
 *
 * Every till account in this product has a username a stranger can guess — they are
 * `owner`, `manager` and `station` — so anybody on the shop's network can lock the
 * till out of its own register by failing five times. On a Thursday evening with a
 * queue, that is a worse day for the merchant than the attack the lock prevents.
 *
 * Three things keep that bounded, and each is deliberate:
 *
 *   1. **It expires by itself.** Five minutes by default, and the setting's ceiling is
 *      four hours rather than "never". §13.10 spends an entire subsystem making sure a
 *      paying shop is never locked out by its own software; a lock with no end would
 *      walk straight back into that.
 *   2. **A manager can lift it immediately** (`clearLock`), so the remedy is someone
 *      already standing in the shop rather than a support call.
 *   3. **Hammering a locked account does not extend the lock.** An attacker who keeps
 *      trying would otherwise hold the till closed indefinitely — the lock would become
 *      the denial of service rather than the protection against one.
 *
 * ── Why the check runs BEFORE the password is verified ───────────────────────
 *
 * `login` deliberately hides whether an account exists: an unknown username still pays
 * for an Argon2 verification so the timing matches, and `isActive` is checked *after*
 * the password so a deactivated account cannot be told from a wrong one.
 *
 * This check breaks that pattern, knowingly. Checked after the password, a lock stops
 * nothing — the attacker keeps guessing, and the only thing the lock changes is what
 * happens on the guess that was already going to succeed. A lock that does not stop
 * guessing is decoration.
 *
 * What it costs is narrow: someone who guesses a username can learn that it exists and
 * is currently locked. Against three usernames every employee already knows, on a LAN
 * inside one shop, that is worth very little — and the alternative is a cashier staring
 * at «اسم المستخدم أو كلمة المرور غير صحيحة» while typing the password they know is
 * right, concluding the till is broken, and calling somebody. The message has to say
 * what is actually happening.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export interface LockState {
  readonly failedAttempts: number;
  readonly lockedUntil: Date | null;
}

export interface LockLimits {
  readonly maxAttempts: number;
  readonly lockMinutes: number;
}

/** Reads the merchant's configured limits, falling back to the registry defaults. */
export async function lockLimitsFor(merchantId: string, db: Db = defaultClient): Promise<LockLimits> {
  const settings = await effectiveSettings(merchantId, null, db);
  return {
    maxAttempts: settings['security.login_attempts']?.value as number,
    lockMinutes: settings['security.lockout_minutes']?.value as number,
  };
}

export function isLocked(state: LockState, now: Date = new Date()): boolean {
  return state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime();
}

/** Whole minutes remaining, rounded up — nobody is told to wait "0 minutes". */
export function minutesRemaining(state: LockState, now: Date = new Date()): number {
  if (!state.lockedUntil) return 0;
  return Math.max(1, Math.ceil((state.lockedUntil.getTime() - now.getTime()) / 60_000));
}

export interface NextLockState extends LockState {
  /** True only on the transition, so the audit trail records the lock once. */
  readonly justLocked: boolean;
}

/**
 * The state after one failed attempt. Pure, so the rules are testable without a login.
 *
 * A lapsed lock resets the count rather than leaving it at the ceiling. Otherwise the
 * first mistyped password after a lock expired would re-lock instantly, and an employee
 * who waited out five minutes would be told to wait another five for one typo.
 */
export function afterFailedAttempt(
  state: LockState,
  limits: LockLimits,
  now: Date = new Date(),
): NextLockState {
  // Already locked: refuse, but change nothing. See point 3 above.
  if (isLocked(state, now)) {
    return { failedAttempts: state.failedAttempts, lockedUntil: state.lockedUntil, justLocked: false };
  }

  const lapsed = state.lockedUntil !== null;
  const failedAttempts = (lapsed ? 0 : state.failedAttempts) + 1;

  if (failedAttempts >= limits.maxAttempts) {
    return {
      failedAttempts,
      lockedUntil: new Date(now.getTime() + limits.lockMinutes * 60_000),
      justLocked: true,
    };
  }

  return { failedAttempts, lockedUntil: null, justLocked: false };
}

/** What a locked-out person is told. Names the wait, because "try again later" does not. */
export function lockedMessage(state: LockState, now: Date = new Date()): string {
  const minutes = minutesRemaining(state, now);
  return (
    `هذا الحساب مقفل مؤقتاً بعد عدة محاولات دخول خاطئة. حاول بعد ${minutes} دقيقة، ` +
    'أو اطلب من المدير فتحه الآن.'
  );
}

/**
 * Records a failed attempt and locks the account when the count is reached.
 *
 * The audit row is written only on the transition. A row per failed password would bury
 * the lock itself under the attempts that led to it, and the question the trail gets
 * asked is «why could the till not sign in on Thursday», which one row answers.
 */
export async function recordFailedAttempt(
  user: { id: string; merchantId: string; failedAttempts: number; lockedUntil: Date | null },
  limits: LockLimits,
  db: Db = defaultClient,
  now: Date = new Date(),
): Promise<NextLockState> {
  const next = afterFailedAttempt(user, limits, now);

  await db.user.update({
    where: { id: user.id },
    data: { failedAttempts: next.failedAttempts, lockedUntil: next.lockedUntil },
  });

  if (next.justLocked) {
    await recordAudit(
      {
        merchantId: user.merchantId,
        actorUserId: null,
        action: AUDIT_ACTIONS.STAFF_LOCKED,
        entityType: 'user',
        entityId: user.id,
        before: { failedAttempts: user.failedAttempts },
        after: { failedAttempts: next.failedAttempts, lockedUntil: next.lockedUntil, limits },
      },
      db,
    );
  }

  return next;
}

/**
 * Clears the counter after a successful login.
 *
 * Skips the write when there is nothing to clear, which is the overwhelmingly common
 * case: every successful login would otherwise write a row to the user table, on the
 * hot path, to set zero to zero.
 */
export async function clearFailedAttempts(
  user: { id: string; failedAttempts: number; lockedUntil: Date | null },
  db: Db = defaultClient,
): Promise<void> {
  if (user.failedAttempts === 0 && user.lockedUntil === null) return;
  await db.user.update({
    where: { id: user.id },
    data: { failedAttempts: 0, lockedUntil: null },
  });
}

/**
 * A manager lifts a lock immediately.
 *
 * The reason this exists is point 2 above: the remedy for a locked till has to be
 * somebody already in the shop. Audited with the actor, because clearing a lock is an
 * act on somebody else's credentials.
 */
export async function clearLock(
  merchantId: string,
  userId: string,
  actorUserId: string | null,
  db: Db = defaultClient,
): Promise<{ cleared: boolean }> {
  const user = await db.user.findFirst({
    where: { id: userId, merchantId },
    select: { id: true, failedAttempts: true, lockedUntil: true },
  });
  if (!user) return { cleared: false };

  await db.user.update({
    where: { id: user.id },
    data: { failedAttempts: 0, lockedUntil: null },
  });

  await recordAudit(
    {
      merchantId,
      actorUserId,
      action: AUDIT_ACTIONS.STAFF_UNLOCKED,
      entityType: 'user',
      entityId: user.id,
      before: { failedAttempts: user.failedAttempts, lockedUntil: user.lockedUntil },
      after: { failedAttempts: 0, lockedUntil: null },
    },
    db,
  );

  return { cleared: true };
}
