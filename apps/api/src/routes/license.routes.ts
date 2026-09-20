import type { FastifyInstance } from 'fastify';
import {
  ActivateLicenseRequestSchema,
  DASHBOARD_ROLES,
  EnterUnlockRequestSchema,
  STATION_ROLES,
  type ActivateLicenseRequest,
  type EnterUnlockRequest,
} from '@loyalty-pro/shared-types';
import { requireAuth, requireDashboardRole } from '../plugins/auth';
import { applyHeldSales, withHeldSummary } from '../services/held-sale.service';
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
    return withHeldSummary(await licenseState());
  });

  app.get('/activations', { config: { roles: DASHBOARD_ROLES } }, async (request) => {
    requireDashboardRole(request);
    const overview = await licenseOverview();
    return { ...overview, state: await withHeldSummary(overview.state) };
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
      const result = await activateLicense({ merchantId: auth.merchantId, userId: auth.sub }, code);
      // Sales held while read-only are credited with the request that ends it.
      await applyHeldSales();
      return { ...result, state: await withHeldSummary(await licenseState()) };
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
      const result = await enterUnlock({ merchantId: auth.merchantId, userId: auth.sub }, code);
      await applyHeldSales();
      return { ...result, state: await withHeldSummary(await licenseState()) };
    },
  );

  /** Every licence event recorded here: activations, phone codes, clock events. */
  app.get('/events', { config: { roles: DASHBOARD_ROLES } }, async (request) => {
    requireDashboardRole(request);
    return listLicenseEvents();
  });
}
