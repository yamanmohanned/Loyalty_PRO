import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DASHBOARD_ROLES, FeatureFlagKeySchema, STATION_ROLES } from '@loyalty-pro/shared-types';
import { requireAuth, requireDashboardRole } from '../plugins/auth';
import { getAllFlags, setFlag } from '../services/feature-flags.service';

/**
 * Feature flags (docs/legacy/CLAUDE_v3.md §8).
 *
 * Reading is open to the Station as well as the dashboard — the Station needs to know
 * whether card printing is on. Writing is manager-only. The Agent is on neither list: it
 * posts captures and reads nothing.
 */
export async function flagRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { config: { roles: STATION_ROLES } }, async (request) => {
    const auth = requireAuth(request);
    return { flags: await getAllFlags(auth.merchantId) };
  });

  app.put(
    '/:key',
    {
      config: { roles: DASHBOARD_ROLES },
      schema: {
        params: z.object({ key: FeatureFlagKeySchema }).strict(),
        body: z.object({ isEnabled: z.boolean() }).strict(),
      },
    },
    async (request) => {
      const auth = requireDashboardRole(request);
      const { key } = request.params as { key: string };
      const { isEnabled } = request.body as { isEnabled: boolean };

      return setFlag({
        merchantId: auth.merchantId,
        key,
        isEnabled,
        actorUserId: auth.sub,
      });
    },
  );
}
