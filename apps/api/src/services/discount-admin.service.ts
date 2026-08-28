import {
  assessMargin,
  type DiscountRule,
  type DiscountSettings,
  type UpdateDiscountRulesRequest,
  type UpdateDiscountSettingsRequest,
} from '@walaa/shared-types';
import { notFound, validationFailed } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { AUDIT_ACTIONS, recordAudit } from './audit.service';

/**
 * Discount configuration, and the guardrails that stop a misconfiguration from
 * costing the merchant more than the sales it drives (CLAUDE_v3.md §2.3).
 *
 * **The guardrails are enforced here, in code, not left to the manager's
 * judgement.** That is a deliberate design position: the person setting a rate is
 * usually thinking about competitiveness, not about the fact that a supermarket
 * clears 2–4% net and a 10% instant discount therefore loses roughly 1,750 IQD on
 * a 25,000 IQD basket. The software has to know that even when the manager does
 * not stop to work it out.
 *
 * The distinction that matters: rates outside the recommended band are **warned**
 * about, since a merchant may knowingly run a promotion. Rates outside the
 * merchant's own configured min/max are **rejected**, because those bounds are the
 * limit they set for themselves.
 */

function serializeRule(row: {
  id: string;
  thresholdAmount: number;
  discountType: string;
  discountRate: number;
  maxDiscountValue: number | null;
  isActive: boolean;
  sortOrder: number;
}): DiscountRule {
  return {
    id: row.id,
    thresholdAmount: row.thresholdAmount,
    discountType: row.discountType as 'PERCENTAGE' | 'FIXED_AMOUNT',
    discountRate: row.discountRate,
    maxDiscountValue: row.maxDiscountValue,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
  };
}

function serializeSettings(row: {
  discountType: string;
  minRate: number;
  maxRate: number;
  absoluteMaxDiscountValue: number;
  periodType: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  settlementStrategy: string;
}): DiscountSettings {
  return {
    discountType: row.discountType as DiscountSettings['discountType'],
    minRate: row.minRate,
    maxRate: row.maxRate,
    absoluteMaxDiscountValue: row.absoluteMaxDiscountValue,
    periodType: row.periodType as DiscountSettings['periodType'],
    periodStart: row.periodStart ? row.periodStart.toISOString() : null,
    periodEnd: row.periodEnd ? row.periodEnd.toISOString() : null,
    settlementStrategy: row.settlementStrategy as DiscountSettings['settlementStrategy'],
  };
}

export async function getDiscountConfiguration(merchantId: string): Promise<{
  settings: DiscountSettings;
  rules: DiscountRule[];
  /** Live margin assessment per rule, so the UI can show warnings without recomputing. */
  assessments: Array<{ thresholdAmount: number; warning: string | null; exceedsProfit: boolean }>;
}> {
  const settings = await prisma.discountSettings.findUnique({ where: { merchantId } });
  if (!settings) throw notFound('لا توجد إعدادات خصم لهذا التاجر');

  const rules = await prisma.discountRule.findMany({
    where: { merchantId },
    orderBy: { thresholdAmount: 'asc' },
  });

  const assessments = rules.map((rule) => {
    const assessment = assessMargin({
      thresholdAmount: rule.thresholdAmount,
      discountType: rule.discountType as 'PERCENTAGE' | 'FIXED_AMOUNT',
      discountRate: rule.discountRate,
      absoluteMaxDiscountValue: settings.absoluteMaxDiscountValue,
    });
    return {
      thresholdAmount: rule.thresholdAmount,
      warning: assessment.warning,
      exceedsProfit: assessment.exceedsProfit,
    };
  });

  return {
    settings: serializeSettings(settings),
    rules: rules.map(serializeRule),
    assessments,
  };
}

export async function updateDiscountSettings(
  params: { merchantId: string; actorUserId: string },
  request: UpdateDiscountSettingsRequest,
): Promise<DiscountSettings> {
  const before = await prisma.discountSettings.findUnique({
    where: { merchantId: params.merchantId },
  });
  if (!before) throw notFound('لا توجد إعدادات خصم لهذا التاجر');

  // A percentage discount without an absolute ceiling is the configuration §2.3
  // forbids outright — it is the one that gives away 50,000 on a large basket.
  if (request.discountType === 'PERCENTAGE' && request.absoluteMaxDiscountValue <= 0) {
    throw validationFailed('لا يمكن تفعيل خصم نسبي بدون حد أقصى مطلق للقيمة', [
      { path: 'absoluteMaxDiscountValue', message: 'الحد الأقصى المطلق مطلوب مع الخصم النسبي' },
    ]);
  }

  const updated = await prisma.$transaction(async (db) => {
    const next = await db.discountSettings.update({
      where: { merchantId: params.merchantId },
      data: {
        discountType: request.discountType,
        minRate: request.minRate,
        maxRate: request.maxRate,
        absoluteMaxDiscountValue: request.absoluteMaxDiscountValue,
        periodType: request.periodType,
        periodStart: request.periodStart ? new Date(request.periodStart) : null,
        periodEnd: request.periodEnd ? new Date(request.periodEnd) : null,
        settlementStrategy: request.settlementStrategy,
      },
    });

    await recordAudit(
      {
        merchantId: params.merchantId,
        actorUserId: params.actorUserId,
        action: AUDIT_ACTIONS.DISCOUNT_SETTINGS_UPDATED,
        entityType: 'discount_settings',
        entityId: next.id,
        before: serializeSettings(before),
        after: serializeSettings(next),
      },
      db,
    );

    return next;
  });

  return serializeSettings(updated);
}

/**
 * Replaces the rule ladder wholesale.
 *
 * Rejects — not warns about — any rate outside the merchant's own configured
 * min/max. Those bounds exist so a mistake at the keyboard cannot become a
 * discount at the till, and a bound that can be exceeded is not a bound.
 *
 * What this deliberately does NOT do: re-evaluate discounts already granted. A
 * voucher in a customer's hand is theirs. Changing the ladder governs future
 * scans only.
 */
export async function updateDiscountRules(
  params: { merchantId: string; actorUserId: string },
  request: UpdateDiscountRulesRequest,
): Promise<DiscountRule[]> {
  const settings = await prisma.discountSettings.findUnique({
    where: { merchantId: params.merchantId },
  });
  if (!settings) throw notFound('لا توجد إعدادات خصم لهذا التاجر');

  const fields: Array<{ path: string; message: string }> = [];

  request.rules.forEach((rule, index) => {
    if (rule.discountType === 'PERCENTAGE') {
      if (rule.discountRate < settings.minRate || rule.discountRate > settings.maxRate) {
        fields.push({
          path: `rules.${index}.discountRate`,
          message: `النسبة يجب أن تكون بين ${settings.minRate}٪ و ${settings.maxRate}٪ حسب إعدادات المتجر`,
        });
      }
    }

    // A fixed amount above the absolute ceiling could never actually be granted —
    // the engine would cap it. Rejecting it here stops the manager configuring a
    // number the system will silently ignore.
    if (
      rule.discountType === 'FIXED_AMOUNT' &&
      rule.discountRate > settings.absoluteMaxDiscountValue
    ) {
      fields.push({
        path: `rules.${index}.discountRate`,
        message: `قيمة الخصم تتجاوز الحد الأقصى المطلق (${settings.absoluteMaxDiscountValue})`,
      });
    }

    if (
      rule.maxDiscountValue !== null &&
      rule.maxDiscountValue !== undefined &&
      rule.maxDiscountValue > settings.absoluteMaxDiscountValue
    ) {
      fields.push({
        path: `rules.${index}.maxDiscountValue`,
        message: 'الحد الأقصى للقاعدة لا يمكن أن يتجاوز الحد الأقصى المطلق',
      });
    }
  });

  if (fields.length > 0) {
    throw validationFailed('القواعد تتجاوز الحدود المسموحة في إعدادات المتجر', fields);
  }

  const previous = await prisma.discountRule.findMany({
    where: { merchantId: params.merchantId },
    orderBy: { thresholdAmount: 'asc' },
  });

  await prisma.$transaction(async (db) => {
    // Replace rather than diff: the ladder is small, and a wholesale swap avoids a
    // half-applied edit leaving an incoherent set of thresholds live at the till.
    await db.discountRule.deleteMany({ where: { merchantId: params.merchantId } });

    const ordered = [...request.rules].sort((a, b) => a.thresholdAmount - b.thresholdAmount);
    for (const [index, rule] of ordered.entries()) {
      await db.discountRule.create({
        data: {
          merchantId: params.merchantId,
          thresholdAmount: rule.thresholdAmount,
          discountType: rule.discountType,
          discountRate: rule.discountRate,
          maxDiscountValue: rule.maxDiscountValue ?? null,
          isActive: true,
          sortOrder: index,
        },
      });
    }

    await recordAudit(
      {
        merchantId: params.merchantId,
        actorUserId: params.actorUserId,
        action: AUDIT_ACTIONS.DISCOUNT_RULES_UPDATED,
        entityType: 'discount_rule',
        entityId: params.merchantId,
        before: { rules: previous.map(serializeRule) },
        after: { rules: ordered },
      },
      db,
    );
  });

  const rules = await prisma.discountRule.findMany({
    where: { merchantId: params.merchantId },
    orderBy: { thresholdAmount: 'asc' },
  });

  return rules.map(serializeRule);
}
