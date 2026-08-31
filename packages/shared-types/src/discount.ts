import { z } from 'zod';
import {
  DiscountTypeSchema,
  PeriodTypeSchema,
  RuleDiscountTypeSchema,
  SettlementStrategySchema,
  type DiscountType,
} from './enums';
import { IqdAmountSchema, PositiveIqdAmountSchema } from './money';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE INSTANT-DISCOUNT CONTRACT — CLAUDE_v3.md §2
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The discount now applies to the basket the customer is standing there with, not
 * a future visit. That single change is what makes the financial guardrails in
 * §2.3 mandatory rather than advisory.
 *
 * The arithmetic that matters: supermarket net margin runs 2–4%. On a 25,000 IQD
 * basket that is roughly 750 IQD of profit. A 10% instant discount hands back
 * 2,500 IQD — the store **loses about 1,750 IQD on a sale it just made**. There is
 * no return visit to earn it back, because the discount was the visit.
 *
 * So this module is not merely types. It carries the cap arithmetic, and the cap is
 * the last line of defence: category exclusions were explicitly declined by the
 * merchant, so nothing else stands between a 500,000 IQD basket at 10% and a
 * 50,000 IQD giveaway.
 */

/* ── Rates ─────────────────────────────────────────────────────────────────── */

/** Whole percent, 1–100. A percentage is never a float. */
export const DiscountPercentageSchema = z
  .number()
  .int('نسبة الخصم يجب أن تكون عدداً صحيحاً')
  .min(1, 'نسبة الخصم يجب أن تكون 1٪ على الأقل')
  .max(100, 'نسبة الخصم لا يمكن أن تتجاوز 100٪');

/**
 * The band §2.3 recommends as safe. Not enforced as a hard limit — a merchant may
 * knowingly configure outside it — but crossing it must raise the margin warning.
 */
export const SAFE_PERCENTAGE_MIN = 1;
export const SAFE_PERCENTAGE_MAX = 3;

/** Typical supermarket net margin, used to estimate whether a rate destroys profit. */
export const ASSUMED_NET_MARGIN_PCT = 3;

/* ── Discount rules ────────────────────────────────────────────────────────── */

export const DiscountRuleSchema = z.object({
  id: z.string().uuid(),
  /** Cumulative spend in the active period that earns this tier. */
  thresholdAmount: PositiveIqdAmountSchema,
  discountType: RuleDiscountTypeSchema,
  /** Whole percent when PERCENTAGE; whole IQD when FIXED_AMOUNT. */
  discountRate: z.number().int().positive(),
  /** Per-rule IQD ceiling. Null defers to the settings-level absolute cap. */
  maxDiscountValue: IqdAmountSchema.nullable(),
  isActive: z.boolean(),
  sortOrder: z.number().int().min(0),
});

export type DiscountRule = z.infer<typeof DiscountRuleSchema>;

const DiscountRuleInputSchema = z
  .object({
    thresholdAmount: PositiveIqdAmountSchema,
    discountType: RuleDiscountTypeSchema,
    discountRate: z.number().int().positive(),
    maxDiscountValue: IqdAmountSchema.nullable().optional(),
  })
  .strict();

export type DiscountRuleInput = z.infer<typeof DiscountRuleInputSchema>;

/* ── Settings ──────────────────────────────────────────────────────────────── */

export const DiscountSettingsSchema = z.object({
  discountType: DiscountTypeSchema,
  minRate: z.number().int().min(0),
  maxRate: z.number().int().min(0),
  /** The absolute IQD ceiling applied after any percentage calculation (§2.3). */
  absoluteMaxDiscountValue: PositiveIqdAmountSchema,
  periodType: PeriodTypeSchema,
  periodStart: z.string().datetime({ offset: true }).nullable(),
  periodEnd: z.string().datetime({ offset: true }).nullable(),
  settlementStrategy: SettlementStrategySchema,
});

export type DiscountSettings = z.infer<typeof DiscountSettingsSchema>;

export const UpdateDiscountSettingsRequestSchema = z
  .object({
    discountType: DiscountTypeSchema,
    minRate: z.number().int().min(0).max(100),
    maxRate: z.number().int().min(0).max(100),
    absoluteMaxDiscountValue: PositiveIqdAmountSchema,
    periodType: PeriodTypeSchema,
    periodStart: z.string().datetime({ offset: true }).nullable().optional(),
    periodEnd: z.string().datetime({ offset: true }).nullable().optional(),
    settlementStrategy: SettlementStrategySchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.minRate > value.maxRate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['minRate'],
        message: 'الحد الأدنى للنسبة يجب ألا يتجاوز الحد الأعلى',
      });
    }
    if (value.periodType === 'CUSTOM' && (!value.periodStart || !value.periodEnd)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['periodStart'],
        message: 'الفترة المخصصة تتطلب تاريخ بداية ونهاية',
      });
    }
  });

export type UpdateDiscountSettingsRequest = z.infer<typeof UpdateDiscountSettingsRequestSchema>;

export const UpdateDiscountRulesRequestSchema = z
  .object({ rules: z.array(DiscountRuleInputSchema).min(1, 'يجب تحديد قاعدة واحدة على الأقل') })
  .strict()
  .superRefine((value, ctx) => {
    const thresholds = value.rules.map((r) => r.thresholdAmount);
    if (new Set(thresholds).size !== thresholds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rules'],
        message: 'لا يمكن تكرار نفس مبلغ العتبة في أكثر من قاعدة',
      });
    }

    // Higher spend must never earn a smaller discount — that ladder makes no sense
    // to a customer and no sense on a receipt.
    const ordered = [...value.rules].sort((a, b) => a.thresholdAmount - b.thresholdAmount);
    for (let i = 1; i < ordered.length; i += 1) {
      const previous = ordered[i - 1];
      const current = ordered[i];
      if (!previous || !current) continue;
      if (previous.discountType === current.discountType && current.discountRate <= previous.discountRate) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rules', i, 'discountRate'],
          message: 'قيمة الخصم يجب أن تزداد كلما ارتفعت العتبة',
        });
      }
    }
  });

export type UpdateDiscountRulesRequest = z.infer<typeof UpdateDiscountRulesRequestSchema>;

/* ── The calculation ───────────────────────────────────────────────────────── */

export interface DiscountComputationInput {
  /** The invoice total as the POS recorded it. */
  amountGross: number;
  /** Cumulative spend this period INCLUDING this invoice. */
  cumulativeAmount: number;
  /** Active rules, any order — sorted internally. */
  rules: Array<Pick<DiscountRule, 'thresholdAmount' | 'discountType' | 'discountRate' | 'maxDiscountValue' | 'isActive'>>;
  /** The settings-level absolute ceiling. */
  absoluteMaxDiscountValue: number;
  /** `NONE` disables discounting while leaving capture running. */
  discountTypeSetting: DiscountType;
}

export interface DiscountComputation {
  /** The rule that applied, or null when none was reached. */
  appliedThreshold: number | null;
  discountType: DiscountType;
  discountRate: number;
  /** Final IQD discount, after every cap. */
  discountValue: number;
  amountNet: number;
  /** True when a cap reduced the raw calculation — surfaced in reporting and the UI. */
  wasCapped: boolean;
  /** What the raw calculation produced before capping, for transparency. */
  uncappedValue: number;
}

/**
 * Computes the instant discount for one invoice.
 *
 * Pure and deterministic: the same inputs always give the same answer, on the
 * server and in the manager's live margin preview, so the number a manager is shown
 * while configuring is the number a customer will actually receive.
 *
 * Order of operations, and each step matters:
 *   1. If discounting is off, stop. Zero discount is a valid outcome, not a failure.
 *   2. Find the highest threshold the cumulative spend has reached.
 *   3. Compute the raw value by type.
 *   4. Apply the per-rule cap, if the rule sets one.
 *   5. Apply the absolute settings cap. **Never skipped.**
 *   6. Clamp to the invoice total — a discount may never exceed what is being paid,
 *      which would turn a sale into a payout.
 */
export function computeDiscount(input: DiscountComputationInput): DiscountComputation {
  const none: DiscountComputation = {
    appliedThreshold: null,
    discountType: 'NONE',
    discountRate: 0,
    discountValue: 0,
    amountNet: input.amountGross,
    wasCapped: false,
    uncappedValue: 0,
  };

  if (input.discountTypeSetting === 'NONE') return none;

  const active = input.rules
    .filter((r) => r.isActive)
    .sort((a, b) => a.thresholdAmount - b.thresholdAmount);

  // The highest tier reached. Cumulative spend only grows within a period, so
  // clearing 250,000 necessarily cleared 100,000 — only the best one applies.
  let applicable: (typeof active)[number] | null = null;
  for (const rule of active) {
    if (input.cumulativeAmount >= rule.thresholdAmount) applicable = rule;
    else break;
  }
  if (!applicable) return none;

  const uncapped =
    applicable.discountType === 'PERCENTAGE'
      ? Math.floor((input.amountGross * applicable.discountRate) / 100)
      : applicable.discountRate;

  let value = uncapped;

  if (applicable.maxDiscountValue !== null && applicable.maxDiscountValue !== undefined) {
    value = Math.min(value, applicable.maxDiscountValue);
  }

  // ═══ THE ABSOLUTE CAP (§2.3) — the last line of defence ═══
  value = Math.min(value, input.absoluteMaxDiscountValue);

  // A discount larger than the basket would mean paying the customer to shop.
  value = Math.min(value, input.amountGross);
  value = Math.max(value, 0);

  return {
    appliedThreshold: applicable.thresholdAmount,
    discountType: applicable.discountType,
    discountRate: applicable.discountRate,
    discountValue: value,
    amountNet: input.amountGross - value,
    wasCapped: value < uncapped,
    uncappedValue: uncapped,
  };
}

/* ── The margin warning (§2.3) ─────────────────────────────────────────────── */

export interface MarginAssessment {
  /** IQD the discount would cost on a basket at the threshold. */
  discountAtThreshold: number;
  /** Estimated net profit on that basket, at the assumed margin. */
  estimatedNetProfit: number;
  /** True when the discount exceeds estimated profit — the sale loses money. */
  exceedsProfit: boolean;
  /** True when the rate sits outside the recommended 1–3% band. */
  outsideSafeBand: boolean;
  /** Arabic sentence for the settings UI. Null when there is nothing to warn about. */
  warning: string | null;
}

/**
 * Assesses whether a configured rate would lose the merchant money, so the software
 * protects them from a costly misconfiguration rather than leaving it to judgement
 * (§2.3). Shown live as the manager types.
 */
export function assessMargin(params: {
  thresholdAmount: number;
  discountType: 'PERCENTAGE' | 'FIXED_AMOUNT';
  discountRate: number;
  absoluteMaxDiscountValue: number;
  assumedNetMarginPct?: number;
}): MarginAssessment {
  const margin = params.assumedNetMarginPct ?? ASSUMED_NET_MARGIN_PCT;

  const raw =
    params.discountType === 'PERCENTAGE'
      ? Math.floor((params.thresholdAmount * params.discountRate) / 100)
      : params.discountRate;

  const discountAtThreshold = Math.min(raw, params.absoluteMaxDiscountValue);
  const estimatedNetProfit = Math.floor((params.thresholdAmount * margin) / 100);
  const exceedsProfit = discountAtThreshold > estimatedNetProfit;

  const outsideSafeBand =
    params.discountType === 'PERCENTAGE' &&
    (params.discountRate < SAFE_PERCENTAGE_MIN || params.discountRate > SAFE_PERCENTAGE_MAX);

  let warning: string | null = null;
  if (exceedsProfit) {
    warning =
      `خصم ${params.discountRate}${params.discountType === 'PERCENTAGE' ? '٪' : ' د.ع'} ` +
      `على عتبة ${params.thresholdAmount.toLocaleString('en-US')} = ` +
      `${discountAtThreshold.toLocaleString('en-US')} د.ع — ` +
      `أعلى من الربح الصافي التقديري لهذه الفاتورة ` +
      `(${estimatedNetProfit.toLocaleString('en-US')} د.ع).`;
  } else if (outsideSafeBand) {
    warning =
      `النسبة خارج النطاق الآمن الموصى به (${SAFE_PERCENTAGE_MIN}–${SAFE_PERCENTAGE_MAX}٪). ` +
      `تحقّق من هامش الربح قبل الاعتماد.`;
  }

  return {
    discountAtThreshold,
    estimatedNetProfit,
    exceedsProfit,
    outsideSafeBand,
    warning,
  };
}

/* ── The configuration payload (§12.27) ───────────────────────────────────── */

/**
 * One rung of the ladder as the rules editor edits it.
 *
 * `id` is optional because a row the manager has just added does not have one yet.
 */
export interface DiscountRuleRow {
  id?: string;
  thresholdAmount: number;
  discountType: 'PERCENTAGE' | 'FIXED_AMOUNT';
  discountRate: number;
  maxDiscountValue: number | null;
}

/**
 * Everything the discount screen needs, in one response.
 *
 * `assessments` travels with the rules rather than being recomputed in the client:
 * the margin warning is the §2.3 guardrail the manager sees before saving a rate
 * that loses money on every qualifying sale, and a client that derived it could
 * derive it differently from the server that enforces it.
 */
export interface DiscountConfigResponse {
  settings: {
    discountType: 'PERCENTAGE' | 'FIXED_AMOUNT' | 'NONE';
    minRate: number;
    maxRate: number;
    absoluteMaxDiscountValue: number;
    periodType: 'WEEKLY' | 'MONTHLY' | 'CUSTOM';
    settlementStrategy: 'VOUCHER_AS_PAYMENT' | 'DAILY_PROMOTIONAL_EXPENSE';
  };
  rules: Array<DiscountRuleRow & { id: string; isActive: boolean; sortOrder: number }>;
  assessments: Array<{ thresholdAmount: number; warning: string | null; exceedsProfit: boolean }>;
  settlementStrategies: Array<{ name: string; label: string; requiresSplitPayment: boolean }>;
}
