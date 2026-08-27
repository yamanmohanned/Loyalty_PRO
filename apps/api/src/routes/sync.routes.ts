import type { FastifyInstance } from 'fastify';
import { SyncBatchRequestSchema, type SyncBatchRequest } from '@walaa/shared-types';
import { requireAuth } from '../plugins/auth';
import { processSyncBatch } from '../services/sync.service';

/**
 * Offline batch sync (CLAUDE.md §5, §8). A device that has been offline may arrive
 * with a full queue, so the rate limit is per-batch rather than per-operation.
 */
export async function syncRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/batch',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: { body: SyncBatchRequestSchema },
    },
    async (request) => {
      const auth = requireAuth(request);
      return processSyncBatch(
        {
          merchantId: auth.merchantId,
          userId: auth.sub,
          role: auth.role,
          userBranchId: auth.branchId,
        },
        request.body as SyncBatchRequest,
      );
    },
  );
}
