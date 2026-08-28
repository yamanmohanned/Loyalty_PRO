import { prisma } from '../lib/prisma';
import { getPeriodContext, periodKeyFor } from './rules.service';

/**
 * Reporting aggregates for the manager dashboard.
 *
 * ⚠ **Every all-time SUM here casts to BIGINT before summing** (CLAUDE.md §13.5).
 * Per-row money is a bounded Int32, but a total across every transaction a merchant
 * has ever taken is not. Postgres `sum(int)` returns bigint natively, but the cast is
 * written explicitly so the constraint is visible to whoever edits these queries next
 * — and the results are read back as strings and converted once, deliberately.
 *
 * These endpoints are OWNER/MANAGER only: assistants do not see financial reporting
 * (§7.2).
 */

/** Postgres returns bigint as a string over the wire; convert at one place only. */
function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export type ReportRange = '7d' | '30d' | '90d' | '365d';

export function rangeToDays(range: ReportRange): number {
  return { '7d': 7, '30d': 30, '90d': 90, '365d': 365 }[range];
}

function since(range: ReportRange): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - rangeToDays(range));
  return d;
}

export interface OverviewKpis {
  totalCustomers: number;
  newCustomersInRange: number;
  transactionsInRange: number;
  /** All-time linked sales. Cast to BIGINT in SQL — see the note above. */
  linkedSalesInRange: number;
  activeCoupons: number;
  couponsExpiringThisWeek: number;
  /** Customers with any spend in the current loyalty period. */
  activeCustomersThisPeriod: number;
  currentPeriodKey: string;
}

export async function getOverview(
  merchantId: string,
  range: ReportRange = '30d',
): Promise<OverviewKpis> {
  const from = since(range);
  const periodContext = await getPeriodContext(merchantId);
  const currentPeriodKey = periodKeyFor(periodContext, new Date());

  const weekAhead = new Date();
  weekAhead.setUTCDate(weekAhead.getUTCDate() + 7);

  const [
    totalCustomers,
    newCustomersInRange,
    transactionsInRange,
    salesRows,
    activeCoupons,
    couponsExpiringThisWeek,
    activeCustomers,
  ] = await Promise.all([
    prisma.customer.count({ where: { merchantId } }),
    prisma.customer.count({ where: { merchantId, createdAt: { gte: from } } }),
    prisma.transaction.count({ where: { merchantId, occurredAt: { gte: from } } }),
    prisma.$queryRaw<Array<{ total: string | null }>>`
      SELECT SUM(amount::BIGINT)::TEXT AS total
      FROM transaction
      WHERE merchant_id = ${merchantId}::uuid AND occurred_at >= ${from}
    `,
    prisma.coupon.count({ where: { merchantId, status: 'ACTIVE' } }),
    prisma.coupon.count({
      where: { merchantId, status: 'ACTIVE', expiresAt: { lte: weekAhead, gte: new Date() } },
    }),
    prisma.balanceSnapshot.count({
      where: { merchantId, periodKey: currentPeriodKey, cumulativeAmount: { gt: 0 } },
    }),
  ]);

  return {
    totalCustomers,
    newCustomersInRange,
    transactionsInRange,
    linkedSalesInRange: toNumber(salesRows[0]?.total),
    activeCoupons,
    couponsExpiringThisWeek,
    activeCustomersThisPeriod: activeCustomers,
    currentPeriodKey,
  };
}

export interface TimeseriesPoint {
  date: string;
  amount: number;
  count: number;
}

/**
 * Linked sales per day. Buckets in the merchant's timezone so a day on the chart is
 * the day the shop actually experienced, not a UTC slice of two of them.
 */
export async function getSalesTimeseries(
  merchantId: string,
  range: ReportRange = '30d',
): Promise<TimeseriesPoint[]> {
  const from = since(range);
  const { timezone } = await getPeriodContext(merchantId);

  const rows = await prisma.$queryRaw<
    Array<{ day: string; total: string | null; count: string }>
  >`
    SELECT
      -- occurred_at is 'timestamp without time zone' holding UTC (that is how
      -- Prisma stores DateTime). A bare AT TIME ZONE would *interpret* it as local
      -- time rather than convert from UTC, shifting every late-evening sale onto the
      -- wrong day. Declare UTC first, then convert.
      to_char((occurred_at AT TIME ZONE 'UTC' AT TIME ZONE ${timezone})::date, 'YYYY-MM-DD') AS day,
      SUM(amount::BIGINT)::TEXT AS total,
      COUNT(*)::TEXT AS count
    FROM transaction
    WHERE merchant_id = ${merchantId}::uuid AND occurred_at >= ${from}
    GROUP BY 1
    ORDER BY 1 ASC
  `;

  return rows.map((r) => ({
    date: r.day,
    amount: toNumber(r.total),
    count: toNumber(r.count),
  }));
}

export interface TopCustomer {
  id: string;
  name: string;
  phone: string;
  category: string;
  cumulativeAmount: number;
  transactionCount: number;
}

/** Highest spenders in the current loyalty period, read from the snapshot cache. */
export async function getTopCustomers(merchantId: string, limit = 5): Promise<TopCustomer[]> {
  const periodContext = await getPeriodContext(merchantId);
  const periodKey = periodKeyFor(periodContext, new Date());

  const snapshots = await prisma.balanceSnapshot.findMany({
    where: { merchantId, periodKey },
    orderBy: { cumulativeAmount: 'desc' },
    take: limit,
    include: { customer: { select: { id: true, name: true, phone: true, category: true } } },
  });

  return snapshots.map((s) => ({
    id: s.customer.id,
    name: s.customer.name,
    phone: s.customer.phone,
    category: s.customer.category,
    cumulativeAmount: s.cumulativeAmount,
    transactionCount: s.transactionCount,
  }));
}

export interface TierBucket {
  label: string;
  thresholdAmount: number | null;
  discountPct: number | null;
  customers: number;
}

/**
 * How customers distribute across the tier ladder this period — the "who is where"
 * view a manager uses to decide whether the thresholds are set sensibly.
 */
export async function getTierDistribution(merchantId: string): Promise<TierBucket[]> {
  const periodContext = await getPeriodContext(merchantId);
  const periodKey = periodKeyFor(periodContext, new Date());

  const ruleSet = await prisma.loyaltyRuleSet.findFirst({
    where: { merchantId, isActive: true },
    orderBy: { createdAt: 'desc' },
    include: { tiers: { orderBy: { thresholdAmount: 'asc' } } },
  });
  if (!ruleSet) return [];

  const snapshots = await prisma.balanceSnapshot.findMany({
    where: { merchantId, periodKey },
    select: { cumulativeAmount: true },
  });

  const buckets: TierBucket[] = [
    { label: 'دون العتبة الأولى', thresholdAmount: null, discountPct: null, customers: 0 },
    ...ruleSet.tiers.map((t) => ({
      label: `${t.discountPct}٪`,
      thresholdAmount: t.thresholdAmount,
      discountPct: t.discountPct,
      customers: 0,
    })),
  ];

  for (const snapshot of snapshots) {
    // Walk down from the highest tier; the first one cleared is the customer's bucket.
    let index = 0;
    for (let i = ruleSet.tiers.length - 1; i >= 0; i -= 1) {
      const tier = ruleSet.tiers[i];
      if (tier && snapshot.cumulativeAmount >= tier.thresholdAmount) {
        index = i + 1;
        break;
      }
    }
    const bucket = buckets[index];
    if (bucket) bucket.customers += 1;
  }

  return buckets;
}

export interface CategorySplit {
  category: string;
  customers: number;
  linkedSales: number;
}

export async function getCategorySplit(merchantId: string): Promise<CategorySplit[]> {
  const rows = await prisma.$queryRaw<
    Array<{ category: string; customers: string; total: string | null }>
  >`
    SELECT
      c.category::TEXT           AS category,
      COUNT(DISTINCT c.id)::TEXT AS customers,
      SUM(t.amount::BIGINT)::TEXT AS total
    FROM customer c
    LEFT JOIN transaction t ON t.customer_id = c.id
    WHERE c.merchant_id = ${merchantId}::uuid
    GROUP BY c.category
    ORDER BY 3 DESC NULLS LAST
  `;

  return rows.map((r) => ({
    category: r.category,
    customers: toNumber(r.customers),
    linkedSales: toNumber(r.total),
  }));
}

export interface ReportSummary {
  /** Average invoices per active customer within the range. */
  visitFrequency: number;
  /** Average invoice value across the range. */
  averageBasket: number;
  /** Customers who reached at least one tier this period. */
  customersReachingThreshold: number;
  /**
   * Face value of discounts granted: the discount percentage applied to the spend
   * that earned it. An estimate of programme cost, not an accounting figure.
   */
  discountsGrantedEstimate: number;
  couponsIssued: number;
  couponsRedeemed: number;
  redemptionRate: number;
}

export async function getReportSummary(
  merchantId: string,
  range: ReportRange = '30d',
): Promise<ReportSummary> {
  const from = since(range);

  const [aggregate, distinctCustomers, couponsIssued, couponsRedeemed, redeemedRows] =
    await Promise.all([
      prisma.$queryRaw<Array<{ total: string | null; count: string }>>`
        SELECT SUM(amount::BIGINT)::TEXT AS total, COUNT(*)::TEXT AS count
        FROM transaction
        WHERE merchant_id = ${merchantId}::uuid AND occurred_at >= ${from}
      `,
      prisma.$queryRaw<Array<{ customers: string }>>`
        SELECT COUNT(DISTINCT customer_id)::TEXT AS customers
        FROM transaction
        WHERE merchant_id = ${merchantId}::uuid AND occurred_at >= ${from}
      `,
      prisma.coupon.count({ where: { merchantId, issuedAt: { gte: from } } }),
      prisma.coupon.count({ where: { merchantId, status: 'USED', redeemedAt: { gte: from } } }),
      prisma.$queryRaw<Array<{ total: string | null }>>`
        SELECT SUM((source_threshold_amount::BIGINT * discount_pct) / 100)::TEXT AS total
        FROM coupon
        WHERE merchant_id = ${merchantId}::uuid
          AND status = 'USED'
          AND redeemed_at >= ${from}
      `,
    ]);

  const totalSales = toNumber(aggregate[0]?.total);
  const transactionCount = toNumber(aggregate[0]?.count);
  const customers = toNumber(distinctCustomers[0]?.customers);

  const periodContext = await getPeriodContext(merchantId);
  const periodKey = periodKeyFor(periodContext, new Date());
  const ruleSet = await prisma.loyaltyRuleSet.findFirst({
    where: { merchantId, isActive: true },
    orderBy: { createdAt: 'desc' },
    include: { tiers: { orderBy: { thresholdAmount: 'asc' } } },
  });
  const firstThreshold = ruleSet?.tiers[0]?.thresholdAmount ?? Number.MAX_SAFE_INTEGER;

  const customersReachingThreshold = await prisma.balanceSnapshot.count({
    where: { merchantId, periodKey, cumulativeAmount: { gte: firstThreshold } },
  });

  return {
    visitFrequency: customers > 0 ? Math.round((transactionCount / customers) * 10) / 10 : 0,
    averageBasket: transactionCount > 0 ? Math.round(totalSales / transactionCount) : 0,
    customersReachingThreshold,
    discountsGrantedEstimate: toNumber(redeemedRows[0]?.total),
    couponsIssued,
    couponsRedeemed,
    redemptionRate: couponsIssued > 0 ? Math.round((couponsRedeemed / couponsIssued) * 100) : 0,
  };
}

export interface BranchHealth {
  id: string;
  name: string;
  code: string;
  isActive: boolean;
  /** Only Universal Mode (scanning) exists today — Tiers 1 and 2 are future work. */
  mode: 'SCAN' | 'API' | 'DB_AGENT';
  transactionsLast7Days: number;
  lastTransactionAt: string | null;
  pendingNotifications: number;
}

/**
 * Per-branch operating mode and sync health, for the Integrations screen
 * (CLAUDE.md §6.7 #1). Only scanning is active; API and DB Agent render as
 * "غير مفعّل" placeholders, and the §2.4 caution applies to the latter.
 */
export async function getBranchHealth(merchantId: string): Promise<BranchHealth[]> {
  const weekAgo = new Date();
  weekAgo.setUTCDate(weekAgo.getUTCDate() - 7);

  const branches = await prisma.branch.findMany({
    where: { merchantId },
    orderBy: { code: 'asc' },
  });

  const pendingNotifications = await prisma.notificationLog.count({
    where: { merchantId, status: 'PENDING' },
  });

  return Promise.all(
    branches.map(async (branch) => {
      const [recent, latest] = await Promise.all([
        prisma.transaction.count({
          where: { branchId: branch.id, occurredAt: { gte: weekAgo } },
        }),
        prisma.transaction.findFirst({
          where: { branchId: branch.id },
          orderBy: { occurredAt: 'desc' },
          select: { occurredAt: true },
        }),
      ]);

      return {
        id: branch.id,
        name: branch.name,
        code: branch.code,
        isActive: branch.isActive,
        mode: 'SCAN' as const,
        transactionsLast7Days: recent,
        lastTransactionAt: latest?.occurredAt.toISOString() ?? null,
        pendingNotifications,
      };
    }),
  );
}

export interface MerchantSettings {
  id: string;
  name: string;
  timezone: string;
  currency: string;
  branches: Array<{ id: string; name: string; code: string; isActive: boolean }>;
  staff: Array<{ id: string; name: string; username: string; role: string; branchCode: string | null; isActive: boolean }>;
  notificationProvider: string;
}

export async function getMerchantSettings(
  merchantId: string,
  notificationProvider: string,
): Promise<MerchantSettings> {
  const merchant = await prisma.merchant.findUniqueOrThrow({
    where: { id: merchantId },
    include: {
      branches: { orderBy: { code: 'asc' } },
      users: { orderBy: { username: 'asc' }, include: { branch: { select: { code: true } } } },
    },
  });

  return {
    id: merchant.id,
    name: merchant.name,
    timezone: merchant.timezone,
    currency: merchant.currency,
    branches: merchant.branches.map((b) => ({
      id: b.id,
      name: b.name,
      code: b.code,
      isActive: b.isActive,
    })),
    staff: merchant.users.map((u) => ({
      id: u.id,
      name: u.name,
      username: u.username,
      role: u.role,
      branchCode: u.branch?.code ?? null,
      isActive: u.isActive,
    })),
    notificationProvider,
  };
}
