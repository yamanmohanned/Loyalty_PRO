import { z } from 'zod';
import { CouponStatusSchema } from './enums';
import { DiscountPctSchema, IqdAmountSchema } from './money';
import { PeriodKeySchema } from './period';

/**
 * Coupons are single-use, expiring discounts issued automatically when a customer
 * crosses a tier threshold. Redemption is a state transition, not a delete, so the
 * audit trail stays intact (CLAUDE.md §4.1, §7.10).
 */

export const CouponSchema = z.object({
  id: z.string().uuid(),
  customerId: z.string().uuid(),
  discountPct: DiscountPctSchema,
  /** The threshold that earned it — shown to the customer as the reason. */
  sourceThresholdAmount: IqdAmountSchema,
  /** The period the earning spend fell in. One coupon per tier per period. */
  periodKey: PeriodKeySchema,
  issuedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  status: CouponStatusSchema,
  redeemedAt: z.string().datetime({ offset: true }).nullable(),
});

export type Coupon = z.infer<typeof CouponSchema>;

/**
 * Redemption is manual at the main register — the cashier types the discount in
 * themselves. The assistant app shows the instruction prominently (CLAUDE.md §6.7 #5),
 * and this call records that it happened.
 */
export const RedeemCouponRequestSchema = z
  .object({
    /** Device-generated, so a retried redeem after a dropped response is not a second use. */
    idempotencyKey: z.string().uuid().optional(),
  })
  .strict();

export type RedeemCouponRequest = z.infer<typeof RedeemCouponRequestSchema>;

export const RedeemCouponResponseSchema = z.object({
  coupon: CouponSchema,
  /** The exact sentence to read to the cashier, pre-formatted with the percentage. */
  cashierInstruction: z.string(),
});

export type RedeemCouponResponse = z.infer<typeof RedeemCouponResponseSchema>;
