import type { CaptureMode, CustomerCategory, SettlementStrategy } from './enums';

/**
 * Reporting contracts (CLAUDE_v3.md §12.27).
 *
 * These live here rather than beside the query that builds them because the
 * manager app had its own copy of every one of them, and a copy is a shape that
 * agrees with the server right up until it does not. `reports.service.ts` imports
 * these as its return types, so the server cannot drift from the client without a
 * type error in the same commit.
 */

/** The fixed reporting windows the API accepts. Not a free date range (§12.26). */
export type ReportRange = '7d' | '30d' | '90d' | '365d';

export const REPORT_RANGES: readonly ReportRange[] = ['7d', '30d', '90d', '365d'];

export interface OverviewReport {
  totalCustomers: number;
  newCustomersInRange: number;
  capturedInvoices: number;
  attributedInvoices: number;
  /**
   * Captures a card was scanned for, as a percentage — the enrolment signal.
   *
   * The headline metric of v3. The agent captures every invoice in the store, so
   * what a manager needs is what fraction reached an enrolled customer; that gap is
   * the programme's reach.
   */
  attributionRatePct: number;
  capturedSales: number;
  discountsGranted: number;
  averageBasket: number;
  /** Bucketed by the merchant's LOCAL day, never UTC (§13.1). */
  timeseries: Array<{ date: string; amount: number; count: number; attributed: number }>;
  /** Ranked over the selected range — there is no period to rank within (§10.6). */
  topCustomers: Array<{
    id: string;
    name: string;
    phone: string;
    category: CustomerCategory | string;
    spendInRange: number;
    transactionCount: number;
  }>;
  recentTransactions: Array<{
    id: string;
    invoiceId: string;
    amountGross: number;
    discountValue: number;
    amountNet: number;
    customerName: string | null;
    occurredAt: string;
    captureMode: CaptureMode | string;
  }>;
}

export interface OverviewResponse {
  overview: OverviewReport;
}

/** End-of-day settlement, as the Reports screen reads it. */
export interface DayReconciliation {
  date: string;
  issuedCount: number;
  issuedValue: number;
  redeemedCount: number;
  redeemedValue: number;
  outstandingCount: number;
  outstandingValue: number;
  /** The union, not `string`: the Reports screen names the strategy from
   *  SETTLEMENT_STRATEGY_LABELS, which a widened type would let it index unsafely. */
  settlementStrategy: SettlementStrategy;
}

export interface ProgrammeReport {
  discountsGranted: number;
  vouchersIssued: number;
  vouchersRedeemed: number;
  vouchersOutstanding: number;
  outstandingValue: number;
  redemptionRatePct: number;
  averageBasket: number;
  attributionRatePct: number;
  /**
   * How often §2.3's guardrails actually bound, and what they saved.
   *
   * **A guardrail that never reports is a guardrail nobody can tune.** §2.3 exists to
   * stop a configuration that loses money on every qualifying sale, and the cap doing
   * its job is not a neutral fact — it means the tier ladder is asking for more than
   * the merchant decided to give. If it binds on every sale, the ladder is set wrong,
   * and the manager should see that here rather than find it in the accounts (§12.37).
   *
   * `forgoneDiscountValue` sums across every transaction in the range, so §13.5's
   * per-row Int32 bound does not cover it. It is accumulated in JavaScript rather
   * than in SQL — exact to 2^53, which a year of a supermarket's discounts does not
   * approach — matching how `discountsGranted` beside it has always been computed.
   */
  cappedDiscountCount: number;
  /** Qualifying sales in the range, as the denominator `cappedDiscountCount` needs. */
  discountedTransactionCount: number;
  /** Total IQD the caps withheld: Σ(uncapped − applied) over the range. */
  forgoneDiscountValue: number;
  captureByMode: Array<{ mode: CaptureMode | string; count: number }>;
  /**
   * Registered customers by category.
   *
   * Counts of people, never sums of money — so §13.5's Int32 warning does not apply
   * and nothing here needs a BIGINT cast. Stated because the two breakdowns look
   * alike and only one of them would.
   */
  customersByCategory: Array<{ category: CustomerCategory | string; count: number }>;
  /**
   * How many INVOICES landed in each bracket over the range (v4 §10.6).
   *
   * v3 counted *customers* who had reached each tier inside the active period, which
   * was the right question while a tier was something a person climbed to. Under v4 a
   * bracket is a property of an invoice, not of a customer — the same shopper can land
   * in three different brackets in one week — so the honest count is of invoices.
   *
   * Each invoice is counted in exactly ONE bracket: the highest it reached, which is
   * the one that actually paid. That differs from v3 deliberately, where a customer at
   * 200,000 counted toward every threshold below them. Counting an invoice in every
   * bracket it clears would make the columns sum to more than the number of sales and
   * overstate the lower brackets, which are the ones a manager is deciding about.
   */
  bracketPerformance: Array<{
    thresholdAmount: number;
    discountLabel: string;
    invoiceCount: number;
  }>;
  /**
   * Discount value taken per customer over the range (v4 §10.5).
   *
   * **The mitigation for an exposure v4 creates rather than a general-interest
   * statistic.** Removing cumulative spend removed an accidental bound: under v3 a
   * customer climbed the ladder once per period, and under v4 every invoice is judged
   * on its own, so a wholesale buyer at 480,000 a day takes the ceiling every day.
   * Nothing in §2.3 bounds a customer — all three guardrails bound a single invoice.
   *
   * This makes that visible without restricting it. It is a report, not a second
   * ladder, so it does not reopen the per-customer path §12.27 closed and that §2.3's
   * guardrails depend on staying closed. A frequency cap, if it is ever wanted, is a
   * discount-model decision with its own guardrails — not a thing to grow from here.
   */
  discountByCustomer: Array<{
    id: string;
    name: string;
    phone: string;
    discountValue: number;
    discountedInvoiceCount: number;
  }>;
  todayReconciliation: DayReconciliation;
}

export interface ProgrammeReportResponse {
  report: ProgrammeReport;
}
