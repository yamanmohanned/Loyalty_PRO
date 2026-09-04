import { describe, expect, it } from 'vitest';
import { assessMargin, computeDiscount, type DiscountComputationInput } from '../index';

/**
 * The instant-discount calculation and its guardrails (§2.3, as amended by v4 §1).
 *
 * This is the highest-stakes arithmetic in the system. Under the v1 coupon model a
 * mistake cost a discount on a *future* visit that might never happen. Since v3 it
 * comes straight off the basket in front of the cashier, every single time, with no
 * return visit to earn it back.
 *
 * **v4: a tier is an invoice-amount bracket.** The customer's history is not an input
 * — `computeDiscount` cannot see it, because the parameter that carried it was
 * deleted rather than renamed (§12.27's removal corollary).
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
  rules: RULES,
  absoluteMaxDiscountValue: 5_000,
  discountTypeSetting: 'PERCENTAGE',
  ...over,
});

describe('threshold evaluation', () => {
  it('grants nothing below the first threshold', () => {
    const result = computeDiscount(base({ amountGross: 20_000 }));
    expect(result.discountValue).toBe(0);
    expect(result.appliedThreshold).toBeNull();
    expect(result.amountNet).toBe(20_000);
  });

  it('grants at exactly the threshold', () => {
    const result = computeDiscount(base({ amountGross: 25_000 }));
    expect(result.appliedThreshold).toBe(25_000);
    expect(result.discountValue).toBe(500); // 2% of 25,000
    expect(result.amountNet).toBe(24_500);
  });

  it('applies only the HIGHEST bracket reached', () => {
    // An invoice of 80,000 necessarily clears 25,000 too. Applying both would
    // double-discount one basket.
    const result = computeDiscount(base({ amountGross: 80_000 }));
    expect(result.appliedThreshold).toBe(75_000);
    expect(result.discountRate).toBe(3);
  });

  it('judges THIS invoice alone — history buys nothing (v4 §1.1)', () => {
    // The v3 assertion this replaces was the opposite: a 10,000 basket earned 3%
    // because the customer had already spent 70,000 that period. Under v4 the
    // engine cannot see that spend at all, and a small invoice earns nothing no
    // matter who is holding it.
    const result = computeDiscount(base({ amountGross: 10_000 }));
    expect(result.appliedThreshold).toBeNull();
    expect(result.discountValue).toBe(0);
    expect(result.amountNet).toBe(10_000);
  });

  it('gives the same answer for a first-ever invoice and a thousandth', () => {
    // There is no state to carry, so two identical invoices must be identical
    // outcomes. This is the property that makes the offline replay in
    // `scanCard({ issueDiscount: false })` safe to reason about.
    const first = computeDiscount(base({ amountGross: 90_000 }));
    const later = computeDiscount(base({ amountGross: 90_000 }));
    expect(later).toEqual(first);
    expect(first.discountRate).toBe(3);
  });

  it('grants nothing one dinar below a bracket, and grants at the boundary', () => {
    // The boundary is inclusive. A customer told "spend 25,000 for 2%" who hands
    // over exactly 25,000 must not be refused on an off-by-one.
    expect(computeDiscount(base({ amountGross: 24_999 })).discountValue).toBe(0);
    expect(computeDiscount(base({ amountGross: 25_000 })).discountValue).toBe(500);
  });

  it('ignores inactive rules', () => {
    const result = computeDiscount(
      base({
        rules: RULES.map((r) => ({ ...r, isActive: false })),
      }),
    );
    expect(result.discountValue).toBe(0);
  });

  it('grants nothing when discounting is switched off', () => {
    // NONE leaves capture and reporting running so a merchant can evaluate the
    // programme before committing to a rate.
    const result = computeDiscount(base({ discountTypeSetting: 'NONE' }));
    expect(result.discountValue).toBe(0);
    expect(result.discountType).toBe('NONE');
  });
});

describe('the absolute cap — the last line of defence (§2.3)', () => {
  it('caps a large basket that would otherwise give away a fortune', () => {
    // Without the cap: 3% of 500,000 = 15,000 IQD on a basket whose net profit is
    // roughly 15,000 at a 3% margin. The store would work for nothing.
    const result = computeDiscount(
      base({ amountGross: 500_000, absoluteMaxDiscountValue: 5_000 }),
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
        rules: [{ thresholdAmount: 1_000, discountType: 'FIXED_AMOUNT', discountRate: 10_000, maxDiscountValue: null, isActive: true }],
        absoluteMaxDiscountValue: 50_000,
      }),
    );
    expect(result.discountValue).toBe(3_000);
    expect(result.amountNet).toBe(0);
  });

  it('never produces a negative discount or net', () => {
    for (const gross of [1, 100, 25_000, 999_999]) {
      const result = computeDiscount(base({ amountGross: gross }));
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
    // 2% of 33,333 = 666.66. There is no such thing as a fraction of a dinar.
    const result = computeDiscount(
      base({ amountGross: 33_333, absoluteMaxDiscountValue: 50_000 }),
    );
    expect(Number.isInteger(result.discountValue)).toBe(true);
    expect(result.discountValue).toBe(666);
  });

  it('rounds in the merchant’s favour, never the customer’s', () => {
    // Flooring means the store never gives away a dinar it did not intend to.
    // 100,099 reaches the 3% bracket: 3,002.97 → 3,002.
    const result = computeDiscount(
      base({ amountGross: 100_099, absoluteMaxDiscountValue: 50_000 }),
    );
    expect(result.discountValue).toBe(3_002);
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
