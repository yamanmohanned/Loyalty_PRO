import type { FastifyInstance } from 'fastify';
import { SyncBatchRequestSchema, type SyncBatchRequest } from '@walaa/shared-types';
import { requireAuth } from '../plugins/auth';
import { processSyncBatch } from '../services/sync.service';

/**
 * Offline batch flush (CLAUDE_v3.md §7.2). A device that has been offline may
 * arrive with a full queue, so the limit is per-batch rather than per-operation.
 */
export async function syncRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/batch',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: { body: SyncBatchRequestSchema },
    },
    async (request) => {
      const auth = requireAuth(request);
      const body = request.body as SyncBatchRequest;

      return processSyncBatch(
        {
          merchantId: auth.merchantId,
          userId: auth.sub,
          branchId: auth.branchId,
          deviceId: body.deviceId,
        },
        body,
      );
    },
  );
}
