import type {
  CreateOverrideRequest,
  LoyaltyRuleSet,
  OverrideRule,
  UpdateRuleSetRequest,
} from '@walaa/shared-types';
import { notFound, validationFailed } from '../lib/errors';
import { isUniqueViolation, prisma } from '../lib/prisma';
import { AUDIT_ACTIONS, recordAudit } from './audit.service';

/**
 * Editing loyalty rules. Every change here is audited (CLAUDE.md §7.10) — a
 * threshold quietly moved is the difference between a customer earning a discount
 * and not, so "who changed it and to what" must always be answerable.
 */

export async function getRuleSet(merchantId: string): Promise<LoyaltyRuleSet> {
  const ruleSet = await prisma.loyaltyRuleSet.findFirst({
    where: { merchantId, isActive: true },
    orderBy: { createdAt: 'desc' },
    include: { tiers: { orderBy: { thresholdAmount: 'asc' } } },
  });
  if (!ruleSet) throw notFound('لا توجد قواعد ولاء فعّالة');

  return {
    id: ruleSet.id,
    periodType: ruleSet.periodType,
    periodStart: ruleSet.periodStart ? ruleSet.periodStart.toISOString() : null,
    periodEnd: ruleSet.periodEnd ? ruleSet.periodEnd.toISOString() : null,
    isActive: ruleSet.isActive,
    tiers: ruleSet.tiers.map((tier) => ({
      id: tier.id,
      thresholdAmount: tier.thresholdAmount,
      discountPct: tier.discountPct,
      couponValidityDays: tier.couponValidityDays,
      sortOrder: tier.sortOrder,
    })),
  };
}

/**
 * Replaces the ladder wholesale.
 *
 * Note what this deliberately does NOT do: retroactively re-evaluate coupons
 * already issued under the old rules. A coupon a customer was told they earned is
 * theirs; changing the ladder governs future crossings only.
 */
export async function updateRuleSet(
  params: { merchantId: string; actorUserId: string },
  request: UpdateRuleSetRequest,
): Promise<LoyaltyRuleSet> {
  const existing = await prisma.loyaltyRuleSet.findFirst({
    where: { merchantId: params.merchantId, isActive: true },
    orderBy: { createdAt: 'desc' },
    include: { tiers: { orderBy: { thresholdAmount: 'asc' } } },
  });
  if (!existing) throw notFound('لا توجد قواعد ولاء فعّالة');

  await prisma.$transaction(async (db) => {
    await db.loyaltyRuleSet.update({
      where: { id: existing.id },
      data: {
        periodType: request.periodType,
        periodStart: request.periodStart ? new Date(request.periodStart) : null,
        periodEnd: request.periodEnd ? new Date(request.periodEnd) : null,
      },
    });

    // Replace rather than diff: the ladder is small, and a wholesale swap avoids
    // a half-applied edit leaving an inconsistent set of thresholds.
    await db.loyaltyTier.deleteMany({ where: { ruleSetId: existing.id } });

    const ordered = [...request.tiers].sort((a, b) => a.thresholdAmount - b.thresholdAmount);
    await db.loyaltyTier.createMany({
      data: ordered.map((tier, index) => ({
        ruleSetId: existing.id,
        thresholdAmount: tier.thresholdAmount,
        discountPct: tier.discountPct,
        couponValidityDays: tier.couponValidityDays,
        sortOrder: index,
      })),
    });

    await recordAudit(
      {
        merchantId: params.merchantId,
        actorUserId: params.actorUserId,
        action: AUDIT_ACTIONS.RULES_UPDATED,
        entityType: 'loyalty_rule_set',
        entityId: existing.id,
        before: {
          periodType: existing.periodType,
          tiers: existing.tiers.map((t) => ({
            thresholdAmount: t.thresholdAmount,
            discountPct: t.discountPct,
            couponValidityDays: t.couponValidityDays,
          })),
        },
        after: { periodType: request.periodType, tiers: ordered },
      },
      db,
    );
  });

  return getRuleSet(params.merchantId);
}

function serializeOverride(row: {
  id: string;
  targetType: 'CUSTOMER' | 'CATEGORY';
  targetCustomerId: string | null;
  targetCategory: 'REGULAR' | 'WHOLESALE' | 'VIP' | null;
  thresholdAmount: number;
  discountPct: number;
  couponValidityDays: number;
}): OverrideRule {
  return {
    id: row.id,
    targetType: row.targetType,
    targetCustomerId: row.targetCustomerId,
    targetCategory: row.targetCategory,
    thresholdAmount: row.thresholdAmount,
    discountPct: row.discountPct,
    couponValidityDays: row.couponValidityDays,
  };
}

export async function listOverrides(merchantId: string): Promise<OverrideRule[]> {
  const rows = await prisma.customerOverrideRule.findMany({
    where: { merchantId },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(serializeOverride);
}

export async function createOverride(
  params: { merchantId: string; actorUserId: string },
  request: CreateOverrideRequest,
): Promise<OverrideRule> {
  if (request.targetType === 'CUSTOMER') {
    const customer = await prisma.customer.findFirst({
      where: { id: request.targetCustomerId ?? '', merchantId: params.merchantId },
      select: { id: true },
    });
    if (!customer) throw notFound('الزبون غير موجود');
  }

  try {
    const created = await prisma.$transaction(async (db) => {
      const row = await db.customerOverrideRule.create({
        data: {
          merchantId: params.merchantId,
          targetType: request.targetType,
          targetCustomerId: request.targetType === 'CUSTOMER' ? request.targetCustomerId : null,
          targetCategory: request.targetType === 'CATEGORY' ? request.targetCategory : null,
          thresholdAmount: request.thresholdAmount,
          discountPct: request.discountPct,
          couponValidityDays: request.couponValidityDays,
        },
      });

      await recordAudit(
        {
          merchantId: params.merchantId,
          actorUserId: params.actorUserId,
          action: AUDIT_ACTIONS.OVERRIDE_CREATED,
          entityType: 'customer_override_rule',
          entityId: row.id,
          after: { ...serializeOverride(row) },
        },
        db,
      );

      return row;
    });

    return serializeOverride(created);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw validationFailed('يوجد استثناء مسجّل لهذا الهدف مسبقاً');
    }
    throw error;
  }
}

export async function deleteOverride(params: {
  merchantId: string;
  overrideId: string;
  actorUserId: string;
}): Promise<void> {
  const existing = await prisma.customerOverrideRule.findFirst({
    where: { id: params.overrideId, merchantId: params.merchantId },
  });
  if (!existing) throw notFound('الاستثناء غير موجود');

  await prisma.$transaction(async (db) => {
    await db.customerOverrideRule.delete({ where: { id: params.overrideId } });
    await recordAudit(
      {
        merchantId: params.merchantId,
        actorUserId: params.actorUserId,
        action: AUDIT_ACTIONS.OVERRIDE_DELETED,
        entityType: 'customer_override_rule',
        entityId: params.overrideId,
        before: { ...serializeOverride(existing) },
      },
      db,
    );
  });
}
