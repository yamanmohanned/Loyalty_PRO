import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DASHBOARD_ROLES,
  LinkTransactionRequestSchema,
  TransactionListQuerySchema,
  type LinkTransactionRequest,
  type TransactionListQuery,
} from '@walaa/shared-types';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../plugins/auth';
import { linkTransaction, type LinkTransactionContext } from '../services/transaction.service';

/**
 * The core loop endpoint.
 *
 * Rate-limited more tightly than the rest of the API (CLAUDE.md §7.5): this is
 * where a compromised device could otherwise inflate balances at speed. The cap is
 * set well above a real register's pace — a busy lane links a few invoices a
 * minute, not sixty.
 */
export async function transactionRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: { body: LinkTransactionRequestSchema },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const context: LinkTransactionContext = {
        merchantId: auth.merchantId,
        userId: auth.sub,
        role: auth.role,
        userBranchId: auth.branchId,
      };

      const result = await linkTransaction(context, request.body as LinkTransactionRequest);
      reply.status(201);
      return result;
    },
  );

  /**
   * Transaction history. An assistant sees only their own branch's activity;
   * managers see everything (CLAUDE.md §7.2).
   */
  app.get('/', { schema: { querystring: TransactionListQuerySchema } }, async (request) => {
    const auth = requireAuth(request);
    const query = request.query as TransactionListQuery;

    const branchScope =
      DASHBOARD_ROLES.includes(auth.role) ? query.branchId : (auth.branchId ?? undefined);

    const where = {
      merchantId: auth.merchantId,
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(branchScope ? { branchId: branchScope } : {}),
      ...(query.from || query.to
        ? {
            occurredAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.transaction.count({ where }),
      prisma.transaction.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          branch: { select: { code: true } },
          customer: { select: { name: true, phone: true } },
        },
      }),
    ]);

    return {
      items: rows.map((t) => ({
        id: t.id,
        invoiceId: t.invoiceId,
        amount: t.amount,
        occurredAt: t.occurredAt.toISOString(),
        branchCode: t.branch.code,
        customerId: t.customerId,
        customerName: t.customer.name,
        amountCapture: t.amountCapture,
        source: t.source,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  });

  /** Look an invoice up before scanning, so a duplicate can be caught early. */
  app.get(
    '/by-invoice/:invoiceId',
    { schema: { params: z.object({ invoiceId: z.string().min(1).max(64) }).strict() } },
    async (request) => {
      const auth = requireAuth(request);
      const { invoiceId } = request.params as { invoiceId: string };

      const existing = await prisma.transaction.findFirst({
        where: {
          merchantId: auth.merchantId,
          invoiceId,
          ...(auth.branchId ? { branchId: auth.branchId } : {}),
        },
        include: { customer: { select: { name: true } } },
      });

      return {
        linked: Boolean(existing),
        customerName: existing?.customer.name ?? null,
        linkedAt: existing?.createdAt.toISOString() ?? null,
      };
    },
  );
}
