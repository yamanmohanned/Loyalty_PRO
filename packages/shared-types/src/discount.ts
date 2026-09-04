import { z } from 'zod';
import {
  DiscountTypeSchema,
  RuleDiscountTypeSchema,
  SettlementStrategySchema,
  type DiscountType,
  type SettlementStrategy,
} from './enums';
import { IqdAmountSchema, PositiveIqdAmountSchema } from './money';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE INSTANT-DISCOUNT CONTRACT — CLAUDE_v3.md §2, as amended by v4 §1
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The discount applies to the basket the customer is standing there with, not a
 * future visit. That single change is what makes the financial guardrails in §2.3
 * mandatory rather than advisory.
 *
 * **v4: the discount is decided by THIS INVOICE'S AMOUNT and nothing else.** There is
 * no accumulation across visits, no period, and no running balance feeding the
 * decision (CLAUDE_UPDATE_4.md §1.1). A tier is an *invoice-amount bracket*: spend
 * 25,000 on one basket and that basket earns 2%; spend 25,000 across five baskets and
 * none of them does.
 *
 * The card did not become pointless when that changed — it decides **who is entitled
 * to a discount at all** (§1.2). An unattributed capture never earns one.
 *
 * **The exposure this creates, stated where the calculation lives** (§10.5): every
 * guardrail below bounds a *single invoice*, and none of them bounds a *customer*. A
 * wholesale buyer at 480,000 a day takes the ceiling every day. That is accepted by
 * design; the mitigation is the per-customer discount report, not a rule here. Do not
 * add a frequency cap to this function — it is a discount-model decision with its own
 * guardrails, not a tweak to the arithmetic.
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
  /**
   * The invoice amount at which this bracket starts — «قيمة الفاتورة» (v4 §1.4).
   *
   * Read as "an invoice of at least this much earns this discount". It is inclusive:
   * an invoice of exactly `thresholdAmount` qualifies.
   *
   * **The field keeps its v3 name deliberately.** It was cumulative spend across a
   * period and is now a single invoice's amount, but renaming it would touch thirteen
   * files mid-phase for no behavioural gain — the §12.12 precedent, where
   * `barcodeToken` kept its name and grew a comment saying what the value is. Every
   * Arabic label the manager reads does say «قيمة الفاتورة».
   */
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
  // `periodType` / `periodStart` / `periodEnd` are gone (v4 §1.3, §10.6). Nothing
  // accumulates, so there is no window to configure.
  settlementStrategy: SettlementStrategySchema,
});

export type DiscountSettings = z.infer<typeof DiscountSettingsSchema>;

export const UpdateDiscountSettingsRequestSchema = z
  .object({
    discountType: DiscountTypeSchema,
    minRate: z.number().int().min(0).max(100),
    maxRate: z.number().int().min(0).max(100),
    absoluteMaxDiscountValue: PositiveIqdAmountSchema,
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

    // A bigger invoice must never earn a smaller discount — that ladder makes no
    // sense to a customer and no sense on a receipt.
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

/* ── The ladder against the settings (§12.38) ───────────────────────────────── */

/** One thing wrong with one rule, in the shape the API's error envelope wants. */
export interface RuleViolation {
  path: string;
  message: string;
}

/**
 * Whether a discount ladder is legal under a merchant's own settings.
 *
 * **This is a business rule, and it lives here so there is exactly one of it.**
 *
 * It used to live inline in `updateDiscountRules`, which meant it protected the API
 * path and nothing else. The dev seed writes rules straight to the database and
 * therefore produced a configuration the API would reject — a 7,500 fixed-amount
 * rule under a 5,000 absolute cap — which is how §12.37 found it. That is §12.27's
 * lesson about duplicated DTOs, one level up: **a rule enforced in one caller is not
 * enforced, it is merely usually applied.**
 *
 * Pure, synchronous and dependency-free, so every writer can call it: the API
 * service, the seed, a future importer, a test factory. It takes the settings and
 * the rules as plain data rather than reading the database itself, precisely so that
 * a caller cannot be locked out by not having a Prisma client to hand.
 *
 * Returns the violations rather than throwing. The API turns them into its
 * `VALIDATION_FAILED` envelope with per-field paths; the seed prints them and stops.
 * A shared rule that threw an HTTP-shaped error would drag the transport into every
 * caller that is not HTTP.
 */
export function validateRulesAgainstSettings(
  rules: readonly Pick<
    DiscountRuleInput,
    'discountType' | 'discountRate' | 'maxDiscountValue'
  >[],
  settings: Pick<DiscountSettings, 'minRate' | 'maxRate' | 'absoluteMaxDiscountValue'>,
): RuleViolation[] {
  const violations: RuleViolation[] = [];

  rules.forEach((rule, index) => {
    if (rule.discountType === 'PERCENTAGE') {
      if (rule.discountRate < settings.minRate || rule.discountRate > settings.maxRate) {
        violations.push({
          path: `rules.${index}.discountRate`,
          message: `النسبة يجب أن تكون بين ${settings.minRate}٪ و ${settings.maxRate}٪ حسب إعدادات المتجر`,
        });
      }
    }

    // A fixed amount above the absolute ceiling could never actually be granted —
    // the engine would cap it. Rejecting it stops a manager configuring a number the
    // system will silently ignore, and §12.37's report exists because a writer that
    // skipped this check produced exactly that state.
    if (
      rule.discountType === 'FIXED_AMOUNT' &&
      rule.discountRate > settings.absoluteMaxDiscountValue
    ) {
      violations.push({
        path: `rules.${index}.discountRate`,
        message: `قيمة الخصم تتجاوز الحد الأقصى المطلق (${settings.absoluteMaxDiscountValue})`,
      });
    }

    if (
      rule.maxDiscountValue !== null &&
      rule.maxDiscountValue !== undefined &&
      rule.maxDiscountValue > settings.absoluteMaxDiscountValue
    ) {
      violations.push({
        path: `rules.${index}.maxDiscountValue`,
        message: 'الحد الأقصى للقاعدة لا يمكن أن يتجاوز الحد الأقصى المطلق',
      });
    }
  });

  return violations;
}

/* ── The calculation ───────────────────────────────────────────────────────── */

export interface DiscountComputationInput {
  /**
   * The invoice total as the POS recorded it — and, since v4, **the only thing that
   * decides which bracket applies**.
   *
   * v3 carried a second field here, `cumulativeAmount`: spend across the period,
   * including this invoice. It is **deleted rather than renamed** (§12.27's removal
   * corollary, §10.7). Both were a `number` passed positionally into an object
   * literal, so renaming it to `invoiceAmount` would have type-checked against every
   * call site still handing over a cumulative figure — and the engine would have gone
   * on computing discounts from the wrong number, correctly, forever. Deleting it
   * makes each of those call sites fail to compile in the same commit.
   */
  amountGross: number;
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
 *   2. Find the highest bracket THIS INVOICE'S AMOUNT reaches.
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

  // The highest bracket this invoice reaches. An invoice of 250,000 necessarily
  // clears 100,000 as well, so only the best one applies. Inclusive: an invoice of
  // exactly `thresholdAmount` qualifies, which is what a customer told "spend 25,000
  // and get 2%" expects when the till reads exactly 25,000.
  let applicable: (typeof active)[number] | null = null;
  for (const rule of active) {
    if (input.amountGross >= rule.thresholdAmount) applicable = rule;
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
    discountType: DiscountType;
    minRate: number;
    maxRate: number;
    absoluteMaxDiscountValue: number;
    /** Widened by adding a strategy, so the literal union may never be spelled here. */
    settlementStrategy: SettlementStrategy;
  };
  rules: Array<DiscountRuleRow & { id: string; isActive: boolean; sortOrder: number }>;
  assessments: Array<{ thresholdAmount: number; warning: string | null; exceedsProfit: boolean }>;
  settlementStrategies: Array<{ name: SettlementStrategy; label: string; requiresSplitPayment: boolean }>;
}
