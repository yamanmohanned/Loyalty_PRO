import { z } from 'zod';
import { SettlementStrategySchema, VoucherStatusSchema } from './enums';
import { PositiveIqdAmountSchema } from './money';

/**
 * Vouchers — the printed discount slip (docs/legacy/CLAUDE_v3.md §5.2, §6.3).
 *
 * Replaces v1's coupon entirely. The difference is not cosmetic: a coupon was a
 * promise redeemable on a *future* visit, whereas a voucher is proof of a discount
 * granted on *this* basket, handed to the cashier as part of settling the sale.
 *
 * Its reason for existing is accounting, not marketing. Under either settlement
 * strategy (§9) the paper collected in the drawer must reconcile against system
 * records at end of day. A voucher with no matching transaction, or a cash total
 * short by an amount with no voucher behind it, is exactly the discrepancy §0
 * rule 3 forbids.
 */

export const VoucherSchema = z.object({
  id: z.string().uuid(),
  transactionId: z.string().uuid(),
  customerId: z.string().uuid(),
  /** Short human-readable code printed on the slip for the cashier to match. */
  code: z.string(),
  /** IQD discounted. Mirrors transaction.discountValue at issue time. */
  value: PositiveIqdAmountSchema,
  /** Recorded per voucher so a later settings change cannot retroactively
   *  reinterpret slips already sitting in the cash drawer. */
  settlementStrategy: SettlementStrategySchema,
  status: VoucherStatusSchema,
  issuedAt: z.string().datetime({ offset: true }),
  redeemedAt: z.string().datetime({ offset: true }).nullable(),
});

export type Voucher = z.infer<typeof VoucherSchema>;

/**
 * What gets printed on the slip (§6.3).
 *
 * The cashier must not need to calculate anything — every figure they need is on
 * the paper. Requiring mental arithmetic at a till with a queue is how errors and
 * cash discrepancies happen.
 */
export const DiscountSlipSchema = z.object({
  voucherCode: z.string(),
  invoiceId: z.string(),
  customerName: z.string(),
  amountBefore: PositiveIqdAmountSchema,
  discountLabel: z.string(),
  discountValue: PositiveIqdAmountSchema,
  amountAfter: PositiveIqdAmountSchema,
  issuedAt: z.string().datetime({ offset: true }),
  /** The instruction the cashier acts on, pre-phrased. */
  cashierInstruction: z.string(),
});

export type DiscountSlip = z.infer<typeof DiscountSlipSchema>;

export const RedeemVoucherRequestSchema = z
  .object({
    /** Device-generated, so a retry after a dropped response is not a second redemption. */
    idempotencyKey: z.string().uuid().optional(),
  })
  .strict();

export type RedeemVoucherRequest = z.infer<typeof RedeemVoucherRequestSchema>;

/** End-of-day reconciliation totals, gated by the voucher_reconciliation flag. */
export const VoucherReconciliationSchema = z.object({
  date: z.string(),
  issuedCount: z.number().int().min(0),
  issuedValue: z.number().int().min(0),
  redeemedCount: z.number().int().min(0),
  redeemedValue: z.number().int().min(0),
  voidCount: z.number().int().min(0),
  /** Issued but never redeemed — slips the cashier should be holding but is not. */
  outstandingCount: z.number().int().min(0),
  outstandingValue: z.number().int().min(0),
  settlementStrategy: SettlementStrategySchema,
});

export type VoucherReconciliation = z.infer<typeof VoucherReconciliationSchema>;
