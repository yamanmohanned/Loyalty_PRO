import { InvoiceIdSchema, type ParsedReceipt, type ReceiptParser } from './invoice';
import { MAX_IQD } from './money';

/**
 * Invoice barcode parsers.
 *
 * ⚠ The merchant's real register encoding is still UNCONFIRMED (CLAUDE.md §13.6).
 * These parsers are written against a reconstructed reference receipt in
 * `design/receipts/`, not a real one. When a real receipt arrives, the likely
 * outcome is that one of these already matches — and if not, adding the real
 * format means writing one more parser here and changing nothing else.
 *
 * Two rules every parser must honour:
 *
 *  1. **The invoice number is mandatory; the amount is not.** Returning
 *     `amountGross: null` is a normal, expected result — it routes the assistant to
 *     manual entry, which is why the invoice screen renders both states
 *     (CLAUDE.md §6.7 #2).
 *  2. **A doubtful amount is worse than no amount.** If the amount cannot be
 *     validated with confidence, return `null` for it rather than guessing. A
 *     wrong amount silently corrupts a customer's balance; a null one merely
 *     asks the assistant to type four digits.
 */

/** Strips the wrapping whitespace and control characters scanners like to append. */
function clean(raw: string): string {
  // Scanners commonly terminate a scan with CR, LF or a tab, acting as an "enter"
  // key. Strip C0/C1 control characters only — never punctuation, since the hyphen
  // in "INV-9824" is part of the document number.
  // eslint-disable-next-line no-control-regex -- matching control characters is the entire point
  return raw.replace(/[\u0000-\u001F\u007F]/g, '').trim();
}

/**
 * Validates a candidate amount read from a symbology.
 * Returns null for anything not a plainly sane whole-dinar figure.
 */
function coerceAmount(candidate: string): number | null {
  if (!/^\d{1,10}$/.test(candidate)) return null;
  const value = Number.parseInt(candidate, 10);
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_IQD) return null;
  return value;
}

/**
 * The default and most likely format: the printed document number alone,
 * as Code 128 Set B. Retail POS software overwhelmingly does exactly this.
 *
 * Amount is always null — the symbology simply does not carry it.
 */
export const invoiceNumberParser: ReceiptParser = {
  id: 'invoice-number-only',

  canParse(raw: string): boolean {
    const value = clean(raw);
    // Must look like a document number and must NOT contain a delimiter, or the
    // delimited parser would never get a chance at it.
    return value.length > 0 && !value.includes('|') && InvoiceIdSchema.safeParse(value).success;
  },

  parse(raw: string): ParsedReceipt {
    const value = clean(raw);
    return {
      invoiceId: InvoiceIdSchema.parse(value),
      amountGross: null,
      raw,
    };
  },
};

/**
 * A pipe-delimited composite, for a register configured to append the total
 * (and optionally the branch code) to the symbol:
 *
 *     INV-9824|85000
 *     INV-9824|85000|BAG-01
 *
 * This is the path that makes auto-capture real. If the amount field is present
 * but not a clean whole number, the invoice number is still returned and the
 * amount falls back to null — a partial read is better than a refused scan.
 */
export const delimitedInvoiceParser: ReceiptParser = {
  id: 'pipe-delimited',

  canParse(raw: string): boolean {
    const parts = clean(raw).split('|');
    return parts.length >= 2 && InvoiceIdSchema.safeParse(parts[0]).success;
  },

  parse(raw: string): ParsedReceipt {
    const parts = clean(raw).split('|');
    const [invoiceId, amountField] = parts;
    return {
      invoiceId: InvoiceIdSchema.parse(invoiceId),
      amountGross: amountField ? coerceAmount(amountField) : null,
      raw,
    };
  },
};

/**
 * Registered parsers, tried in order. Most specific first: the delimited format
 * must be offered the payload before the bare-number parser, which would
 * otherwise reject it for containing a delimiter.
 */
export const RECEIPT_PARSERS: readonly ReceiptParser[] = [
  delimitedInvoiceParser,
  invoiceNumberParser,
];

/**
 * Parses a scanned payload with the first parser that recognises it.
 * Returns null when no parser matches, which the UI surfaces as "unreadable
 * barcode — enter the invoice number manually" rather than as an error.
 */
export function parseReceipt(
  raw: string,
  parsers: readonly ReceiptParser[] = RECEIPT_PARSERS,
): ParsedReceipt | null {
  for (const parser of parsers) {
    if (!parser.canParse(raw)) continue;
    try {
      return parser.parse(raw);
    } catch {
      // A parser that claimed the payload but then threw is a bug in that parser,
      // not a reason to fail the scan — let the next one try.
      continue;
    }
  }
  return null;
}
