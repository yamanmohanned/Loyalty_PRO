import { describe, expect, it } from 'vitest';
import {
  CapturedInvoiceSchema,
  IqdAmountSchema,
  UpdateDiscountRulesRequestSchema,
  localDateKey,
  localDayBounds,
  formatIqd,
  formatPhoneLocal,
  isInPathCaptureMode,
  isSyncItemSettled,
  normalizePhone,
  PREFERRED_CAPTURE_MODE,
} from '../index';

/**
 * Contract tests for the v3 shared types.
 *
 * These matter more under SQLite than they did under PostgreSQL: the database no
 * longer enforces enums, so these schemas are the only thing standing between a
 * typo and a corrupt row.
 */

describe('money', () => {
  it('rejects floats — money is never a float (§5.4)', () => {
    expect(IqdAmountSchema.safeParse(85_000).success).toBe(true);
    expect(IqdAmountSchema.safeParse(850.5).success).toBe(false);
    expect(IqdAmountSchema.safeParse(-1).success).toBe(false);
  });

  it('formats whole dinars with the IQD suffix', () => {
    expect(formatIqd(85_000)).toBe('85,000 د.ع');
    expect(formatIqd(85_000, { withSuffix: false })).toBe('85,000');
  });
});

describe('phone normalization', () => {
  it('maps every shape a human types onto one E.164 value', () => {
    const expected = '+9647701234567';
    for (const input of [
      '07701234567',
      '7701234567',
      '+9647701234567',
      '009647701234567',
      '0770 123 4567',
      '0770-123-4567',
    ]) {
      expect(normalizePhone(input), `input: ${input}`).toBe(expected);
    }
  });

  it('rejects numbers that cannot be Iraqi mobiles', () => {
    for (const input of ['123', '0123456789', '+15551234567', 'abc', '']) {
      expect(normalizePhone(input), `input: ${input}`).toBeNull();
    }
  });

  it('renders E.164 back to the local form', () => {
    expect(formatPhoneLocal('+9647701234567')).toBe('0770 123 4567');
  });
});

describe('local day boundaries (§12.23)', () => {
  const timeZone = 'Asia/Baghdad';

  /**
   * The period-key tests that used to live here are gone with the model (v4 §10.6).
   * What they were really protecting was the timezone property, and that property
   * still governs end-of-day voucher reconciliation — so it is still under test,
   * pointed at the function that still uses it.
   */

  it('starts a day at LOCAL midnight, not UTC midnight', () => {
    // Baghdad is UTC+3, so 1 September begins at 21:00 UTC on 31 August.
    const { start } = localDayBounds('2026-09-01', timeZone);
    expect(start.toISOString()).toBe('2026-08-31T21:00:00.000Z');
  });

  it('files a late-night sale under the LOCAL day, not the UTC one', () => {
    // 22:00 UTC on 31 August is already 01:00 on 1 September in Baghdad. Bucketing
    // it in UTC files a voucher under the previous day, and a reconciliation report
    // that disagrees with the drawer by a day of vouchers sends somebody looking
    // for a theft that did not happen.
    expect(localDateKey(new Date('2026-08-31T22:00:00Z'), timeZone)).toBe('2026-09-01');
  });

  it('spans exactly 24 hours in a zone with no DST', () => {
    const { start, end } = localDayBounds('2026-09-01', timeZone);
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('rolls over a month end', () => {
    const { end } = localDayBounds('2026-01-31', timeZone);
    expect(localDateKey(end, timeZone)).toBe('2026-02-01');
  });

  it('is deterministic — station and server must agree', () => {
    const at = new Date('2026-08-24T10:42:00Z');
    expect(localDateKey(at, timeZone)).toBe(localDateKey(at, timeZone));
  });
});

describe('captured invoice contract (§4)', () => {
  const valid = {
    invoice_id: 'INV-9824',
    amount_gross: 85_000,
    currency: 'IQD',
    branch_id: 'BAG-01',
    occurred_at: '2026-08-24T10:42:00Z',
    captured_at: '2026-08-24T10:42:03Z',
    capture_mode: 'SPOOL_WATCH',
  };

  it('accepts what the agent sends', () => {
    expect(CapturedInvoiceSchema.safeParse(valid).success).toBe(true);
  });

  it('carries no customer identifier — nobody is known at capture time', () => {
    // The central v3 change: the receipt prints before the customer reaches the
    // station, and most shoppers are not enrolled at all.
    const withCustomer = { ...valid, customer_identifier: '07701234567' };
    expect(CapturedInvoiceSchema.safeParse(withCustomer).success).toBe(false);
  });

  it('rejects unknown fields rather than dropping them silently', () => {
    expect(CapturedInvoiceSchema.safeParse({ ...valid, sneaky_total: 1 }).success).toBe(false);
  });

  it('rejects a zero or float gross amount', () => {
    expect(CapturedInvoiceSchema.safeParse({ ...valid, amount_gross: 0 }).success).toBe(false);
    expect(CapturedInvoiceSchema.safeParse({ ...valid, amount_gross: 85_000.5 }).success).toBe(false);
  });

  it('rejects a capture mode that is not one of the four plus manual', () => {
    expect(CapturedInvoiceSchema.safeParse({ ...valid, capture_mode: 'USB_FILTER' }).success).toBe(false);
  });
});

describe('capture modes and the Fail-Open distinction (§4.6)', () => {
  it('prefers the one mode that cannot block printing', () => {
    expect(PREFERRED_CAPTURE_MODE).toBe('SPOOL_WATCH');
    expect(isInPathCaptureMode('SPOOL_WATCH')).toBe(false);
  });

  it('marks the three in-path modes as in-path', () => {
    // These sit in the print path: if the agent process is dead there is no code to
    // forward with. They need forward-first handling and a watchdog.
    for (const mode of ['VIRTUAL_PRINTER', 'SERIAL_BRIDGE', 'NETWORK_PROXY'] as const) {
      expect(isInPathCaptureMode(mode), mode).toBe(true);
    }
  });
});

describe('discount rule ladder validation', () => {
  it('accepts an ascending ladder', () => {
    const result = UpdateDiscountRulesRequestSchema.safeParse({
      rules: [
        { thresholdAmount: 25_000, discountType: 'PERCENTAGE', discountRate: 2 },
        { thresholdAmount: 75_000, discountType: 'PERCENTAGE', discountRate: 3 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a ladder where more spend earns less', () => {
    const result = UpdateDiscountRulesRequestSchema.safeParse({
      rules: [
        { thresholdAmount: 25_000, discountType: 'PERCENTAGE', discountRate: 3 },
        { thresholdAmount: 75_000, discountType: 'PERCENTAGE', discountRate: 2 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate thresholds — which rule applies would be ambiguous', () => {
    const result = UpdateDiscountRulesRequestSchema.safeParse({
      rules: [
        { thresholdAmount: 25_000, discountType: 'PERCENTAGE', discountRate: 2 },
        { thresholdAmount: 25_000, discountType: 'PERCENTAGE', discountRate: 3 },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe('sync queue semantics', () => {
  it('treats DUPLICATE as settled so the device clears it', () => {
    expect(isSyncItemSettled('APPLIED')).toBe(true);
    expect(isSyncItemSettled('DUPLICATE')).toBe(true);
    expect(isSyncItemSettled('REJECTED')).toBe(true);
    // Only a transient failure stays queued for retry.
    expect(isSyncItemSettled('FAILED')).toBe(false);
  });
});
