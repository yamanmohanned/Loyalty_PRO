import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API_PREFIX, buildApp } from '../app';
import {
  getBranchHealth,
  getOverview,
  getReportSummary,
  getSalesTimeseries,
  getTierDistribution,
} from '../services/reports.service';
import { linkTransaction, type LinkTransactionContext } from '../services/transaction.service';
import { resetDatabase } from './helpers/db';
import { createWorld, invoice, TEST_PASSWORD, type World } from './helpers/fixtures';

/**
 * Reporting aggregates, and the constraint that governs them.
 */

const prisma = new PrismaClient();
let app: FastifyInstance;
let world: World;
let assistant: LinkTransactionContext;

const link = (id: string, amount: number, occurredAt?: string) =>
  linkTransaction(assistant, {
    customerId: world.customerId,
    invoice: invoice({ invoice_id: id, amount, occurred_at: occurredAt }),
  });

beforeAll(async () => {
  app = await buildApp({ rateLimit: false });
  await app.ready();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  world = await createWorld(prisma);
  assistant = {
    merchantId: world.merchantId,
    userId: world.assistantId,
    role: 'ASSISTANT',
    userBranchId: world.branchId,
  };
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('overview KPIs', () => {
  it('counts customers, invoices and linked sales', async () => {
    await link('INV-1', 40_000);
    await link('INV-2', 60_000);

    const kpis = await getOverview(world.merchantId, '30d');

    expect(kpis.totalCustomers).toBe(1);
    expect(kpis.transactionsInRange).toBe(2);
    expect(kpis.linkedSalesInRange).toBe(100_000);
    // 100,000 crosses the first tier, so one coupon is live.
    expect(kpis.activeCoupons).toBe(1);
    expect(kpis.activeCustomersThisPeriod).toBe(1);
  });

  it('excludes transactions outside the range', async () => {
    const longAgo = new Date();
    longAgo.setUTCDate(longAgo.getUTCDate() - 200);

    await link('INV-OLD', 500_000, longAgo.toISOString());
    await link('INV-NEW', 25_000);

    const thirtyDays = await getOverview(world.merchantId, '30d');
    expect(thirtyDays.transactionsInRange).toBe(1);
    expect(thirtyDays.linkedSalesInRange).toBe(25_000);

    const fullYear = await getOverview(world.merchantId, '365d');
    expect(fullYear.transactionsInRange).toBe(2);
    expect(fullYear.linkedSalesInRange).toBe(525_000);
  });
});

describe('money aggregation (CLAUDE.md §13.5)', () => {
  it('sums past Int32 without overflowing', async () => {
    // Per-row money is a bounded Int32, but an all-time total is not. Rows near the
    // ceiling would overflow a 32-bit accumulator; the BIGINT cast is what prevents
    // it. This is the test that fails first if someone removes that cast.
    const near = 2_000_000_000; // just under Int32 max, valid for a single row
    for (let i = 0; i < 3; i += 1) {
      await prisma.transaction.create({
        data: {
          merchantId: world.merchantId,
          branchId: world.branchId,
          customerId: world.customerId,
          invoiceId: `INV-BIG-${i}`,
          amount: near,
          currency: 'IQD',
          occurredAt: new Date(),
          source: 'SCAN',
          amountCapture: 'MANUAL',
          periodKey: '2026-08',
          linkedByUserId: world.assistantId,
        },
      });
    }

    const kpis = await getOverview(world.merchantId, '30d');

    // 6,000,000,000 — nearly three times Int32 max.
    expect(kpis.linkedSalesInRange).toBe(6_000_000_000);
    expect(kpis.linkedSalesInRange).toBeGreaterThan(2_147_483_647);
    expect(Number.isSafeInteger(kpis.linkedSalesInRange)).toBe(true);
  });
});

describe('timeseries', () => {
  it('groups linked sales by local day', async () => {
    await link('INV-1', 10_000, '2026-08-10T09:00:00Z');
    await link('INV-2', 15_000, '2026-08-10T14:00:00Z');
    await link('INV-3', 20_000, '2026-08-11T09:00:00Z');

    const series = await getSalesTimeseries(world.merchantId, '365d');
    const tenth = series.find((p) => p.date === '2026-08-10');
    const eleventh = series.find((p) => p.date === '2026-08-11');

    expect(tenth?.amount).toBe(25_000);
    expect(tenth?.count).toBe(2);
    expect(eleventh?.amount).toBe(20_000);
  });

  it('files a late-night sale under the local day', async () => {
    // 22:00 UTC is already the next day in Baghdad. A chart that showed this on the
    // previous day would not match what the shop experienced.
    await link('INV-LATE', 30_000, '2026-08-10T22:00:00Z');

    const series = await getSalesTimeseries(world.merchantId, '365d');
    expect(series.find((p) => p.date === '2026-08-11')?.amount).toBe(30_000);
  });
});

describe('tier distribution', () => {
  it('places each customer in the highest tier they have cleared', async () => {
    await link('INV-1', 260_000); // clears 100k and 250k → belongs in the 250k bucket

    const buckets = await getTierDistribution(world.merchantId);
    const byThreshold = Object.fromEntries(
      buckets.map((b) => [b.thresholdAmount ?? 'below', b.customers]),
    );

    expect(byThreshold['below']).toBe(0);
    expect(byThreshold[100_000]).toBe(0);
    expect(byThreshold[250_000]).toBe(1);
    expect(byThreshold[500_000]).toBe(0);
  });
});

describe('report summary', () => {
  it('computes basket size and redemption rate', async () => {
    await link('INV-1', 30_000);
    await link('INV-2', 50_000);

    const summary = await getReportSummary(world.merchantId, '30d');

    expect(summary.averageBasket).toBe(40_000);
    expect(summary.visitFrequency).toBe(2);
    expect(summary.couponsIssued).toBe(0);
    expect(summary.redemptionRate).toBe(0);
  });
});

describe('integrations health', () => {
  it('reports every branch as scanning mode with its recent activity', async () => {
    await link('INV-1', 10_000);

    const branches = await getBranchHealth(world.merchantId);
    const primary = branches.find((b) => b.code === 'BAG-01');
    const secondary = branches.find((b) => b.code === 'BAG-02');

    // Only Universal Mode exists today; API and DB Agent are future tiers (§2.2).
    expect(branches.every((b) => b.mode === 'SCAN')).toBe(true);
    expect(primary?.transactionsLast7Days).toBe(1);
    expect(primary?.lastTransactionAt).not.toBeNull();
    expect(secondary?.transactionsLast7Days).toBe(0);
  });
});

describe('reporting is manager-only (CLAUDE.md §7.2)', () => {
  async function tokenFor(username: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/auth/login`,
      payload: { username, password: TEST_PASSWORD },
    });
    return res.json().tokens.accessToken as string;
  }

  it('refuses an assistant', async () => {
    const token = await tokenFor('assistant');
    for (const path of ['/reports/overview', '/reports/summary', '/reports/settings']) {
      const res = await app.inject({
        method: 'GET',
        url: `${API_PREFIX}${path}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode, path).toBe(403);
    }
  });

  it('serves a manager', async () => {
    const token = await tokenFor('manager');
    const res = await app.inject({
      method: 'GET',
      url: `${API_PREFIX}/reports/overview?range=30d`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('kpis.totalCustomers');
    expect(body).toHaveProperty('timeseries');
    expect(body).toHaveProperty('topCustomers');
  });
});
