import { z } from 'zod';
import { CustomerCategorySchema, OverrideTargetTypeSchema, PeriodTypeSchema } from './enums';
import { DiscountPctSchema, PositiveIqdAmountSchema } from './money';

/**
 * Loyalty rules: a default tier ladder plus per-customer / per-category overrides.
 *
 * Decision (confirmed 2026-08-24) — resolution order:
 *   1. a CUSTOMER override, if one exists for this customer;
 *   2. otherwise a CATEGORY override matching the customer's category;
 *   3. otherwise the merchant's active default rule set.
 * Most specific wins, and an override **replaces the whole ladder** with its single
 * tier rather than shifting one rung of it.
 */

export const LoyaltyTierSchema = z.object({
  id: z.string().uuid(),
  /** Cumulative spend within the period that earns this tier. */
  thresholdAmount: PositiveIqdAmountSchema,
  discountPct: DiscountPctSchema,
  /** Days the issued coupon stays ACTIVE before expiring. */
  couponValidityDays: z.number().int().min(1).max(365),
  sortOrder: z.number().int().min(0),
});

export type LoyaltyTier = z.infer<typeof LoyaltyTierSchema>;

export const LoyaltyRuleSetSchema = z.object({
  id: z.string().uuid(),
  periodType: PeriodTypeSchema,
  periodStart: z.string().datetime({ offset: true }).nullable(),
  periodEnd: z.string().datetime({ offset: true }).nullable(),
  isActive: z.boolean(),
  tiers: z.array(LoyaltyTierSchema),
});

export type LoyaltyRuleSet = z.infer<typeof LoyaltyRuleSetSchema>;

const TierInputSchema = z
  .object({
    thresholdAmount: PositiveIqdAmountSchema,
    discountPct: DiscountPctSchema,
    couponValidityDays: z.number().int().min(1).max(365),
  })
  .strict();

export const UpdateRuleSetRequestSchema = z
  .object({
    periodType: PeriodTypeSchema,
    periodStart: z.string().datetime({ offset: true }).nullable().optional(),
    periodEnd: z.string().datetime({ offset: true }).nullable().optional(),
    tiers: z.array(TierInputSchema).min(1, 'يجب تحديد مستوى واحد على الأقل'),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.periodType === 'CUSTOM' && (!value.periodStart || !value.periodEnd)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['periodStart'],
        message: 'الفترة المخصصة تتطلب تاريخ بداية ونهاية',
      });
    }
    // A ladder with a repeated threshold has an ambiguous "next tier" — reject it.
    const thresholds = value.tiers.map((t) => t.thresholdAmount);
    if (new Set(thresholds).size !== thresholds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tiers'],
        message: 'لا يمكن تكرار نفس مبلغ العتبة في أكثر من مستوى',
      });
    }
    // Higher spend must never earn a smaller discount — that ladder makes no sense.
    const ordered = [...value.tiers].sort((a, b) => a.thresholdAmount - b.thresholdAmount);
    for (let i = 1; i < ordered.length; i += 1) {
      const previous = ordered[i - 1];
      const current = ordered[i];
      if (previous && current && current.discountPct <= previous.discountPct) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tiers', i, 'discountPct'],
          message: 'نسبة الخصم يجب أن تزداد كلما ارتفعت العتبة',
        });
      }
    }
  });

export type UpdateRuleSetRequest = z.infer<typeof UpdateRuleSetRequestSchema>;

export const OverrideRuleSchema = z.object({
  id: z.string().uuid(),
  targetType: OverrideTargetTypeSchema,
  targetCustomerId: z.string().uuid().nullable(),
  targetCategory: CustomerCategorySchema.nullable(),
  thresholdAmount: PositiveIqdAmountSchema,
  discountPct: DiscountPctSchema,
  couponValidityDays: z.number().int().min(1).max(365),
});

export type OverrideRule = z.infer<typeof OverrideRuleSchema>;

export const CreateOverrideRequestSchema = z
  .object({
    targetType: OverrideTargetTypeSchema,
    targetCustomerId: z.string().uuid().nullable().optional(),
    targetCategory: CustomerCategorySchema.nullable().optional(),
    thresholdAmount: PositiveIqdAmountSchema,
    discountPct: DiscountPctSchema,
    couponValidityDays: z.number().int().min(1).max(365),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.targetType === 'CUSTOMER' && !value.targetCustomerId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetCustomerId'],
        message: 'يجب تحديد الزبون',
      });
    }
    if (value.targetType === 'CATEGORY' && !value.targetCategory) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetCategory'],
        message: 'يجب تحديد فئة الزبائن',
      });
    }
  });

export type CreateOverrideRequest = z.infer<typeof CreateOverrideRequestSchema>;

/**
 * The effective ladder for one customer after override resolution — what the
 * threshold check actually runs against.
 */
export interface EffectiveRules {
  periodType: z.infer<typeof PeriodTypeSchema>;
  periodStart: Date | null;
  periodEnd: Date | null;
  /** Ascending by threshold. */
  tiers: Array<{
    thresholdAmount: number;
    discountPct: number;
    couponValidityDays: number;
  }>;
  /** Which layer supplied these rules — surfaced on the customer detail screen. */
  origin: 'DEFAULT' | 'CATEGORY_OVERRIDE' | 'CUSTOMER_OVERRIDE';
}
