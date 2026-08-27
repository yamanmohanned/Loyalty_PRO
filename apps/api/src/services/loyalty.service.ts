import type { Coupon, Prisma, PrismaClient } from '@prisma/client';
import type { EffectiveRules, PeriodKey } from '@walaa/shared-types';
import { isUniqueViolation, prisma } from '../lib/prisma';
import { AUDIT_ACTIONS, recordAudit } from './audit.service';
import { highestCrossedTier } from './rules.service';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * The loyalty engine: cumulative balance, threshold crossing, coupon issuance.
 *
 * This module owns the two invariants the whole product rests on:
 *
 *  - **The balance is derived, never stored authoritatively.** It is always a SUM
 *    over transaction rows for the period. `balance_snapshot` is a cache that
 *    follows; if the two ever disagree, the cache is what is wrong (CLAUDE.md §4.2).
 *
 *  - **A tier fires at most once per customer per period, and a higher tier
 *    supersedes a lower one** (§13.2). Enforced by service logic AND by a database
 *    unique constraint, so concurrency cannot mint duplicates.
 */

/**
 * Cumulative spend for a customer within one period, computed from transactions.
 * This is the authoritative number — nothing else may be treated as the balance.
 */
export async function computeCumulativeAmount(
  customerId: string,
  periodKey: PeriodKey,
  db: Db = prisma,
): Promise<{ cumulativeAmount: number; transactionCount: number }> {
  const result = await db.transaction.aggregate({
    where: { customerId, periodKey },
    _sum: { amount: true },
    _count: true,
  });
  return {
    cumulativeAmount: result._sum.amount ?? 0,
    transactionCount: result._count,
  };
}

/** Refreshes the derived cache so the dashboard need not aggregate on every render. */
export async function refreshBalanceSnapshot(
  params: { merchantId: string; customerId: string; periodKey: PeriodKey },
  db: Db = prisma,
): Promise<{ cumulativeAmount: number; transactionCount: number }> {
  const totals = await computeCumulativeAmount(params.customerId, params.periodKey, db);

  await db.balanceSnapshot.upsert({
    where: { customerId_periodKey: { customerId: params.customerId, periodKey: params.periodKey } },
    update: {
      cumulativeAmount: totals.cumulativeAmount,
      transactionCount: totals.transactionCount,
    },
    create: {
      merchantId: params.merchantId,
      customerId: params.customerId,
      periodKey: params.periodKey,
      cumulativeAmount: totals.cumulativeAmount,
      transactionCount: totals.transactionCount,
    },
  });

  return totals;
}

export interface ThresholdOutcome {
  /** The coupon this crossing earned, or null when no new tier was reached. */
  issuedCoupon: Coupon | null;
  /** A lower-tier coupon this one replaced, if any. */
  supersededCoupon: Coupon | null;
}

export interface ThresholdCheckParams {
  merchantId: string;
  customerId: string;
  periodKey: PeriodKey;
  cumulativeAmount: number;
  rules: EffectiveRules;
  /** The transaction whose commit crossed the threshold. */
  sourceTransactionId: string | null;
  /** Who performed the action, for the audit trail. */
  actorUserId: string | null;
  /** Fixed so issuedAt and expiresAt are consistent within one link. */
  now?: Date;
}

/**
 * Runs the threshold check after a transaction commits and issues a coupon if a
 * new tier was reached.
 *
 * Ordering note: this must run with the linking transaction's balance already
 * visible, which is why the caller passes the recomputed `cumulativeAmount` rather
 * than letting this function read a possibly-stale one.
 */
export async function runThresholdCheck(
  params: ThresholdCheckParams,
  db: Db = prisma,
): Promise<ThresholdOutcome> {
  const now = params.now ?? new Date();
  const tier = highestCrossedTier(params.rules, params.cumulativeAmount);

  // The ordinary case: this purchase earned nothing. Most links land here.
  if (!tier) return { issuedCoupon: null, supersededCoupon: null };

  // Already issued for this tier in this period? Then nothing new was crossed —
  // the customer simply spent more on top of a tier they had already reached.
  const existing = await db.coupon.findUnique({
    where: {
      customerId_periodKey_sourceThresholdAmount: {
        customerId: params.customerId,
        periodKey: params.periodKey,
        sourceThresholdAmount: tier.thresholdAmount,
      },
    },
  });
  if (existing) return { issuedCoupon: null, supersededCoupon: null };

  const expiresAt = new Date(now.getTime() + tier.couponValidityDays * 86_400_000);

  let issuedCoupon: Coupon;
  try {
    issuedCoupon = await db.coupon.create({
      data: {
        merchantId: params.merchantId,
        customerId: params.customerId,
        discountPct: tier.discountPct,
        sourceThresholdAmount: tier.thresholdAmount,
        periodKey: params.periodKey,
        sourceTransactionId: params.sourceTransactionId,
        issuedAt: now,
        expiresAt,
        status: 'ACTIVE',
      },
    });
  } catch (error) {
    // Two concurrent links both crossed the same threshold. The unique constraint
    // refused the second, which is exactly its job — this is a success, not a fault.
    if (isUniqueViolation(error)) return { issuedCoupon: null, supersededCoupon: null };
    throw error;
  }

  await recordAudit(
    {
      merchantId: params.merchantId,
      actorUserId: params.actorUserId,
      action: AUDIT_ACTIONS.COUPON_ISSUED,
      entityType: 'coupon',
      entityId: issuedCoupon.id,
      after: {
        discountPct: issuedCoupon.discountPct,
        sourceThresholdAmount: issuedCoupon.sourceThresholdAmount,
        periodKey: issuedCoupon.periodKey,
        cumulativeAmount: params.cumulativeAmount,
      },
    },
    db,
  );

  const supersededCoupon = await supersedeLowerCoupons(
    {
      customerId: params.customerId,
      periodKey: params.periodKey,
      merchantId: params.merchantId,
      keepCouponId: issuedCoupon.id,
      belowThreshold: tier.thresholdAmount,
      actorUserId: params.actorUserId,
    },
    db,
  );

  return { issuedCoupon, supersededCoupon };
}

/**
 * Retires ACTIVE coupons from lower tiers **in the same period**, so a customer
 * holds one earned coupon rather than a stack (§13.2).
 *
 * Scoped to the period deliberately. A still-valid coupon earned last month was
 * earned by different spending, and confiscating it because this month's spending
 * crossed a threshold would read to the customer as the shop taking back something
 * it already gave. Superseding is about not paying twice for the same spend.
 *
 * A USED coupon is never touched — that discount has already been applied at the
 * register and the row is now history.
 */
async function supersedeLowerCoupons(
  params: {
    merchantId: string;
    customerId: string;
    periodKey: PeriodKey;
    keepCouponId: string;
    belowThreshold: number;
    actorUserId: string | null;
  },
  db: Db,
): Promise<Coupon | null> {
  const stale = await db.coupon.findMany({
    where: {
      customerId: params.customerId,
      periodKey: params.periodKey,
      status: 'ACTIVE',
      id: { not: params.keepCouponId },
      sourceThresholdAmount: { lt: params.belowThreshold },
    },
    orderBy: { sourceThresholdAmount: 'desc' },
  });

  if (stale.length === 0) return null;

  for (const coupon of stale) {
    await db.coupon.update({
      where: { id: coupon.id },
      data: { status: 'SUPERSEDED' },
    });
    await recordAudit(
      {
        merchantId: params.merchantId,
        actorUserId: params.actorUserId,
        action: AUDIT_ACTIONS.COUPON_SUPERSEDED,
        entityType: 'coupon',
        entityId: coupon.id,
        before: { status: 'ACTIVE', discountPct: coupon.discountPct },
        after: { status: 'SUPERSEDED', replacedBy: params.keepCouponId },
      },
      db,
    );
  }

  // The highest-value coupon that was retired — what the UI reports as replaced.
  return stale[0] ?? null;
}
