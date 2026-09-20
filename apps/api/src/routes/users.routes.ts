import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DASHBOARD_ROLES,
  type CreateUserRequest,
  CreateUserRequestSchema,
  type StaffListResponse,
  type UpdateUserRequest,
  UpdateUserRequestSchema,
} from '@loyalty-pro/shared-types';
import { requireAuth, requireDashboardRole } from '../plugins/auth';
import { clearLock } from '../services/lockout.service';
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

  /**
   * Lifts a temporary lock immediately (FND-01).
   *
   * The reason this endpoint exists is that the lock's own worst case is a till that
   * cannot sign in during trading hours — the usernames are guessable, so anybody on the
   * shop's network can trip it. The remedy has to be somebody already standing in the
   * shop, not a five-minute wait with a queue and not a support call.
   *
   * MANAGER as well as OWNER, unlike every other route in this file. Creating and
   * editing staff reshapes who can do what and is the owner's; clearing a lock restores
   * an account to exactly the state it was in a minute ago and grants nothing — and the
   * person standing beside a stuck till is usually the manager.
   *
   * Rate-limited harder than it needs to be for its cost, because an unlock loop would
   * otherwise let somebody who has a manager token keep an account permanently
   * unlockable while they guess at it.
   */
  app.post(
    '/:id/unlock',
    {
      config: { roles: DASHBOARD_ROLES, rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: { params: IdParamSchema },
    },
    async (request, reply) => {
      const auth = requireDashboardRole(request);
      const { id } = request.params as { id: string };

      const { cleared } = await clearLock(auth.merchantId, id, auth.sub);
      if (!cleared) {
        return reply
          .code(404)
          .send({ error: { code: 'NOT_FOUND', message: 'لا يوجد حساب بهذا المعرّف.' } });
      }
      return { unlocked: true };
    },
  );
}
