import { describe, expect, it } from 'vitest';
import { assessMargin, computeDiscount, type DiscountComputationInput } from '../index';

/**
 * The instant-discount calculation and its guardrails (CLAUDE_v3.md §2.3).
 *
 * This is the highest-stakes arithmetic in the system. Under the v1 coupon model a
 * mistake cost a discount on a *future* visit that might never happen. Under v3 it
 * comes straight off the basket in front of the cashier, every single time, with no
 * return visit to earn it back.
 *
 * The cap tests below are not edge cases. They are the difference between a
 * loyalty programme and a slow liquidation.
 */

const RULES = [
  { thresholdAmount: 25_000, discountType: 'PERCENTAGE' as const, discountRate: 2, maxDiscountValue: null, isActive: true },
  { thresholdAmount: 75_000, discountType: 'PERCENTAGE' as const, discountRate: 3, maxDiscountValue: null, isActive: true },
];

const base = (over: Partial<DiscountComputationInput> = {}): DiscountComputationInput => ({
  amountGross: 30_000,
  cumulativeAmount: 30_000,
  rules: RULES,
  absoluteMaxDiscountValue: 5_000,
  discountTypeSetting: 'PERCENTAGE',
  ...over,
});

describe('threshold evaluation', () => {
  it('grants nothing below the first threshold', () => {
    const result = computeDiscount(base({ amountGross: 20_000, cumulativeAmount: 20_000 }));
    expect(result.discountValue).toBe(0);
    expect(result.appliedThreshold).toBeNull();
    expect(result.amountNet).toBe(20_000);
  });

  it('grants at exactly the threshold', () => {
    const result = computeDiscount(base({ amountGross: 25_000, cumulativeAmount: 25_000 }));
    expect(result.appliedThreshold).toBe(25_000);
    expect(result.discountValue).toBe(500); // 2% of 25,000
    expect(result.amountNet).toBe(24_500);
  });

  it('applies only the HIGHEST threshold reached', () => {
    // Cumulative spend only grows within a period, so clearing 75,000 necessarily
    // cleared 25,000. Applying both would double-discount one basket.
    const result = computeDiscount(base({ amountGross: 80_000, cumulativeAmount: 80_000 }));
    expect(result.appliedThreshold).toBe(75_000);
    expect(result.discountRate).toBe(3);
  });

  it('uses cumulative spend, not just this basket', () => {
    // A 10,000 basket earns nothing alone, but the customer has already spent
    // 70,000 this period — the discount is on their standing, not this receipt.
    const result = computeDiscount(base({ amountGross: 10_000, cumulativeAmount: 80_000 }));
    expect(result.appliedThreshold).toBe(75_000);
    expect(result.discountValue).toBe(300); // 3% of the 10,000 basket
  });

  it('ignores inactive rules', () => {
    const result = computeDiscount(
      base({
        rules: RULES.map((r) => ({ ...r, isActive: false })),
        cumulativeAmount: 500_000,
      }),
    );
    expect(result.discountValue).toBe(0);
  });

  it('grants nothing when discounting is switched off', () => {
    // NONE leaves capture and reporting running so a merchant can evaluate the
    // programme before committing to a rate.
    const result = computeDiscount(base({ discountTypeSetting: 'NONE', cumulativeAmount: 500_000 }));
    expect(result.discountValue).toBe(0);
    expect(result.discountType).toBe('NONE');
  });
});

describe('the absolute cap — the last line of defence (§2.3)', () => {
  it('caps a large basket that would otherwise give away a fortune', () => {
    // Without the cap: 3% of 500,000 = 15,000 IQD on a basket whose net profit is
    // roughly 15,000 at a 3% margin. The store would work for nothing.
    const result = computeDiscount(
      base({ amountGross: 500_000, cumulativeAmount: 500_000, absoluteMaxDiscountValue: 5_000 }),
    );

    expect(result.uncappedValue).toBe(15_000);
    expect(result.discountValue).toBe(5_000);
    expect(result.wasCapped).toBe(true);
    expect(result.amountNet).toBe(495_000);
  });

  it('caps the pathological case §2.3 names explicitly', () => {
    // A 500,000 basket at 10% gifts away 50,000 IQD. Category exclusions were
    // declined by the merchant, so the cap is the ONLY thing preventing this.
    const result = computeDiscount(
      base({
        amountGross: 500_000,
        cumulativeAmount: 500_000,
        rules: [{ thresholdAmount: 25_000, discountType: 'PERCENTAGE', discountRate: 10, maxDiscountValue: null, isActive: true }],
        absoluteMaxDiscountValue: 5_000,
      }),
    );

    expect(result.uncappedValue).toBe(50_000);
    expect(result.discountValue).toBe(5_000);
  });

  it('honours a tighter per-rule cap over the global one', () => {
    const result = computeDiscount(
      base({
        amountGross: 200_000,
        cumulativeAmount: 200_000,
        rules: [{ thresholdAmount: 25_000, discountType: 'PERCENTAGE', discountRate: 3, maxDiscountValue: 2_000, isActive: true }],
        absoluteMaxDiscountValue: 5_000,
      }),
    );
    expect(result.discountValue).toBe(2_000);
  });

  it('still applies the global cap when the per-rule cap is looser', () => {
    // A per-rule cap must never be able to escape the settings-level ceiling.
    const result = computeDiscount(
      base({
        amountGross: 500_000,
        cumulativeAmount: 500_000,
        rules: [{ thresholdAmount: 25_000, discountType: 'PERCENTAGE', discountRate: 10, maxDiscountValue: 40_000, isActive: true }],
        absoluteMaxDiscountValue: 5_000,
      }),
    );
    expect(result.discountValue).toBe(5_000);
  });

  it('never discounts more than the basket itself', () => {
    // A discount exceeding the total would turn a sale into a payout.
    const result = computeDiscount(
      base({
        amountGross: 3_000,
        cumulativeAmount: 500_000,
        rules: [{ thresholdAmount: 1_000, discountType: 'FIXED_AMOUNT', discountRate: 10_000, maxDiscountValue: null, isActive: true }],
        absoluteMaxDiscountValue: 50_000,
      }),
    );
    expect(result.discountValue).toBe(3_000);
    expect(result.amountNet).toBe(0);
  });

  it('never produces a negative discount or net', () => {
    for (const gross of [1, 100, 25_000, 999_999]) {
      const result = computeDiscount(base({ amountGross: gross, cumulativeAmount: 500_000 }));
      expect(result.discountValue, `gross ${gross}`).toBeGreaterThanOrEqual(0);
      expect(result.amountNet, `gross ${gross}`).toBeGreaterThanOrEqual(0);
      expect(result.amountNet).toBe(gross - result.discountValue);
    }
  });
});

describe('fixed-amount discounts', () => {
  it('grants the flat value regardless of basket size', () => {
    const result = computeDiscount(
      base({
        amountGross: 60_000,
        cumulativeAmount: 60_000,
        rules: [{ thresholdAmount: 25_000, discountType: 'FIXED_AMOUNT', discountRate: 1_500, maxDiscountValue: null, isActive: true }],
        discountTypeSetting: 'FIXED_AMOUNT',
      }),
    );
    expect(result.discountValue).toBe(1_500);
    expect(result.amountNet).toBe(58_500);
  });
});

describe('money stays integral', () => {
  it('floors percentage arithmetic rather than producing fractions of a dinar', () => {
    // 3% of 33,333 = 999.99. There is no such thing as a fraction of a dinar.
    const result = computeDiscount(
      base({ amountGross: 33_333, cumulativeAmount: 100_000, absoluteMaxDiscountValue: 50_000 }),
    );
    expect(Number.isInteger(result.discountValue)).toBe(true);
    expect(result.discountValue).toBe(999);
  });

  it('rounds in the merchant’s favour, never the customer’s', () => {
    // Flooring means the store never gives away a dinar it did not intend to.
    const result = computeDiscount(
      base({ amountGross: 10_099, cumulativeAmount: 100_000, absoluteMaxDiscountValue: 50_000 }),
    );
    expect(result.discountValue).toBe(302); // 3% = 302.97 → 302
  });
});

describe('margin warning (§2.3)', () => {
  it('fires when the discount exceeds estimated net profit', () => {
    // The worked example from §2.3: 10% on a 25,000 basket is 2,500 IQD against
    // roughly 750 IQD of profit — the sale loses about 1,750.
    const assessment = assessMargin({
      thresholdAmount: 25_000,
      discountType: 'PERCENTAGE',
      discountRate: 10,
      absoluteMaxDiscountValue: 100_000,
      assumedNetMarginPct: 3,
    });

    expect(assessment.exceedsProfit).toBe(true);
    expect(assessment.discountAtThreshold).toBe(2_500);
    expect(assessment.estimatedNetProfit).toBe(750);
    expect(assessment.warning).toContain('أعلى من الربح الصافي');
  });

  it('stays quiet inside the recommended band', () => {
    const assessment = assessMargin({
      thresholdAmount: 25_000,
      discountType: 'PERCENTAGE',
      discountRate: 2,
      absoluteMaxDiscountValue: 5_000,
    });
    expect(assessment.exceedsProfit).toBe(false);
    expect(assessment.outsideSafeBand).toBe(false);
    expect(assessment.warning).toBeNull();
  });

  it('flags a rate outside the safe band even when it does not exceed profit', () => {
    const assessment = assessMargin({
      thresholdAmount: 1_000_000,
      discountType: 'PERCENTAGE',
      discountRate: 5,
      absoluteMaxDiscountValue: 5_000,
    });
    expect(assessment.outsideSafeBand).toBe(true);
    expect(assessment.warning).toContain('النطاق الآمن');
  });

  it('accounts for the cap when assessing', () => {
    // A frightening-looking rate is safe if the cap holds it down; warning on it
    // anyway would teach the manager to ignore warnings.
    const assessment = assessMargin({
      thresholdAmount: 25_000,
      discountType: 'PERCENTAGE',
      discountRate: 10,
      absoluteMaxDiscountValue: 500,
    });
    expect(assessment.discountAtThreshold).toBe(500);
    expect(assessment.exceedsProfit).toBe(false);
  });
});
