import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DASHBOARD_ROLES, RedeemVoucherRequestSchema, STATION_ROLES } from '@walaa/shared-types';
import { requireAuth, requireDashboardRole } from '../plugins/auth';
import { isEnabled } from '../services/feature-flags.service';
import { reconcileDay, redeemVoucher, voidVoucher } from '../services/voucher.service';

const IdParamSchema = z.object({ id: z.string().uuid('معرّف غير صالح') }).strict();

export async function voucherRoutes(app: FastifyInstance): Promise<void> {
  /** Redemption happens at the till, so the station may perform it. */
  app.post(
    '/:id/redeem',
    {
      config: { roles: STATION_ROLES, rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: { params: IdParamSchema, body: RedeemVoucherRequestSchema },
    },
    async (request) => {
      const auth = requireAuth(request);
      const { id } = request.params as { id: string };
      const result = await redeemVoucher({
        merchantId: auth.merchantId,
        voucherId: id,
        actorUserId: auth.sub,
      });
      return { voucher: result.voucher, accountingNote: result.accountingNote };
    },
  );

  /** Voiding is a manager action — it writes off a discount that was granted. */
  app.post(
    '/:id/void',
    {
      config: { roles: DASHBOARD_ROLES },
      schema: {
        params: IdParamSchema,
        body: z.object({ reason: z.string().trim().min(1).max(280) }).strict(),
      },
    },
    async (request, reply) => {
      const auth = requireDashboardRole(request);
      const { id } = request.params as { id: string };
      const { reason } = request.body as { reason: string };
      await voidVoucher({
        merchantId: auth.merchantId,
        voucherId: id,
        actorUserId: auth.sub,
        reason,
      });
      reply.status(204);
      return null;
    },
  );

  /** End-of-day reconciliation, gated by its feature flag (§8). */
  app.get(
    '/reconciliation',
    {
      config: { roles: DASHBOARD_ROLES },
      schema: {
        querystring: z
          .object({
            /**
             * A local calendar date, `YYYY-MM-DD`.
             *
             * Validated rather than passed through: `new Date('anything')` yields an
             * Invalid Date, which reaches Prisma as a filter it cannot serialise and
             * `toISOString()` as a RangeError. A query parameter that turns a typo into
             * a 500 is validation in name only (§7.4).
             */
            date: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/, 'التاريخ يجب أن يكون بصيغة YYYY-MM-DD')
              .refine((value) => !Number.isNaN(Date.parse(value)), 'تاريخ غير صالح')
              .optional(),
          })
          .strict(),
      },
    },
    async (request, reply) => {
      const auth = requireDashboardRole(request);

      if (!(await isEnabled(auth.merchantId, 'voucher_reconciliation'))) {
        reply.status(404);
        return {
          error: {
            code: 'NOT_FOUND',
            message: 'وحدة تسوية القسائم غير مفعّلة',
            requestId: request.id,
          },
        };
      }

      const { date } = request.query as { date?: string };
      // Passed through as the calendar date it is. Converting it to an instant here
      // would mean choosing an hour, and every choice is wrong in some timezone.
      return { reconciliation: await reconcileDay(auth.merchantId, date ?? new Date()) };
    },
  );
}
