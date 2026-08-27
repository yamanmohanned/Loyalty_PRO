import type { Prisma, PrismaClient } from '@prisma/client';
import { computePeriodKey, type EffectiveRules, type PeriodKey } from '@walaa/shared-types';
import { notFound } from '../lib/errors';
import { prisma } from '../lib/prisma';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Resolving which loyalty ladder applies to a customer.
 *
 * Precedence, most specific first (CLAUDE.md §13.3):
 *
 *   1. a CUSTOMER override for this exact customer
 *   2. a CATEGORY override matching the customer's category
 *   3. the merchant's active default rule set
 *
 * An override carries a single tier, so it **replaces the whole ladder** rather
 * than shifting one rung of it. `origin` reports which layer won, which the
 * customer detail screen surfaces so a manager can see why a customer's threshold
 * differs from everyone else's.
 */

export interface MerchantPeriodContext {
  merchantId: string;
  timezone: string;
  periodType: 'WEEKLY' | 'MONTHLY' | 'CUSTOM';
  periodStart: Date | null;
  periodEnd: Date | null;
}

/** The active rule set plus the merchant timezone that its boundaries are computed in. */
export async function getPeriodContext(
  merchantId: string,
  db: Db = prisma,
): Promise<MerchantPeriodContext> {
  const merchant = await db.merchant.findUnique({ where: { id: merchantId } });
  if (!merchant) throw notFound('التاجر غير موجود');

  const ruleSet = await db.loyaltyRuleSet.findFirst({
    where: { merchantId, isActive: true },
    orderBy: { createdAt: 'desc' },
  });
  if (!ruleSet) throw notFound('لا توجد قواعد ولاء فعّالة');

  return {
    merchantId,
    timezone: merchant.timezone,
    periodType: ruleSet.periodType,
    periodStart: ruleSet.periodStart,
    periodEnd: ruleSet.periodEnd,
  };
}

/** The period bucket an instant falls in, computed in the merchant's local time. */
export function periodKeyFor(context: MerchantPeriodContext, occurredAt: Date): PeriodKey {
  return computePeriodKey({
    periodType: context.periodType,
    occurredAt,
    timeZone: context.timezone,
    customStart: context.periodStart,
    customEnd: context.periodEnd,
  });
}

/**
 * The ladder that actually governs one customer, after override resolution.
 * Tiers come back ascending by threshold, which every caller relies on.
 */
export async function resolveEffectiveRules(
  merchantId: string,
  customerId: string,
  db: Db = prisma,
): Promise<EffectiveRules> {
  const customer = await db.customer.findFirst({
    where: { id: customerId, merchantId },
    select: { id: true, category: true },
  });
  if (!customer) throw notFound('الزبون غير موجود');

  const ruleSet = await db.loyaltyRuleSet.findFirst({
    where: { merchantId, isActive: true },
    orderBy: { createdAt: 'desc' },
    include: { tiers: { orderBy: { thresholdAmount: 'asc' } } },
  });
  if (!ruleSet) throw notFound('لا توجد قواعد ولاء فعّالة');

  const base = {
    periodType: ruleSet.periodType,
    periodStart: ruleSet.periodStart,
    periodEnd: ruleSet.periodEnd,
  };

  // 1. A customer-specific override beats everything else.
  const customerOverride = await db.customerOverrideRule.findFirst({
    where: { merchantId, targetType: 'CUSTOMER', targetCustomerId: customerId },
  });
  if (customerOverride) {
    return {
      ...base,
      origin: 'CUSTOMER_OVERRIDE',
      tiers: [
        {
          thresholdAmount: customerOverride.thresholdAmount,
          discountPct: customerOverride.discountPct,
          couponValidityDays: customerOverride.couponValidityDays,
        },
      ],
    };
  }

  // 2. Otherwise a category override, if one exists for this customer's category.
  const categoryOverride = await db.customerOverrideRule.findFirst({
    where: { merchantId, targetType: 'CATEGORY', targetCategory: customer.category },
  });
  if (categoryOverride) {
    return {
      ...base,
      origin: 'CATEGORY_OVERRIDE',
      tiers: [
        {
          thresholdAmount: categoryOverride.thresholdAmount,
          discountPct: categoryOverride.discountPct,
          couponValidityDays: categoryOverride.couponValidityDays,
        },
      ],
    };
  }

  // 3. Otherwise the merchant default ladder.
  return {
    ...base,
    origin: 'DEFAULT',
    tiers: ruleSet.tiers.map((tier) => ({
      thresholdAmount: tier.thresholdAmount,
      discountPct: tier.discountPct,
      couponValidityDays: tier.couponValidityDays,
    })),
  };
}

/**
 * Where a customer stands against their ladder: the next tier to aim for and the
 * gap to it. Returns nulls once every tier is earned — the UI shows "all tiers
 * reached" rather than an impossible target.
 */
export function nextThreshold(
  rules: EffectiveRules,
  cumulativeAmount: number,
): { nextThresholdAmount: number | null; amountToNextThreshold: number | null; nextDiscountPct: number | null } {
  const next = rules.tiers.find((tier) => tier.thresholdAmount > cumulativeAmount);
  if (!next) {
    return { nextThresholdAmount: null, amountToNextThreshold: null, nextDiscountPct: null };
  }
  return {
    nextThresholdAmount: next.thresholdAmount,
    amountToNextThreshold: next.thresholdAmount - cumulativeAmount,
    nextDiscountPct: next.discountPct,
  };
}

/**
 * The highest tier a cumulative total has reached, or null if none.
 *
 * Only the highest matters: cumulative spend within a period only ever grows, so
 * crossing 250,000 means 100,000 was crossed too. Issuing for the highest alone is
 * what keeps a customer to one earned coupon and stops discounts stacking (§13.2).
 */
export function highestCrossedTier(
  rules: EffectiveRules,
  cumulativeAmount: number,
): EffectiveRules['tiers'][number] | null {
  let crossed: EffectiveRules['tiers'][number] | null = null;
  for (const tier of rules.tiers) {
    if (cumulativeAmount >= tier.thresholdAmount) crossed = tier;
    else break; // tiers are ascending, so the first miss ends the search
  }
  return crossed;
}
