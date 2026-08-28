import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DASHBOARD_ROLES } from '@walaa/shared-types';
import { requireDashboardRole } from '../plugins/auth';
import { getOverview, getProgrammeReport, type ReportRange } from '../services/reports.service';

const RangeQuerySchema = z
  .object({ range: z.enum(['7d', '30d', '90d', '365d']).default('30d') })
  .strict();

/** Reporting is manager-only — a station operator sees no financials (§7.2). */
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
      return { overview: await getOverview(auth.merchantId, range) };
    },
  );

  app.get(
    '/programme',
    { config: { roles: DASHBOARD_ROLES }, schema: { querystring: RangeQuerySchema } },
    async (request) => {
      const auth = requireDashboardRole(request);
      const { range } = request.query as { range: ReportRange };
      return { report: await getProgrammeReport(auth.merchantId, range) };
    },
  );
}
