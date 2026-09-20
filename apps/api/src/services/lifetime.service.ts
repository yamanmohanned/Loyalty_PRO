import type { Prisma, PrismaClient } from '@prisma/client';
import type { CustomerLifetime, DiscountRule, InvoiceOutcome } from '@loyalty-pro/shared-types';
import { formatIqd } from '@loyalty-pro/shared-types';
import { prisma } from '../lib/prisma';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  CUSTOMER HISTORY, AND WHERE ONE INVOICE LANDS — v4 §1.4, §10.4
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * **This module was `balance.service.ts`, and the rename is the point.** "Balance"
 * was the v3 concept v4 removes: cumulative spend inside a period, which decided
 * whether a customer got a discount. §1.6 step 3 requires that what survives be named
 * so nobody mistakes it for a discount input, and a file called `balance.service`
 * imported by the scan path is exactly that mistake waiting to be made.
 *
 * What is left is two unrelated things that used to be one:
 *
 *  - **`getCustomerLifetime`** — how much this person has ever spent. Reporting only.
 *    Nothing here reaches the discount decision, and `computeDiscount` could not
 *    accept it if it tried: the parameter that carried it was deleted (§12.27).
 *  - **`invoiceOutcome`** — where a single invoice falls on the ladder, and what the
 *    next bracket up would pay. A fact about an invoice, not about a person.
 *
 * Both are still derived from `transaction` rows and never stored (§5.3). That
 * reasoning survives the model change unchanged: a stored aggregate drifts from the
 * log that produced it and then lies quietly. There is no cache to reconcile because
 * there is no cache. The only thing that changed is that no calendar bounds the sum.
 */

/**
 * Everything a customer has ever spent with this merchant.
 *
 * Sums `amountGross`, not `amountNet`: what a customer *bought* is the honest measure
 * of their history, and netting the discounts out would make a good customer's total
 * shrink each time the shop rewarded them.
 *
 * There is deliberately no index for this beyond `transaction(customer_id)`, which
 * already exists. v3 needed `(customer_id, period_key)` because the sum ran on the
 * scan hot path for every customer at the till; under v4 the till never asks for it,
 * so it is a reporting query and an ordinary index is right.
 */
export async function getCustomerLifetime(
  customerId: string,
  db: Db = prisma,
): Promise<CustomerLifetime> {
  const result = await db.transaction.aggregate({
    where: { customerId },
    _sum: { amountGross: true },
    _count: true,
  });

  return {
    totalSpend: result._sum.amountGross ?? 0,
    transactionCount: result._count,
  };
}

/** Active discount rules for a merchant, ascending by bracket. */
export async function getActiveRules(
  merchantId: string,
  db: Db = prisma,
): Promise<
  Array<
    Pick<
      DiscountRule,
      'thresholdAmount' | 'discountType' | 'discountRate' | 'maxDiscountValue' | 'isActive'
    >
  >
> {
  const rules = await db.discountRule.findMany({
    where: { merchantId, isActive: true },
    orderBy: { thresholdAmount: 'asc' },
  });

  return rules.map((r) => ({
    thresholdAmount: r.thresholdAmount,
    discountType: r.discountType as 'PERCENTAGE' | 'FIXED_AMOUNT',
    discountRate: r.discountRate,
    maxDiscountValue: r.maxDiscountValue,
    isActive: r.isActive,
  }));
}

/** `3٪` or `5,000 د.ع` — how a bracket's reward reads to a person. */
export function describeReward(rule: Pick<DiscountRule, 'discountType' | 'discountRate'>): string {
  return rule.discountType === 'PERCENTAGE' ? `${rule.discountRate}٪` : formatIqd(rule.discountRate);
}

/**
 * Where one invoice falls on the ladder, and what the next rung up would pay.
 *
 * Pure and synchronous — it takes the rules and an amount, so the station, the
 * reports and the tests all get the same answer from the same code.
 *
 * Returns nulls for the "next" fields once the top bracket is reached, so the caller
 * can say "this is the best bracket" rather than naming a target that does not exist.
 */
export function invoiceOutcome(
  rules: Array<Pick<DiscountRule, 'thresholdAmount' | 'discountType' | 'discountRate'>>,
  amountGross: number,
): InvoiceOutcome {
  const ascending = [...rules].sort((a, b) => a.thresholdAmount - b.thresholdAmount);

  // Inclusive, matching `computeDiscount`: an invoice of exactly the bracket amount
  // qualifies. The two must agree, or the station would show a customer a bracket
  // they were not actually given.
  const reached = ascending.filter((rule) => amountGross >= rule.thresholdAmount).pop() ?? null;
  const next = ascending.find((rule) => rule.thresholdAmount > amountGross) ?? null;

  return {
    amountGross,
    bracketAmount: reached ? reached.thresholdAmount : null,
    nextBracketAmount: next ? next.thresholdAmount : null,
    amountToNextBracket: next ? next.thresholdAmount - amountGross : null,
    nextDiscountLabel: next ? describeReward(next) : null,
  };
}

/**
 * The sentence shown when an invoice earned nothing.
 *
 * **It names the bracket; it does not instruct the customer to do anything** (§1.4,
 * corrected 2026-09-04). An earlier draft read «أضف X د.ع لهذه الفاتورة» — "add X to
 * this invoice" — which asks for something the shop forbids: the POS printed the
 * receipt before anyone scanned, and cashiers may not modify an invoice (§2.2). The
 * customer standing there cannot act on it, and the cashier is not allowed to.
 *
 * So it states what qualifies. That is still a sales prompt — it tells someone what
 * the next basket needs to be — and it is one nobody has to refuse.
 */
export function bracketMessage(outcome: InvoiceOutcome): string {
  if (outcome.nextBracketAmount === null || outcome.nextDiscountLabel === null) {
    return 'لقد بلغت أعلى مستوى — شكراً لولائك!';
  }
  return `فاتورة بـ ${formatIqd(outcome.nextBracketAmount)} أو أكثر تحصل على خصم ${outcome.nextDiscountLabel}`;
}
