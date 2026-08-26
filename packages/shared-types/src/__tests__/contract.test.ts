import { describe, expect, it } from 'vitest';
import {
  IqdAmountSchema,
  NormalizedInvoiceSchema,
  computePeriodKey,
  formatIqd,
  formatPhoneLocal,
  normalizePhone,
  toAmountCapture,
  toInvoiceSource,
  toInvoiceSourceWire,
  isSyncItemSettled,
  UpdateRuleSetRequestSchema,
} from '../index';

describe('money', () => {
  it('rejects floats — money is never a float (CLAUDE.md §4.2)', () => {
    expect(IqdAmountSchema.safeParse(85000).success).toBe(true);
    expect(IqdAmountSchema.safeParse(850.5).success).toBe(false);
    expect(IqdAmountSchema.safeParse(-1).success).toBe(false);
  });

  it('formats whole dinars with the IQD suffix', () => {
    expect(formatIqd(85000)).toBe('85,000 د.ع');
    expect(formatIqd(85000, { withSuffix: false })).toBe('85,000');
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
      '+964 770 123 4567',
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

describe('period keys', () => {
  const timeZone = 'Asia/Baghdad';

  it('buckets by calendar month in the merchant timezone', () => {
    const key = computePeriodKey({
      periodType: 'MONTHLY',
      occurredAt: new Date('2026-08-24T10:42:00Z'),
      timeZone,
    });
    expect(key).toBe('2026-08');
  });

  it('files a late-night purchase under the LOCAL month, not the UTC one', () => {
    // 2026-08-31T22:00Z is already 01:00 on 1 September in Baghdad (UTC+3).
    // Computing this in UTC would credit it to the wrong period and break the reset.
    const key = computePeriodKey({
      periodType: 'MONTHLY',
      occurredAt: new Date('2026-08-31T22:00:00Z'),
      timeZone,
    });
    expect(key).toBe('2026-09');
  });

  it('produces ISO week keys for weekly rule sets', () => {
    const key = computePeriodKey({
      periodType: 'WEEKLY',
      occurredAt: new Date('2026-08-24T10:42:00Z'),
      timeZone,
    });
    expect(key).toMatch(/^\d{4}-W\d{2}$/);
  });

  it('is deterministic — device and server must agree', () => {
    const at = new Date('2026-08-24T10:42:00Z');
    const a = computePeriodKey({ periodType: 'MONTHLY', occurredAt: at, timeZone });
    const b = computePeriodKey({ periodType: 'MONTHLY', occurredAt: at, timeZone });
    expect(a).toBe(b);
  });

  it('requires bounds for a custom period', () => {
    expect(() =>
      computePeriodKey({ periodType: 'CUSTOM', occurredAt: new Date(), timeZone }),
    ).toThrow();
  });
});

describe('normalized invoice schema', () => {
  const valid = {
    invoice_id: 'INV-9824',
    amount: 85000,
    currency: 'IQD',
    branch_id: 'BAG-01',
    customer_identifier: '07701234567',
    occurred_at: '2026-08-24T10:42:00Z',
    source: 'scan',
    amount_capture: 'auto',
  };

  it('accepts the contract exactly as specified in CLAUDE.md §2.3', () => {
    expect(NormalizedInvoiceSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects unknown fields rather than silently dropping them (§7.4)', () => {
    const result = NormalizedInvoiceSchema.safeParse({ ...valid, sneaky_total: 1 });
    expect(result.success).toBe(false);
  });

  it('rejects a zero or negative invoice amount', () => {
    expect(NormalizedInvoiceSchema.safeParse({ ...valid, amount: 0 }).success).toBe(false);
  });
});

describe('wire ⇄ db enum mapping', () => {
  it('round-trips without drift', () => {
    expect(toInvoiceSource('db_agent')).toBe('DB_AGENT');
    expect(toInvoiceSourceWire('DB_AGENT')).toBe('db_agent');
    expect(toAmountCapture('manual')).toBe('MANUAL');
  });
});

describe('rule ladder validation', () => {
  const base = { periodType: 'MONTHLY' as const };

  it('accepts an ascending ladder', () => {
    const result = UpdateRuleSetRequestSchema.safeParse({
      ...base,
      tiers: [
        { thresholdAmount: 100_000, discountPct: 5, couponValidityDays: 30 },
        { thresholdAmount: 250_000, discountPct: 10, couponValidityDays: 30 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a ladder where more spend earns a smaller discount', () => {
    const result = UpdateRuleSetRequestSchema.safeParse({
      ...base,
      tiers: [
        { thresholdAmount: 100_000, discountPct: 10, couponValidityDays: 30 },
        { thresholdAmount: 250_000, discountPct: 5, couponValidityDays: 30 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate thresholds — "next tier" would be ambiguous', () => {
    const result = UpdateRuleSetRequestSchema.safeParse({
      ...base,
      tiers: [
        { thresholdAmount: 100_000, discountPct: 5, couponValidityDays: 30 },
        { thresholdAmount: 100_000, discountPct: 10, couponValidityDays: 30 },
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
