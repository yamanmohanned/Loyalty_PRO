import type { FastifyInstance } from 'fastify';
import {
  IdentifyCardRequestSchema,
  ScanCardRequestSchema,
  STATION_ROLES,
  type IdentifyCardRequest,
  type ScanCardRequest,
} from '@loyalty-pro/shared-types';
import { requireAuth } from '../plugins/auth';
import { identifyCard, scanCard } from '../services/scan.service';

/**
 * The Loyalty Station's endpoint (docs/legacy/CLAUDE_v3.md §6.2).
 *
 * Two calls, in the order the core loop demands (CLAUDE.md §0 rule 1): `/identify`
 * answers *who is this* and writes nothing, then `/card` attributes the invoice and
 * settles it. Both reachable by STATION as well as manager roles — this is the
 * station's entire job.
 */
export async function scanRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Step 1 — read the card, change nothing.
   *
   * Rate-limited a little more generously than `/card`: a mis-scan at step 1 costs
   * nothing and gets repeated, whereas every `/card` call is a sale being claimed.
   */
  app.post(
    '/identify',
    {
      config: { roles: STATION_ROLES, rateLimit: { max: 180, timeWindow: '1 minute' } },
      schema: { body: IdentifyCardRequestSchema },
    },
    async (request) => {
      const auth = requireAuth(request);
      const body = request.body as IdentifyCardRequest;

      return identifyCard(
        {
          merchantId: auth.merchantId,
          userId: auth.sub,
          branchId: auth.branchId,
        },
        body,
      );
    },
  );

  app.post(
    '/card',
    {
      config: { roles: STATION_ROLES, rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: { body: ScanCardRequestSchema },
    },
    async (request) => {
      const auth = requireAuth(request);
      const body = request.body as ScanCardRequest;

      return scanCard(
        {
          merchantId: auth.merchantId,
          userId: auth.sub,
          branchId: auth.branchId,
          stationId: body.stationId,
        },
        body,
      );
    },
  );
}
