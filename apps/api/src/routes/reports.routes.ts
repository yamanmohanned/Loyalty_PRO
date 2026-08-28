import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DASHBOARD_ROLES } from '@walaa/shared-types';
import { loadEnv } from '../config/env';
import { requireDashboardRole } from '../plugins/auth';
import {
  getBranchHealth,
  getCategorySplit,
  getMerchantSettings,
  getOverview,
  getReportSummary,
  getSalesTimeseries,
  getTierDistribution,
  getTopCustomers,
  type ReportRange,
} from '../services/reports.service';

const env = loadEnv();

const RangeQuerySchema = z
  .object({ range: z.enum(['7d', '30d', '90d', '365d']).default('30d') })
  .strict();

const TopQuerySchema = z
  .object({
    range: z.enum(['7d', '30d', '90d', '365d']).default('30d'),
    limit: z.coerce.number().int().min(1).max(50).default(5),
  })
  .strict();

/**
 * Reporting. Every route is OWNER/MANAGER only — an assistant executes the core
 * loop and looks customers up, and does not see the merchant's financials
 * (CLAUDE.md §7.2).
 */
export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (request) => {
    requireDashboardRole(request);
  });

  app.get(
    '/overview',
    { config: { roles: DASHBOARD_ROLES }, schema: { querystring: RangeQuerySchema } },
    async (request) => {
      const auth = requireDashboardRole(request);
      const { range } = request.query as { range: ReportRange };
      const [kpis, timeseries, topCustomers] = await Promise.all([
        getOverview(auth.merchantId, range),
        getSalesTimeseries(auth.merchantId, range),
        getTopCustomers(auth.merchantId, 5),
      ]);
      return { kpis, timeseries, topCustomers };
    },
  );

  app.get(
    '/summary',
    { config: { roles: DASHBOARD_ROLES }, schema: { querystring: RangeQuerySchema } },
    async (request) => {
      const auth = requireDashboardRole(request);
      const { range } = request.query as { range: ReportRange };
      const [summary, timeseries, tiers, categories] = await Promise.all([
        getReportSummary(auth.merchantId, range),
        getSalesTimeseries(auth.merchantId, range),
        getTierDistribution(auth.merchantId),
        getCategorySplit(auth.merchantId),
      ]);
      return { summary, timeseries, tiers, categories };
    },
  );

  app.get(
    '/top-customers',
    { config: { roles: DASHBOARD_ROLES }, schema: { querystring: TopQuerySchema } },
    async (request) => {
      const auth = requireDashboardRole(request);
      const { limit } = request.query as { limit: number };
      return { topCustomers: await getTopCustomers(auth.merchantId, limit) };
    },
  );

  /** Integrations screen: per-branch operating mode and sync health (§6.7 #1). */
  app.get('/integrations', { config: { roles: DASHBOARD_ROLES } }, async (request) => {
    const auth = requireDashboardRole(request);
    return { branches: await getBranchHealth(auth.merchantId) };
  });

  app.get('/settings', { config: { roles: DASHBOARD_ROLES } }, async (request) => {
    const auth = requireDashboardRole(request);
    return {
      settings: await getMerchantSettings(auth.merchantId, env.NOTIFICATION_PROVIDER),
    };
  });
}
