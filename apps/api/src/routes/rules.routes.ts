import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CreateOverrideRequestSchema,
  DASHBOARD_ROLES,
  UpdateRuleSetRequestSchema,
  type CreateOverrideRequest,
  type UpdateRuleSetRequest,
} from '@walaa/shared-types';
import { requireDashboardRole } from '../plugins/auth';
import {
  createOverride,
  deleteOverride,
  getRuleSet,
  listOverrides,
  updateRuleSet,
} from '../services/rule-admin.service';

const IdParamSchema = z.object({ id: z.string().uuid('معرّف غير صالح') }).strict();

/**
 * Rule administration. Every route here is manager-or-owner only — an assistant
 * changing thresholds would be able to mint themselves discounts (CLAUDE.md §7.2).
 */
export async function ruleRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (request) => {
    requireDashboardRole(request);
  });

  app.get('/', { config: { roles: DASHBOARD_ROLES } }, async (request) => {
    const auth = requireDashboardRole(request);
    return { ruleSet: await getRuleSet(auth.merchantId) };
  });

  app.put(
    '/',
    { config: { roles: DASHBOARD_ROLES }, schema: { body: UpdateRuleSetRequestSchema } },
    async (request) => {
      const auth = requireDashboardRole(request);
      const ruleSet = await updateRuleSet(
        { merchantId: auth.merchantId, actorUserId: auth.sub },
        request.body as UpdateRuleSetRequest,
      );
      return { ruleSet };
    },
  );

  app.get('/overrides', { config: { roles: DASHBOARD_ROLES } }, async (request) => {
    const auth = requireDashboardRole(request);
    return { overrides: await listOverrides(auth.merchantId) };
  });

  app.post(
    '/overrides',
    { config: { roles: DASHBOARD_ROLES }, schema: { body: CreateOverrideRequestSchema } },
    async (request, reply) => {
      const auth = requireDashboardRole(request);
      const override = await createOverride(
        { merchantId: auth.merchantId, actorUserId: auth.sub },
        request.body as CreateOverrideRequest,
      );
      reply.status(201);
      return { override };
    },
  );

  app.delete(
    '/overrides/:id',
    { config: { roles: DASHBOARD_ROLES }, schema: { params: IdParamSchema } },
    async (request, reply) => {
      const auth = requireDashboardRole(request);
      const { id } = request.params as { id: string };
      await deleteOverride({ merchantId: auth.merchantId, overrideId: id, actorUserId: auth.sub });
      reply.status(204);
      return null;
    },
  );
}
