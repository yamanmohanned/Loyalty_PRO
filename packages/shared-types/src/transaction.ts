import { z } from 'zod';
import { CouponSchema } from './coupon';
import { CustomerBalanceSchema } from './customer';
import { AmountCaptureSchema, InvoiceSourceSchema } from './enums';
import { NormalizedInvoiceSchema } from './invoice';
import { PositiveIqdAmountSchema } from './money';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE CORE LOOP — linking an invoice to a customer
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two invariants this DTO exists to protect (CLAUDE.md §0.1, §0.2):
 *
 *  1. `customerId` is REQUIRED and non-nullable. Identity is captured before the
 *     invoice, always. There is deliberately no shape of this request that expresses
 *     "an invoice with no customer" — the loop order is enforced by the type, not
 *     only by a UI guard that a future refactor could route around.
 *
 *  2. (merchant, branch, invoice_id) is the idempotency key. A replay returns 409
 *     carrying the transaction that already exists, so the assistant can show the
 *     customer it was linked to rather than a bare failure.
 */

export const LinkTransactionRequestSchema = z
  .object({
    /** The resolved customer. Never optional — see invariant 1 above. */
    customerId: z.string().uuid('معرّف الزبون غير صالح'),
    /** The Normalized Invoice Schema, verbatim (CLAUDE.md §2.3). */
    invoice: NormalizedInvoiceSchema,
    /**
     * Client-generated id for this link attempt, so a retry after a dropped response
     * is recognised as the same attempt. Distinct from the invoice idempotency key:
     * this one guards the network, that one guards the business rule.
     */
    idempotencyKey: z.string().uuid().optional(),
    /** Which device performed the link — for the audit trail, not for authorisation. */
    deviceId: z.string().trim().max(128).optional(),
  })
  .strict();

export type LinkTransactionRequest = z.infer<typeof LinkTransactionRequestSchema>;

export const TransactionSchema = z.object({
  id: z.string().uuid(),
  customerId: z.string().uuid(),
  branchId: z.string().uuid(),
  branchCode: z.string(),
  invoiceId: z.string(),
  amount: PositiveIqdAmountSchema,
  currency: z.literal('IQD'),
  occurredAt: z.string().datetime({ offset: true }),
  source: InvoiceSourceSchema,
  amountCapture: AmountCaptureSchema,
  linkedByUserId: z.string().uuid(),
  createdAt: z.string().datetime({ offset: true }),
});

export type Transaction = z.infer<typeof TransactionSchema>;

/**
 * The response the assistant renders on the success screen: what was linked, where
 * the customer now stands, and whether that purchase just earned something.
 */
export const LinkTransactionResponseSchema = z.object({
  transaction: TransactionSchema,
  /** Cumulative balance for the active period, recomputed after this link. */
  balance: CustomerBalanceSchema,
  /**
   * The coupon this transaction just earned, if it crossed a threshold. Null on the
   * ordinary path — most links earn nothing, and that is the quiet case.
   */
  issuedCoupon: CouponSchema.nullable(),
  /**
   * A previously ACTIVE coupon that this higher tier superseded, if any. Customers
   * hold at most one earned coupon per period; crossing a better tier replaces the
   * lesser one rather than stacking discounts.
   */
  supersededCoupon: CouponSchema.nullable(),
});

export type LinkTransactionResponse = z.infer<typeof LinkTransactionResponseSchema>;

/** Payload carried in a 409 DUPLICATE_INVOICE error — the link that already exists. */
export const DuplicateInvoiceDetailsSchema = z.object({
  existingTransaction: TransactionSchema,
  /** Who it was linked to, so the assistant can say "already linked to حسين علي". */
  customerName: z.string(),
  linkedAt: z.string().datetime({ offset: true }),
});

export type DuplicateInvoiceDetails = z.infer<typeof DuplicateInvoiceDetailsSchema>;

export const TransactionListQuerySchema = z
  .object({
    customerId: z.string().uuid().optional(),
    branchId: z.string().uuid().optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export type TransactionListQuery = z.infer<typeof TransactionListQuerySchema>;
