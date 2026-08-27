import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RedeemCouponRequestSchema } from '@walaa/shared-types';
import { requireAuth } from '../plugins/auth';
import { redeemCoupon } from '../services/coupon.service';

const IdParamSchema = z.object({ id: z.string().uuid('معرّف غير صالح') }).strict();

export async function couponRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Redemption. Reachable by assistants: the discount is applied by hand on the
   * main register, and this call records that it happened (CLAUDE.md §6.7 #5).
   */
  app.post(
    '/:id/redeem',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: { params: IdParamSchema, body: RedeemCouponRequestSchema },
    },
    async (request) => {
      const auth = requireAuth(request);
      const { id } = request.params as { id: string };
      return redeemCoupon({
        merchantId: auth.merchantId,
        couponId: id,
        actorUserId: auth.sub,
      });
    },
  );
}
