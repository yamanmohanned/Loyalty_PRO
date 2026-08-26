import { z } from 'zod';
import { AmountCaptureWireSchema, InvoiceSourceWireSchema } from './enums';
import { CurrencySchema, PositiveIqdAmountSchema } from './money';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE NORMALIZED INVOICE SCHEMA — CLAUDE.md §2.3
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every invoice source MUST emit this shape before entering the loyalty core.
 * The core does not know, and must never learn, how an invoice arrived: scanning
 * today (Tier 3 / Universal Mode), an accounting API or a local DB agent later.
 * That is the whole point of the Integration Gateway — sources are interchangeable
 * at the edges because they all narrow to this one object.
 *
 * This definition lives here and ONLY here. Web, mobile and backend import it.
 */

/**
 * The merchant's own invoice number, as printed on the receipt.
 * Together with (merchant_id, branch_id) this is the idempotency key — the single
 * value standing between the system and a double-credited customer (CLAUDE.md §0.2).
 */
export const InvoiceIdSchema = z
  .string()
  .trim()
  .min(1, 'رقم الفاتورة مطلوب')
  .max(64, 'رقم الفاتورة طويل جداً')
  // Printed barcodes yield alphanumerics, dashes, underscores and slashes.
  .regex(/^[A-Za-z0-9_\-/]+$/, 'رقم الفاتورة يحتوي على رموز غير مسموحة');

export type InvoiceId = z.infer<typeof InvoiceIdSchema>;

/** Branch code as printed/configured, e.g. `BAG-01`. */
export const BranchCodeSchema = z
  .string()
  .trim()
  .min(1, 'رمز الفرع مطلوب')
  .max(32)
  .regex(/^[A-Za-z0-9_-]+$/, 'رمز الفرع يحتوي على رموز غير مسموحة');

/**
 * The Normalized Invoice Schema.
 *
 * `.strict()` — unknown fields are rejected, not ignored (CLAUDE.md §7.4). A source
 * that starts sending an extra field should fail loudly at the gateway rather than
 * have that field silently dropped on the floor.
 */
export const NormalizedInvoiceSchema = z
  .object({
    /** Merchant's printed invoice number. */
    invoice_id: InvoiceIdSchema,
    /** Whole Iraqi Dinars. Integer — never a float (CLAUDE.md §4.2). */
    amount: PositiveIqdAmountSchema,
    currency: CurrencySchema,
    /** Branch code the sale happened at. */
    branch_id: BranchCodeSchema,
    /**
     * How the customer was identified — a signed QR token or a phone number.
     * Resolved server-side; the core never trusts this as an identity by itself.
     */
    customer_identifier: z.string().trim().min(1, 'معرّف الزبون مطلوب').max(256),
    /** When the purchase happened, ISO-8601 UTC. */
    occurred_at: z.string().datetime({ offset: true }),
    /** Which tier of the Integration Gateway produced this invoice. */
    source: InvoiceSourceWireSchema,
    /** Whether the amount was read from the barcode or typed by a human. */
    amount_capture: AmountCaptureWireSchema,
  })
  .strict();

export type NormalizedInvoice = z.infer<typeof NormalizedInvoiceSchema>;

/**
 * Result of parsing a scanned invoice barcode.
 *
 * The merchant's register encoding is not yet known (no sample receipt as of
 * 2026-08-24), so parsing is pluggable: a parser returns the invoice number always,
 * and the amount only when the symbology actually carries it. When `amount` is null
 * the assistant app falls back to manual entry — which is why the invoice screen
 * must render both states (CLAUDE.md §6.7 #2).
 */
export interface ParsedInvoiceBarcode {
  invoiceId: InvoiceId;
  /** Whole IQD when the barcode encodes it; `null` forces manual entry. */
  amount: number | null;
  /** Raw scanned payload, retained for diagnostics when a parse looks wrong. */
  raw: string;
}

/**
 * Contract every barcode parser implements. Registering a new merchant's format
 * means adding one of these — no change to the core loop.
 */
export interface InvoiceBarcodeParser {
  /** Stable identifier, e.g. `default-code128`. */
  readonly id: string;
  /** Cheap check so the scanner can pick a parser without throwing. */
  canParse(raw: string): boolean;
  parse(raw: string): ParsedInvoiceBarcode;
}
