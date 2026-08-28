import type { FastifyInstance } from 'fastify';
import { ScanCardRequestSchema, STATION_ROLES, type ScanCardRequest } from '@walaa/shared-types';
import { requireAuth } from '../plugins/auth';
import { scanCard } from '../services/scan.service';

/**
 * The Loyalty Station's endpoint (CLAUDE_v3.md §6.2).
 *
 * One call, three outcomes: qualified, progress, or unknown card. Reachable by
 * STATION as well as manager roles — this is the station's entire job.
 */
export async function scanRoutes(app: FastifyInstance): Promise<void> {
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
