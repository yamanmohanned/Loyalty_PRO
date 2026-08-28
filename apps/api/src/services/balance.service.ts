import type { Prisma, PrismaClient } from '@prisma/client';
import {
  computePeriodKey,
  type CustomerBalance,
  type DiscountRule,
  type PeriodKey,
  type PeriodType,
} from '@walaa/shared-types';
import { notFound } from '../lib/errors';
import { prisma } from '../lib/prisma';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  BALANCE DERIVATION — CLAUDE_v3.md §5.3
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * **Cumulative balance is NEVER stored as a number.** It is computed here, every
 * time, by summing `transaction` rows in the active period.
 *
 * v1 kept a `balance_snapshot` cache and treated the computed value as
 * authoritative with the cache trailing behind it. v3 removes the cache entirely
 * rather than maintain that discipline. The reasoning: a stored aggregate has no
 * way to announce that it has drifted. It simply returns a number, and the number
 * is wrong, and every downstream decision — including whether a customer gets a
 * discount at the till — is wrong with it. There is no cache to reconcile because
 * there is no cache.
 *
 * The cost is a SUM over an indexed range on every query. At one supermarket's
 * volume, against an index on `(customer_id, period_key)`, that is not a cost worth
 * trading correctness for.
 */

export interface PeriodContext {
  merchantId: string;
  timezone: string;
  periodType: PeriodType;
  periodStart: Date | null;
  periodEnd: Date | null;
}

/** The merchant's timezone and discount period, which together define the window. */
export async function getPeriodContext(merchantId: string, db: Db = prisma): Promise<PeriodContext> {
  const merchant = await db.merchant.findUnique({ where: { id: merchantId } });
  if (!merchant) throw notFound('التاجر غير موجود');

  const settings = await db.discountSettings.findUnique({ where: { merchantId } });
  if (!settings) throw notFound('لا توجد إعدادات خصم لهذا التاجر');

  return {
    merchantId,
    timezone: merchant.timezone,
    // SQLite stores these as plain strings; the shared Zod schemas are the only
    // guard, so the cast documents an assumption validated at every write boundary.
    periodType: settings.periodType as PeriodType,
    periodStart: settings.periodStart,
    periodEnd: settings.periodEnd,
  };
}

/** The period bucket an instant falls in, computed in the merchant's local time. */
export function periodKeyFor(context: PeriodContext, occurredAt: Date): PeriodKey {
  return computePeriodKey({
    periodType: context.periodType,
    occurredAt,
    timeZone: context.timezone,
    customStart: context.periodStart,
    customEnd: context.periodEnd,
  });
}

/**
 * Cumulative spend for a customer within one period, computed from transactions.
 * This is the authoritative number. Nothing else may be treated as the balance.
 *
 * Sums `amountGross` deliberately: a customer's progress toward the next threshold
 * is measured by what they spent, not by what they paid after a discount. Using the
 * net figure would let each granted discount slightly retard progress toward the
 * next tier — a quiet penalty for being a good customer.
 */
export async function computeCumulativeAmount(
  customerId: string,
  periodKey: PeriodKey,
  db: Db = prisma,
): Promise<{ cumulativeAmount: number; transactionCount: number }> {
  const result = await db.transaction.aggregate({
    where: { customerId, periodKey },
    _sum: { amountGross: true },
    _count: true,
  });

  return {
    cumulativeAmount: result._sum.amountGross ?? 0,
    transactionCount: result._count,
  };
}

/** Active discount rules for a merchant, ascending by threshold. */
export async function getActiveRules(
  merchantId: string,
  db: Db = prisma,
): Promise<Array<Pick<DiscountRule, 'thresholdAmount' | 'discountType' | 'discountRate' | 'maxDiscountValue' | 'isActive'>>> {
  const rules = await db.discountRule.findMany({
    where: { merchantId, isActive: true },
    orderBy: { thresholdAmount: 'asc' },
  });

  return rules.map((r) => ({
    thresholdAmount: r.thresholdAmount,
    discountType: r.discountType as 'PERCENTAGE' | 'FIXED_AMOUNT',
    discountRate: r.discountRate,
    maxDiscountValue: r.maxDiscountValue,
    isActive: r.isActive,
  }));
}

/**
 * Where a customer stands against the ladder: the next threshold and the gap to it.
 *
 * The gap is what the Loyalty Station shows a customer who has not yet qualified,
 * phrased as progress rather than refusal (§6.2 #3). Returns nulls once every
 * threshold is cleared, so the UI can say "all tiers reached" instead of naming an
 * impossible target.
 */
export function nextThreshold(
  rules: Array<Pick<DiscountRule, 'thresholdAmount' | 'discountType' | 'discountRate'>>,
  cumulativeAmount: number,
): { nextThresholdAmount: number | null; amountToNextThreshold: number | null; nextDiscountLabel: string | null } {
  const ascending = [...rules].sort((a, b) => a.thresholdAmount - b.thresholdAmount);
  const next = ascending.find((rule) => rule.thresholdAmount > cumulativeAmount);

  if (!next) {
    return { nextThresholdAmount: null, amountToNextThreshold: null, nextDiscountLabel: null };
  }

  return {
    nextThresholdAmount: next.thresholdAmount,
    amountToNextThreshold: next.thresholdAmount - cumulativeAmount,
    nextDiscountLabel:
      next.discountType === 'PERCENTAGE'
        ? `${next.discountRate}٪`
        : `${next.discountRate.toLocaleString('en-US')} د.ع`,
  };
}

/** A customer's full standing in the active period — derived, never stored. */
export async function getCustomerBalance(
  merchantId: string,
  customerId: string,
  at: Date = new Date(),
  db: Db = prisma,
): Promise<CustomerBalance> {
  const context = await getPeriodContext(merchantId, db);
  const periodKey = periodKeyFor(context, at);

  const [totals, rules] = await Promise.all([
    computeCumulativeAmount(customerId, periodKey, db),
    getActiveRules(merchantId, db),
  ]);

  const gap = nextThreshold(rules, totals.cumulativeAmount);

  return {
    periodKey,
    cumulativeAmount: totals.cumulativeAmount,
    transactionCount: totals.transactionCount,
    nextThresholdAmount: gap.nextThresholdAmount,
    amountToNextThreshold: gap.amountToNextThreshold,
    nextDiscountLabel: gap.nextDiscountLabel,
  };
}
