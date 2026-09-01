import type { SettlementStrategy as SettlementStrategyName } from '@walaa/shared-types';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  DISCOUNT SETTLEMENT — CLAUDE_v3.md §9 (CLOSED, 2026-09-01)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The problem this interface exists for:
 *
 * Cashiers at this merchant are **not authorised to modify invoices**. That is a
 * deliberate anti-fraud control and must be respected, not worked around. So the
 * discount cannot be applied as a price reduction on the invoice itself — the POS
 * total is fixed the moment it prints. Which leaves the question of how the customer
 * actually pays less, and how the books still balance.
 *
 * **That question is the merchant's, and he has answered it his own way.** §9 is
 * closed by operator ruling: the system captures, calculates and prints the slip with
 * gross / discount / net, and does not prescribe how the discount is recorded. The
 * split-payment question that gated the preferred strategy is withdrawn.
 *
 * The interface stays, and all three implementations stay, because the *words on the
 * slip* are still a per-store choice: `MERCHANT_DEFINED` (the default) names no
 * mechanism, while `VOUCHER_AS_PAYMENT` and `DAILY_PROMOTIONAL_EXPENSE` each print an
 * explicit procedure for a store that wants one. Switching is a settings change, not
 * a rebuild.
 *
 * ── THE RULE THAT BINDS EVERY IMPLEMENTATION ───────────────────────────────
 *
 * **A cashier must never collect less cash than the POS recorded without a
 * corresponding voucher record.** An unexplained shortfall in the drawer does not
 * read as a discount in the books — it reads as theft, and it will wrongly
 * implicate the person on the till. Every strategy therefore produces a voucher,
 * atomically with the discount it settles. There is no code path that discounts
 * without issuing one. This is enforced by the transaction, not by the wording, so
 * it survives a strategy whose instruction deliberately names no procedure.
 */

export interface SettlementContext {
  merchantId: string;
  transactionId: string;
  customerId: string;
  customerName: string;
  invoiceId: string;
  /** The invoice total as the POS recorded it. Never modified. */
  amountGross: number;
  /** IQD discounted, already capped by the engine. */
  discountValue: number;
  /** What the customer actually pays. */
  amountNet: number;
  /** Human-readable rate, e.g. "3٪" or "7,500 د.ع". */
  discountLabel: string;
  issuedAt: Date;
}

/**
 * What the strategy produces: the voucher to persist and the words to print.
 *
 * The instruction text is the strategy's real output. Every strategy discounts the
 * same amount; they differ in what the cashier is told to *do* with the slip, and
 * getting that sentence wrong is what would create a cash discrepancy.
 */
export interface SettlementOutcome {
  /** Short code printed on the slip for the cashier to match at reconciliation. */
  code: string;
  value: number;
  strategy: SettlementStrategyName;
  /** The instruction printed on the slip, pre-phrased so nobody must improvise. */
  cashierInstruction: string;
  /** One line explaining how this settles in the books, for the manager's reports. */
  accountingNote: string;
}

/** The words, without minting anything. */
export type SettlementNarrative = Pick<SettlementOutcome, 'cashierInstruction' | 'accountingNote'>;

export interface DiscountSettlementStrategy {
  readonly name: SettlementStrategyName;
  /** Arabic label for the settings UI. */
  readonly label: string;
  /** Whether this strategy needs the POS to support split payment. */
  readonly requiresSplitPayment: boolean;

  /**
   * The instruction and the accounting note for a given settlement.
   *
   * Separate from `settle` because a slip can need reprinting long after the
   * voucher was issued — a station that lost the response and scanned again, or a
   * customer whose paper jammed. Regenerating the words is safe; regenerating a
   * voucher code would put a second code on a discount that already has one, and
   * the end-of-day reconciliation would then be short a slip it is looking for.
   */
  describe(context: SettlementContext): SettlementNarrative;

  settle(context: SettlementContext): SettlementOutcome;
}

/**
 * Voucher codes are short enough for a cashier to compare by eye against a list at
 * end of day, and long enough not to collide within a merchant. Ambiguous glyphs
 * (0/O, 1/I) are excluded — these are read off thermal paper, often in poor light.
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function generateVoucherCode(random: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < 8; i += 1) {
    code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
