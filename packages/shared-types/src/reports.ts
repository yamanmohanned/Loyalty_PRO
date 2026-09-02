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
  currentPeriodKey: string;
  /** Bucketed by the merchant's LOCAL day, never UTC (§13.1). */
  timeseries: Array<{ date: string; amount: number; count: number; attributed: number }>;
  topCustomers: Array<{
    id: string;
    name: string;
    phone: string;
    category: CustomerCategory | string;
    cumulativeAmount: number;
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
   * How many customers reached each discount tier in the CURRENT period.
   *
   * Cumulative in the way the ladder is: someone at 200,000 counts toward every
   * threshold below them, because that is what "reached this tier" means to the
   * person reading the chart.
   */
  tierPerformance: Array<{
    thresholdAmount: number;
    discountLabel: string;
    reached: number;
  }>;
  todayReconciliation: DayReconciliation;
}

export interface ProgrammeReportResponse {
  report: ProgrammeReport;
}
