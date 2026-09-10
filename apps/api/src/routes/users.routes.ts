import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  type CreateUserRequest,
  CreateUserRequestSchema,
  type StaffListResponse,
  type UpdateUserRequest,
  UpdateUserRequestSchema,
} from '@walaa/shared-types';
import { requireAuth } from '../plugins/auth';
import { createStaffUser, listStaff, updateStaffUser } from '../services/user.service';

const IdParamSchema = z.object({ id: z.string().uuid('معرّف غير صالح') }).strict();

/**
 * Staff accounts — the till's login, and any second manager.
 *
 * ── OWNER only, on every route ───────────────────────────────────────────────
 *
 * Not `DASHBOARD_ROLES`. A MANAGER can read reports and set discount rules; creating
 * logins is the one act that widens who can reach the shop at all, and it belongs to
 * the person whose password was written down with the merchant on installation day.
 * A MANAGER who could mint a STATION account could mint themselves a second identity
 * that the audit trail attributes to the till.
 *
 * The roles this can produce are constrained by the SCHEMA (`StaffRoleSchema` is
 * `MANAGER | STATION`), not by a check here — so "no second OWNER" holds for any caller
 * that reaches the route, including one that skips whatever this file remembers to
 * validate.
 *
 * ── Why the limits are tight ─────────────────────────────────────────────────
 *
 * Creating a staff account is something a shop does a handful of times in its life.
 * Anything hammering it is not a merchant, and this is the one authenticated surface
 * that mints credentials.
 */
export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/',
    { config: { roles: ['OWNER'], rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request): Promise<StaffListResponse> => {
      const auth = requireAuth(request);
      return listStaff(auth.merchantId);
    },
  );

  app.post(
    '/',
    {
      config: { roles: ['OWNER'], rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { body: CreateUserRequestSchema },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const created = await createStaffUser(request.body as CreateUserRequest, {
        merchantId: auth.merchantId,
        userId: auth.sub,
      });
      return reply.code(201).send(created);
    },
  );

  app.patch(
    '/:id',
    {
      config: { roles: ['OWNER'], rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: { params: IdParamSchema, body: UpdateUserRequestSchema },
    },
    async (request) => {
      const auth = requireAuth(request);
      const { id } = request.params as { id: string };
      await updateStaffUser(id, request.body as UpdateUserRequest, {
        merchantId: auth.merchantId,
        userId: auth.sub,
      });
      return { updated: true };
    },
  );
}
