import { prisma } from '../lib/prisma';
import { getPeriodContext, periodKeyFor } from './balance.service';
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

export type ReportRange = '7d' | '30d' | '90d' | '365d';

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

export interface OverviewReport {
  totalCustomers: number;
  newCustomersInRange: number;
  capturedInvoices: number;
  attributedInvoices: number;
  /** Percentage of captures a card was scanned for — the enrolment signal. */
  attributionRatePct: number;
  capturedSales: number;
  discountsGranted: number;
  averageBasket: number;
  currentPeriodKey: string;
  timeseries: Array<{ date: string; amount: number; count: number; attributed: number }>;
  topCustomers: Array<{
    id: string;
    name: string;
    phone: string;
    category: string;
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
    captureMode: string;
  }>;
}

export async function getOverview(
  merchantId: string,
  range: ReportRange = '30d',
): Promise<OverviewReport> {
  const from = since(range);
  const context = await getPeriodContext(merchantId);
  const currentPeriodKey = periodKeyFor(context, new Date());

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
    const day = localDay(t.occurredAt, context.timezone);
    const bucket = buckets.get(day) ?? { amount: 0, count: 0, attributed: 0 };
    bucket.amount += t.amountGross;
    bucket.count += 1;
    if (t.customerId) bucket.attributed += 1;
    buckets.set(day, bucket);
  }

  const timeseries = [...buckets.entries()]
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Top spenders in the current period, computed from the log — there is no
  // snapshot cache to read (§5.3).
  const periodRows = await prisma.transaction.groupBy({
    by: ['customerId'],
    where: { merchantId, periodKey: currentPeriodKey, customerId: { not: null } },
    _sum: { amountGross: true },
    _count: true,
  });

  const ranked = periodRows
    .filter((r) => r.customerId !== null)
    .sort((a, b) => (b._sum.amountGross ?? 0) - (a._sum.amountGross ?? 0))
    .slice(0, 5);

  const topCustomerRows = ranked.length
    ? await prisma.customer.findMany({
        where: { id: { in: ranked.map((r) => r.customerId as string) } },
        select: { id: true, name: true, phone: true, category: true },
      })
    : [];

  const byId = new Map(topCustomerRows.map((c) => [c.id, c]));
  const topCustomers = ranked.flatMap((r) => {
    const customer = byId.get(r.customerId as string);
    if (!customer) return [];
    return [
      {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        category: customer.category,
        cumulativeAmount: r._sum.amountGross ?? 0,
        transactionCount: r._count,
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
    currentPeriodKey,
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

export interface ProgrammeReport {
  discountsGranted: number;
  vouchersIssued: number;
  vouchersRedeemed: number;
  vouchersOutstanding: number;
  outstandingValue: number;
  redemptionRatePct: number;
  averageBasket: number;
  attributionRatePct: number;
  captureByMode: Array<{ mode: string; count: number }>;
  todayReconciliation: Awaited<ReturnType<typeof reconcileDay>>;
}

export async function getProgrammeReport(
  merchantId: string,
  range: ReportRange = '30d',
): Promise<ProgrammeReport> {
  const from = since(range);

  const [transactions, vouchers, reconciliation] = await Promise.all([
    prisma.transaction.findMany({
      where: { merchantId, occurredAt: { gte: from } },
      select: { amountGross: true, discountValue: true, customerId: true, captureMode: true },
    }),
    prisma.voucher.findMany({ where: { merchantId, issuedAt: { gte: from } } }),
    reconcileDay(merchantId),
  ]);

  const redeemed = vouchers.filter((v) => v.status === 'REDEEMED');
  const outstanding = vouchers.filter((v) => v.status === 'ISSUED');
  const attributed = transactions.filter((t) => t.customerId !== null).length;
  const grossTotal = transactions.reduce((sum, t) => sum + t.amountGross, 0);

  const modeCounts = new Map<string, number>();
  for (const t of transactions) {
    modeCounts.set(t.captureMode, (modeCounts.get(t.captureMode) ?? 0) + 1);
  }

  return {
    discountsGranted: transactions.reduce((sum, t) => sum + t.discountValue, 0),
    vouchersIssued: vouchers.length,
    vouchersRedeemed: redeemed.length,
    vouchersOutstanding: outstanding.length,
    outstandingValue: outstanding.reduce((sum, v) => sum + v.value, 0),
    redemptionRatePct: vouchers.length > 0 ? Math.round((redeemed.length / vouchers.length) * 100) : 0,
    averageBasket: transactions.length > 0 ? Math.round(grossTotal / transactions.length) : 0,
    attributionRatePct:
      transactions.length > 0 ? Math.round((attributed / transactions.length) * 100) : 0,
    captureByMode: [...modeCounts.entries()].map(([mode, count]) => ({ mode, count })),
    todayReconciliation: reconciliation,
  };
}
