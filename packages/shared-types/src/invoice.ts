import { z } from 'zod';
import { CaptureModeSchema } from './enums';
import { CurrencySchema, PositiveIqdAmountSchema } from './money';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE CAPTURED INVOICE CONTRACT — CLAUDE_v3.md §4
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Successor to v1's Normalized Invoice Schema. The Integration Gateway concept
 * survives intact — every source narrows to one shape before entering the core —
 * but the source changed: invoices now arrive from the **Print Capture Agent**
 * intercepting a print job, not from an assistant scanning a barcode.
 *
 * **The one structural difference, and it drives everything downstream:** there is
 * no `customer_identifier`. At capture time nobody knows who the customer is — the
 * receipt has just printed and the customer has not yet reached the Loyalty
 * Station. Many invoices will never be attributed at all, because the shopper is
 * not enrolled. An unattributed invoice is therefore a normal row, not an error,
 * which is why `transaction.customerId` is nullable.
 *
 * The loyalty core still does not care how an invoice arrived. Today that is the
 * agent; a future accounting-API integration would emit this same shape.
 */

/**
 * The merchant's own invoice number, as printed on the receipt.
 * With (merchant, branch) this is the idempotency key — the value standing between
 * an agent network retry and a double-counted sale (§4.8).
 */
export const InvoiceIdSchema = z
  .string()
  .trim()
  .min(1, 'رقم الفاتورة مطلوب')
  .max(64, 'رقم الفاتورة طويل جداً')
  .regex(/^[A-Za-z0-9_\-/]+$/, 'رقم الفاتورة يحتوي على رموز غير مسموحة');

export type InvoiceId = z.infer<typeof InvoiceIdSchema>;

/** Branch code as printed or configured, e.g. `BAG-01`. */
export const BranchCodeSchema = z
  .string()
  .trim()
  .min(1, 'رمز الفرع مطلوب')
  .max(32)
  .regex(/^[A-Za-z0-9_-]+$/, 'رمز الفرع يحتوي على رموز غير مسموحة');

/**
 * What the Print Capture Agent sends to the API.
 *
 * `.strict()` — unknown fields are rejected, not ignored. An agent that starts
 * sending an extra field should fail loudly at the gateway rather than have it
 * silently dropped.
 */
export const CapturedInvoiceSchema = z
  .object({
    invoice_id: InvoiceIdSchema,
    /** The invoice total exactly as the POS recorded it. Whole IQD, never a float. */
    amount_gross: PositiveIqdAmountSchema,
    currency: CurrencySchema,
    branch_id: BranchCodeSchema,
    /** When the POS printed the receipt, ISO-8601 UTC. */
    occurred_at: z.string().datetime({ offset: true }),
    /** When the agent intercepted the print job. */
    captured_at: z.string().datetime({ offset: true }),
    capture_mode: CaptureModeSchema,
    /**
     * Client-generated id for this delivery attempt. An agent that retries after a
     * dropped response reuses it, so the retry is recognised as the same capture.
     */
    idempotency_key: z.string().uuid().optional(),
    /**
     * The decoded receipt text the values were parsed from. Retained only when the
     * merchant enables diagnostics — it is useful for tuning a parsing template and
     * for the calibration flow (§4.7), but it is receipt content and should not be
     * stored indefinitely by default.
     */
    raw_text: z.string().max(8192).optional(),
  })
  .strict();

export type CapturedInvoice = z.infer<typeof CapturedInvoiceSchema>;

/**
 * Result of parsing captured print data.
 *
 * Two rules bind every parser, carried forward from the v1 barcode work because
 * they proved correct and the reasoning did not change:
 *
 *  1. **The invoice number is mandatory; the amount is not.** `amountGross: null`
 *     is a normal result that routes to manual entry, not a failure.
 *  2. **A doubtful amount is worse than no amount.** A wrong figure silently
 *     corrupts a customer's balance and, worse under v3, could grant a discount
 *     against a total that was never charged. Never guess.
 */
export interface ParsedReceipt {
  invoiceId: InvoiceId;
  /** Whole IQD when the receipt yields it confidently; null forces manual entry. */
  amountGross: number | null;
  /** The decoded text the values came from, for diagnostics and calibration. */
  raw: string;
}

/**
 * Contract every receipt parser implements. Supporting a new merchant's POS means
 * adding a template, not a project — which is the point of keeping parsing
 * external to the code (§4.5 #3).
 */
export interface ReceiptParser {
  /** Stable identifier, e.g. `al-bayan-default`. */
  readonly id: string;
  /** Cheap check so the agent can pick a parser without throwing. */
  canParse(raw: string): boolean;
  parse(raw: string): ParsedReceipt;
}
