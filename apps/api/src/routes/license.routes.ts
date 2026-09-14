import type { FastifyInstance } from 'fastify';
import {
  ActivateLicenseRequestSchema,
  DASHBOARD_ROLES,
  STATION_ROLES,
  type ActivateLicenseRequest,
} from '@walaa/shared-types';
import { requireAuth, requireDashboardRole } from '../plugins/auth';
import { activateLicense, licenseOverview, licenseState } from '../services/license.service';

/**
 * Licensing (packaging/LICENSING.md).
 *
 * The state is readable by the till as well as the dashboard: a cashier deserves to know
 * the program is read-only before scanning, not only after a refusal. Activating is
 * dashboard-only — it is done from Settings on the manager PC.
 */
export async function licenseRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { config: { roles: STATION_ROLES } }, async (request) => {
    requireAuth(request);
    return licenseState();
  });

  app.get('/activations', { config: { roles: DASHBOARD_ROLES } }, async (request) => {
    requireDashboardRole(request);
    return licenseOverview();
  });

  app.post(
    '/activate',
    {
      config: { roles: DASHBOARD_ROLES, rateLimit: { max: 20, timeWindow: '1 hour' } },
      schema: { body: ActivateLicenseRequestSchema },
    },
    async (request) => {
      const auth = requireDashboardRole(request);
      const { code } = request.body as ActivateLicenseRequest;
      return activateLicense({ merchantId: auth.merchantId, userId: auth.sub }, code);
    },
  );
}
