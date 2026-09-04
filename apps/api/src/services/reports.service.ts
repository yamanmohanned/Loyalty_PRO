import type { OverviewReport, ProgrammeReport, ReportRange } from '@walaa/shared-types';
import { prisma } from '../lib/prisma';
import { describeReward, getActiveRules } from './lifetime.service';
import { prisma as db } from '../lib/prisma';
import { reconcileDay } from './voucher.service';

/**
 * Reporting for the manager desktop app (v3 metrics).
 *
 * Rewritten rather than migrated: every query in the v1 version was PostgreSQL —
 * `::BIGINT` casts, `AT TIME ZONE`, `to_char` — none of which SQLite has. The
 * aggregates here run through Prisma so they are portable, and day bucketing moved
 * into JavaScript where the merchant's timezone can be applied correctly.
 *
 * The headline metric changed too. Under v1 it was linked sales; under v3 it is the
 * **attribution rate** — captured invoices versus those a card was scanned for.
 * That gap is the enrolment rate, and it is the number that tells a manager whether
 * the programme is actually reaching customers.
 */

// `ReportRange`, `OverviewReport` and `ProgrammeReport` are the shared contracts
// (`@walaa/shared-types`), imported rather than declared: the manager app used to
// carry its own copy of each, and a copy agrees with the server right up until it
// does not (§12.27). Re-exported so existing importers of this module keep working.
export type { OverviewReport, ProgrammeReport, ReportRange };

const RANGE_DAYS: Record<ReportRange, number> = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 };

function since(range: ReportRange): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - RANGE_DAYS[range]);
  return d;
}

/** Buckets an instant to a calendar day in the merchant's timezone, not UTC. */
function localDay(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const read = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${read('year')}-${read('month')}-${read('day')}`;
}

export async function getOverview(
  merchantId: string,
  range: ReportRange = '30d',
): Promise<OverviewReport> {
  const from = since(range);
  const merchant = await prisma.merchant.findUniqueOrThrow({
    where: { id: merchantId },
    select: { timezone: true },
  });

  const [totalCustomers, newCustomers, inRange, recent] = await Promise.all([
    prisma.customer.count({ where: { merchantId } }),
    prisma.customer.count({ where: { merchantId, createdAt: { gte: from } } }),
    prisma.transaction.findMany({
      where: { merchantId, occurredAt: { gte: from } },
      select: {
        amountGross: true,
        discountValue: true,
        customerId: true,
        occurredAt: true,
      },
    }),
    prisma.transaction.findMany({
      where: { merchantId },
      orderBy: { capturedAt: 'desc' },
      take: 10,
      include: { customer: { select: { name: true } } },
    }),
  ]);

  const capturedSales = inRange.reduce((sum, t) => sum + t.amountGross, 0);
  const discountsGranted = inRange.reduce((sum, t) => sum + t.discountValue, 0);
  const attributed = inRange.filter((t) => t.customerId !== null).length;

  // Day buckets in local time. Doing this in JS rather than SQL is the direct
  // consequence of SQLite having no timezone support — and it keeps the merchant's
  // zone as the single source of truth rather than the database server's.
  const buckets = new Map<string, { amount: number; count: number; attributed: number }>();
  for (const t of inRange) {
    const day = localDay(t.occurredAt, merchant.timezone);
    const bucket = buckets.get(day) ?? { amount: 0, count: 0, attributed: 0 };
    bucket.amount += t.amountGross;
    bucket.count += 1;
    if (t.customerId) bucket.attributed += 1;
    buckets.set(day, bucket);
  }

  const timeseries = [...buckets.entries()]
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Top spenders **over the selected range**. v3 ranked within the active period;
  // there is no period now, and the range control the manager already has is the
  // honest window to rank inside (§10.6).
  //
  // Tallied from `inRange`, which is already loaded — one query rather than two, and
  // it cannot disagree with the totals above it because it is the same rows.
  const spendByCustomer = new Map<string, { amount: number; count: number }>();
  for (const t of inRange) {
    if (!t.customerId) continue;
    const entry = spendByCustomer.get(t.customerId) ?? { amount: 0, count: 0 };
    entry.amount += t.amountGross;
    entry.count += 1;
    spendByCustomer.set(t.customerId, entry);
  }

  const ranked = [...spendByCustomer.entries()]
    .sort((a, b) => b[1].amount - a[1].amount)
    .slice(0, 5);

  const topCustomerRows = ranked.length
    ? await prisma.customer.findMany({
        where: { id: { in: ranked.map(([id]) => id) } },
        select: { id: true, name: true, phone: true, category: true },
      })
    : [];

  const byId = new Map(topCustomerRows.map((c) => [c.id, c]));
  const topCustomers = ranked.flatMap(([id, totals]) => {
    const customer = byId.get(id);
    if (!customer) return [];
    return [
      {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        category: customer.category,
        spendInRange: totals.amount,
        transactionCount: totals.count,
      },
    ];
  });

  return {
    totalCustomers,
    newCustomersInRange: newCustomers,
    capturedInvoices: inRange.length,
    attributedInvoices: attributed,
    attributionRatePct: inRange.length > 0 ? Math.round((attributed / inRange.length) * 100) : 0,
    capturedSales,
    discountsGranted,
    averageBasket: inRange.length > 0 ? Math.round(capturedSales / inRange.length) : 0,
    timeseries,
    topCustomers,
    recentTransactions: recent.map((t) => ({
      id: t.id,
      invoiceId: t.invoiceId,
      amountGross: t.amountGross,
      discountValue: t.discountValue,
      amountNet: t.amountNet,
      customerName: t.customer?.name ?? null,
      occurredAt: t.occurredAt.toISOString(),
      captureMode: t.captureMode,
    })),
  };
}

export async function getProgrammeReport(
  merchantId: string,
  range: ReportRange = '30d',
): Promise<ProgrammeReport> {
  const from = since(range);

  const [transactions, vouchers, reconciliation, categoryGroups, rules] =
    await Promise.all([
      prisma.transaction.findMany({
        where: { merchantId, occurredAt: { gte: from } },
        select: {
          amountGross: true,
          discountValue: true,
          discountUncappedValue: true,
          customerId: true,
          captureMode: true,
        },
      }),
      prisma.voucher.findMany({ where: { merchantId, issuedAt: { gte: from } } }),
      reconcileDay(merchantId),
      prisma.customer.groupBy({
        by: ['category'],
        where: { merchantId, isActive: true },
        _count: { _all: true },
      }),
      getActiveRules(merchantId),
    ]);

  const redeemed = vouchers.filter((v) => v.status === 'REDEEMED');
  const outstanding = vouchers.filter((v) => v.status === 'ISSUED');
  const attributed = transactions.filter((t) => t.customerId !== null).length;

  const modeCounts = new Map<string, number>();
  for (const t of transactions) {
    modeCounts.set(t.captureMode, (modeCounts.get(t.captureMode) ?? 0) + 1);
  }

  // §2.3's guardrails, reported rather than merely enforced (§12.37).
  //
  // A row where the ladder asked for more than was given is a row where the cap
  // bit. Counted against the qualifying sales rather than all captures, because
  // "the cap binds on most discounts" and "the cap binds on 2% of footfall" are
  // different sentences and only the first one means the ladder is misconfigured.
  const discounted = transactions.filter((t) => t.discountValue > 0);
  const capped = discounted.filter((t) => t.discountUncappedValue > t.discountValue);

  return {
    discountsGranted: transactions.reduce((sum, t) => sum + t.discountValue, 0),
    cappedDiscountCount: capped.length,
    discountedTransactionCount: discounted.length,
    forgoneDiscountValue: capped.reduce(
      (sum, t) => sum + (t.discountUncappedValue - t.discountValue),
      0,
    ),
    vouchersIssued: vouchers.length,
    vouchersRedeemed: redeemed.length,
    vouchersOutstanding: outstanding.length,
    outstandingValue: outstanding.reduce((sum, v) => sum + v.value, 0),
    redemptionRatePct: vouchers.length > 0 ? Math.round((redeemed.length / vouchers.length) * 100) : 0,
    attributionRatePct:
      transactions.length > 0 ? Math.round((attributed / transactions.length) * 100) : 0,
    captureByMode: [...modeCounts.entries()].map(([mode, count]) => ({ mode, count })),
    customersByCategory: categoryGroups.map((row) => ({
      category: row.category,
      count: row._count._all,
    })),
    bracketPerformance: bracketPerformance(rules, transactions),
    discountByCustomer: await discountByCustomer(merchantId, from),
    todayReconciliation: reconciliation,
  };
}

/**
 * How many attributed invoices landed in each bracket over the range (v4 §10.6).
 *
 * **Each invoice counts in exactly ONE bracket — the highest it reached.** v3 counted
 * a customer toward every threshold at or below their cumulative spend, which was
 * right when a tier was a level a person climbed to. It is wrong here: counting one
 * invoice in every bracket it clears makes the columns sum to more than the number of
 * sales and inflates the lower brackets, which are the ones a manager is deciding
 * about.
 *
 * **Attributed invoices only.** An unattributed capture earned nothing — no card, no
 * entitlement (§1.2) — so counting it here would describe discounts that were never
 * given. The gap between this and `capturedInvoices` is the enrolment story, and it is
 * already told by `attributionRatePct`.
 *
 * A bracket with no invoices returns zero rather than being omitted: the gap has to be
 * visible as a gap, which is §12.33's rule and the reason the row keeps its label.
 */
function bracketPerformance(
  rules: Array<{
    thresholdAmount: number;
    discountType: 'PERCENTAGE' | 'FIXED_AMOUNT';
    discountRate: number;
  }>,
  transactions: Array<{ amountGross: number; customerId: string | null }>,
): Array<{ thresholdAmount: number; discountLabel: string; invoiceCount: number }> {
  const ascending = [...rules].sort((a, b) => a.thresholdAmount - b.thresholdAmount);
  const counts = new Map<number, number>(ascending.map((r) => [r.thresholdAmount, 0]));

  for (const t of transactions) {
    if (t.customerId === null) continue;
    // Inclusive and highest-wins, matching `computeDiscount` exactly. If these two
    // ever disagreed the chart would report a bracket the till did not pay.
    const reached = ascending.filter((r) => t.amountGross >= r.thresholdAmount).pop();
    if (reached) counts.set(reached.thresholdAmount, (counts.get(reached.thresholdAmount) ?? 0) + 1);
  }

  return ascending.map((rule) => ({
    thresholdAmount: rule.thresholdAmount,
    discountLabel: describeReward(rule),
    invoiceCount: counts.get(rule.thresholdAmount) ?? 0,
  }));
}

/**
 * Discount value taken per customer over the range (v4 §10.5).
 *
 * **This exists because removing accumulation removed a bound nobody had designed.**
 * Under v3 a customer climbed the ladder once per period; under v4 every invoice is
 * judged alone, so a wholesale buyer at 480,000 a day takes the ceiling every day.
 * Every guardrail in §2.3 bounds a single invoice and none of them bounds a customer.
 *
 * The mitigation is visibility, not a rule. A frequency cap would be a discount-model
 * decision with its own guardrails, and building one here — where the reporting lives
 * — is exactly how a second ladder would arrive by accident (§12.27).
 *
 * Ten rows: this answers "is anyone taking an unusual share", which the top of the
 * list settles. `discountValue` is summed in JavaScript for the §13.5 reason — the
 * per-row Int32 bound does not cover an aggregate, and this stays exact to 2^53.
 */
async function discountByCustomer(
  merchantId: string,
  from: Date,
): Promise<
  Array<{
    id: string;
    name: string;
    phone: string;
    discountValue: number;
    discountedInvoiceCount: number;
  }>
> {
  const grouped = await db.transaction.groupBy({
    by: ['customerId'],
    where: {
      merchantId,
      occurredAt: { gte: from },
      customerId: { not: null },
      discountValue: { gt: 0 },
    },
    _sum: { discountValue: true },
    _count: { _all: true },
  });

  const ranked = grouped
    .filter((row) => row.customerId !== null)
    .sort((a, b) => (b._sum.discountValue ?? 0) - (a._sum.discountValue ?? 0))
    .slice(0, 10);

  if (ranked.length === 0) return [];

  const customers = await db.customer.findMany({
    where: { id: { in: ranked.map((row) => row.customerId as string) } },
    select: { id: true, name: true, phone: true },
  });
  const byId = new Map(customers.map((c) => [c.id, c]));

  return ranked.flatMap((row) => {
    const customer = byId.get(row.customerId as string);
    if (!customer) return [];
    return [
      {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        discountValue: row._sum.discountValue ?? 0,
        discountedInvoiceCount: row._count._all,
      },
    ];
  });
}
