import { z } from 'zod';

/**
 * Money in this system is **whole Iraqi Dinars stored as a JavaScript integer**.
 *
 * Why not a minor unit: IQD has no circulating subdivision (the fils is obsolete),
 * so there is nothing to scale by — 85000 means ٨٥٬٠٠٠ د.ع exactly. CLAUDE.md §4.2.
 *
 * Why `number` and not `bigint`: every per-row money value in this system is bounded.
 * A single invoice, a tier threshold, and a customer's cumulative spend *within one
 * loyalty period* all sit far below Int32 (2_147_483_647 IQD ≈ 40× an extreme
 * wholesale month). Keeping money a plain integer avoids a BigInt serialisation tax
 * on the core loop. The one place this bound does not hold is an all-time SUM across
 * every transaction in a report query — those aggregates MUST cast to BIGINT in SQL
 * before summing. See CLAUDE.md §4.2.
 */
export const MAX_IQD = 2_147_483_647;

/** Runtime guard: a non-negative safe integer within Int32. Rejects floats outright. */
export const IqdAmountSchema = z
  .number({ invalid_type_error: 'المبلغ يجب أن يكون رقماً' })
  .int('المبلغ يجب أن يكون عدداً صحيحاً بالدينار العراقي')
  .nonnegative('المبلغ لا يمكن أن يكون سالباً')
  .max(MAX_IQD, 'المبلغ يتجاوز الحد المسموح');

/** A strictly positive amount — used where zero is meaningless (an invoice, a threshold). */
export const PositiveIqdAmountSchema = IqdAmountSchema.positive('المبلغ يجب أن يكون أكبر من صفر');

export type IqdAmount = z.infer<typeof IqdAmountSchema>;

/** ISO 4217. The platform is single-currency today; the field exists so it can stop being. */
export const CurrencySchema = z.literal('IQD');
export type Currency = z.infer<typeof CurrencySchema>;

/** A discount percentage: whole percent, 1–100. Never a float. */
export const DiscountPctSchema = z
  .number()
  .int('نسبة الخصم يجب أن تكون عدداً صحيحاً')
  .min(1, 'نسبة الخصم يجب أن تكون 1٪ على الأقل')
  .max(100, 'نسبة الخصم لا يمكن أن تتجاوز 100٪');

export type DiscountPct = z.infer<typeof DiscountPctSchema>;

/**
 * Formats an integer IQD amount for display: Western digits, thousands separators,
 * currency suffix. Rendering (font, size) is the UI's job — this only owns the string.
 */
export function formatIqd(amount: IqdAmount, options?: { withSuffix?: boolean }): string {
  const withSuffix = options?.withSuffix ?? true;
  const grouped = new Intl.NumberFormat('en-US').format(amount);
  return withSuffix ? `${grouped} د.ع` : grouped;
}
