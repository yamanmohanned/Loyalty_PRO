import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  assessMargin,
  DASHBOARD_ROLES,
  UpdateDiscountRulesRequestSchema,
  UpdateDiscountSettingsRequestSchema,
  type UpdateDiscountRulesRequest,
  type UpdateDiscountSettingsRequest,
} from '@walaa/shared-types';
import { requireDashboardRole } from '../plugins/auth';
import {
  getDiscountConfiguration,
  updateDiscountRules,
  updateDiscountSettings,
} from '../services/discount-admin.service';
import { ALL_SETTLEMENT_STRATEGIES } from '../services/settlement';

/**
 * Discount configuration. Manager-only throughout — a station operator who could
 * move a threshold could mint themselves a discount.
 */
export async function discountRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (request) => {
    requireDashboardRole(request);
  });

  app.get('/', { config: { roles: DASHBOARD_ROLES } }, async (request) => {
    const auth = requireDashboardRole(request);
    const config = await getDiscountConfiguration(auth.merchantId);
    return {
      ...config,
      settlementStrategies: ALL_SETTLEMENT_STRATEGIES.map((s) => ({
        name: s.name,
        label: s.label,
        requiresSplitPayment: s.requiresSplitPayment,
      })),
    };
  });

  app.put(
    '/settings',
    { config: { roles: DASHBOARD_ROLES }, schema: { body: UpdateDiscountSettingsRequestSchema } },
    async (request) => {
      const auth = requireDashboardRole(request);
      const settings = await updateDiscountSettings(
        { merchantId: auth.merchantId, actorUserId: auth.sub },
        request.body as UpdateDiscountSettingsRequest,
      );
      return { settings };
    },
  );

  app.put(
    '/rules',
    { config: { roles: DASHBOARD_ROLES }, schema: { body: UpdateDiscountRulesRequestSchema } },
    async (request) => {
      const auth = requireDashboardRole(request);
      const rules = await updateDiscountRules(
        { merchantId: auth.merchantId, actorUserId: auth.sub },
        request.body as UpdateDiscountRulesRequest,
      );
      return { rules };
    },
  );

  /**
   * Live margin preview for the settings screen (§2.3).
   *
   * Pure computation — no writes, no persistence. It exists so the manager sees
   * the cost of a rate *as they type it*, before it can ever reach a till.
   */
  app.post(
    '/assess',
    {
      config: { roles: DASHBOARD_ROLES },
      schema: {
        body: z
          .object({
            thresholdAmount: z.number().int().positive(),
            discountType: z.enum(['PERCENTAGE', 'FIXED_AMOUNT']),
            discountRate: z.number().int().positive(),
            absoluteMaxDiscountValue: z.number().int().positive(),
            assumedNetMarginPct: z.number().int().min(1).max(100).optional(),
          })
          .strict(),
      },
    },
    async (request) => {
      const body = request.body as Parameters<typeof assessMargin>[0];
      return { assessment: assessMargin(body) };
    },
  );
}
