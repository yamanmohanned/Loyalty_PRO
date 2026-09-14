import type { FastifyInstance } from 'fastify';
import {
  ActivateLicenseRequestSchema,
  DASHBOARD_ROLES,
  EnterUnlockRequestSchema,
  STATION_ROLES,
  type ActivateLicenseRequest,
  type EnterUnlockRequest,
} from '@walaa/shared-types';
import { requireAuth, requireDashboardRole } from '../plugins/auth';
import {
  activateLicense,
  enterUnlock,
  licenseOverview,
  licenseState,
  listLicenseEvents,
} from '../services/license.service';

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

  /**
   * An emergency code the provider read over the phone. The rate limit is far above
   * any honest use and far below any use against a 64-bit code.
   */
  app.post(
    '/unlock',
    {
      config: { roles: DASHBOARD_ROLES, rateLimit: { max: 20, timeWindow: '1 hour' } },
      schema: { body: EnterUnlockRequestSchema },
    },
    async (request) => {
      const auth = requireDashboardRole(request);
      const { code } = request.body as EnterUnlockRequest;
      return enterUnlock({ merchantId: auth.merchantId, userId: auth.sub }, code);
    },
  );

  /** Every licence event recorded here: activations, phone codes, clock events. */
  app.get('/events', { config: { roles: DASHBOARD_ROLES } }, async (request) => {
    requireDashboardRole(request);
    return listLicenseEvents();
  });
}
