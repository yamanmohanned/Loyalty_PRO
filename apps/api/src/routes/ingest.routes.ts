import type { FastifyInstance } from 'fastify';
import { IngestInvoiceRequestSchema, type IngestInvoiceRequest } from '@walaa/shared-types';
import { requireAuth } from '../plugins/auth';
import { ingestInvoice } from '../services/ingestion.service';

/**
 * The Print Capture Agent's endpoint (CLAUDE_v3.md §4).
 *
 * Rate limit is generous: a store that was offline may flush a backlog the moment
 * the network returns, and throttling that would delay exactly the recovery the
 * queue exists for.
 */
export async function ingestRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/invoice',
    {
      config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
      schema: { body: IngestInvoiceRequestSchema },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const body = request.body as IngestInvoiceRequest;

      const result = await ingestInvoice(
        {
          merchantId: auth.merchantId,
          userId: auth.sub,
          userBranchId: auth.branchId,
          agentId: body.agentId,
        },
        body.invoice,
      );

      // 200 for a duplicate, 201 for a new capture. A retry is a success from the
      // agent's side — its job was to make sure the capture landed, and it has.
      reply.status(result.duplicate ? 200 : 201);
      return result;
    },
  );
}
