import { describe, expect, it } from 'vitest';
import {
  INVOICE_BARCODE_PARSERS,
  delimitedInvoiceParser,
  invoiceNumberParser,
  parseInvoiceBarcode,
} from '../index';

/**
 * The payloads here are the ones actually encoded into the reference receipts in
 * `design/receipts/`, and `verify-barcode.mjs` proves those symbols decode back
 * to exactly these strings from the rendered pixels. So these tests are pinned to
 * a real, scannable artifact rather than to an assumption.
 */

describe('invoice-number-only parser (the likely real format)', () => {
  it('reads the document number and leaves the amount for manual entry', () => {
    const result = parseInvoiceBarcode('INV-9824');
    expect(result).not.toBeNull();
    expect(result?.invoiceId).toBe('INV-9824');
    // null is the correct, expected outcome — it routes to manual entry (§6.7 #2).
    expect(result?.amount).toBeNull();
  });

  it('survives the control characters scanners append as an "enter" key', () => {
    for (const raw of ['INV-9824\r\n', '\tINV-9824\t', 'INV-9824\n', '  INV-9824  ']) {
      expect(parseInvoiceBarcode(raw)?.invoiceId, `raw: ${JSON.stringify(raw)}`).toBe('INV-9824');
    }
  });

  it('keeps the hyphen — stripping punctuation would corrupt the number', () => {
    expect(parseInvoiceBarcode('INV-9824')?.invoiceId).toBe('INV-9824');
    expect(parseInvoiceBarcode('9824')?.invoiceId).toBe('9824');
    expect(parseInvoiceBarcode('BAG-01/9824')?.invoiceId).toBe('BAG-01/9824');
  });

  it('preserves the raw payload for diagnostics', () => {
    expect(parseInvoiceBarcode('INV-9824\r\n')?.raw).toBe('INV-9824\r\n');
  });
});

describe('pipe-delimited parser (auto-capture path)', () => {
  it('reads both the document number and the amount', () => {
    const result = parseInvoiceBarcode('INV-9824|85000');
    expect(result?.invoiceId).toBe('INV-9824');
    expect(result?.amount).toBe(85000);
  });

  it('ignores trailing fields it does not need', () => {
    const result = parseInvoiceBarcode('INV-9824|85000|BAG-01');
    expect(result?.invoiceId).toBe('INV-9824');
    expect(result?.amount).toBe(85000);
  });

  it('falls back to manual entry rather than trusting a doubtful amount', () => {
    // A partial read beats a refused scan, and beats a wrong balance even more.
    for (const raw of [
      'INV-9824|',
      'INV-9824|abc',
      'INV-9824|85.50', // money is never a float (CLAUDE.md §4.2)
      'INV-9824|-500',
      'INV-9824|0',
      'INV-9824|99999999999', // beyond the documented Int bound
    ]) {
      const result = parseInvoiceBarcode(raw);
      expect(result?.invoiceId, `raw: ${raw}`).toBe('INV-9824');
      expect(result?.amount, `raw: ${raw}`).toBeNull();
    }
  });
});

describe('parser selection', () => {
  it('offers the delimited payload to the delimited parser first', () => {
    // Registration order matters: the bare-number parser rejects delimiters, so
    // if it ran first the composite format would simply never be recognised.
    expect(INVOICE_BARCODE_PARSERS[0]).toBe(delimitedInvoiceParser);
    expect(INVOICE_BARCODE_PARSERS[1]).toBe(invoiceNumberParser);

    expect(delimitedInvoiceParser.canParse('INV-9824|85000')).toBe(true);
    expect(invoiceNumberParser.canParse('INV-9824|85000')).toBe(false);
  });

  it('returns null for payloads no parser recognises', () => {
    // The UI shows "unreadable — type the number" rather than raising an error.
    for (const raw of ['', '   ', '!!!', 'INV 9824', 'a'.repeat(100)]) {
      expect(parseInvoiceBarcode(raw), `raw: ${JSON.stringify(raw)}`).toBeNull();
    }
  });

  it('never returns a non-integer or negative amount', () => {
    const samples = ['INV-1|85000', 'INV-2|1', 'INV-3|2147483647', 'INV-4|abc'];
    for (const raw of samples) {
      const amount = parseInvoiceBarcode(raw)?.amount;
      if (amount !== null && amount !== undefined) {
        expect(Number.isInteger(amount), `raw: ${raw}`).toBe(true);
        expect(amount, `raw: ${raw}`).toBeGreaterThan(0);
      }
    }
  });
});
