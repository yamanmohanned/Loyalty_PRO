import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CreateCustomerRequestSchema,
  CustomerListQuerySchema,
  DASHBOARD_ROLES,
  ResolveCustomerQuerySchema,
  UpdateCustomerRequestSchema,
  type CreateCustomerRequest,
  type CustomerListQuery,
  type UpdateCustomerRequest,
} from '@walaa/shared-types';
import { requireAuth, requireDashboardRole } from '../plugins/auth';
import { listCustomerCoupons } from '../services/coupon.service';
import {
  createCustomer,
  getCustomer,
  listCustomers,
  resolveCustomer,
  updateCustomer,
} from '../services/customer.service';
import { getPeriodContext, periodKeyFor, resolveEffectiveRules } from '../services/rules.service';
import { getCustomerBalance } from '../services/transaction.service';
import { prisma } from '../lib/prisma';

const IdParamSchema = z.object({ id: z.string().uuid('معرّف غير صالح') }).strict();

export async function customerRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Resolve a customer at the register, by QR token or phone (CLAUDE.md §1.4).
   * Rate-limited: it is the one endpoint that could be used to probe whether a
   * given phone number belongs to a customer.
   */
  app.get(
    '/resolve',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: { querystring: ResolveCustomerQuerySchema },
    },
    async (request) => {
      const auth = requireAuth(request);
      const { identifier } = request.query as { identifier: string };
      const customer = await resolveCustomer(auth.merchantId, identifier);
      const balance = await getCustomerBalance(auth.merchantId, customer.id);
      return { customer, balance };
    },
  );

  /** Registration. Assistants may register customers — it is part of the core loop. */
  app.post('/', { schema: { body: CreateCustomerRequestSchema } }, async (request, reply) => {
    const auth = requireAuth(request);
    const customer = await createCustomer(
      { merchantId: auth.merchantId, actorUserId: auth.sub },
      request.body as CreateCustomerRequest,
    );
    reply.status(201);
    return { customer };
  });

  /** Dashboard listing — managers only; an assistant has no reason to browse customers. */
  app.get(
    '/',
    {
      config: { roles: DASHBOARD_ROLES },
      schema: { querystring: CustomerListQuerySchema },
    },
    async (request) => {
      const auth = requireDashboardRole(request);
      const periodContext = await getPeriodContext(auth.merchantId);
      const periodKey = periodKeyFor(periodContext, new Date());
      return listCustomers(auth.merchantId, request.query as CustomerListQuery, periodKey);
    },
  );

  /** Full customer detail: balance, effective rules, recent transactions, coupons. */
  app.get(
    '/:id',
    { config: { roles: DASHBOARD_ROLES }, schema: { params: IdParamSchema } },
    async (request) => {
      const auth = requireDashboardRole(request);
      const { id } = request.params as { id: string };

      const customer = await getCustomer(auth.merchantId, id);
      const [balance, rules, coupons, transactions] = await Promise.all([
        getCustomerBalance(auth.merchantId, id),
        resolveEffectiveRules(auth.merchantId, id),
        listCustomerCoupons(auth.merchantId, id),
        prisma.transaction.findMany({
          where: { customerId: id, merchantId: auth.merchantId },
          orderBy: { occurredAt: 'desc' },
          take: 25,
          include: { branch: { select: { code: true } } },
        }),
      ]);

      return {
        customer,
        balance,
        // Which layer supplied the rules, so the screen can explain why this
        // customer's threshold differs from everyone else's (CLAUDE.md §13.3).
        rules: { origin: rules.origin, tiers: rules.tiers },
        coupons,
        transactions: transactions.map((t) => ({
          id: t.id,
          invoiceId: t.invoiceId,
          amount: t.amount,
          occurredAt: t.occurredAt.toISOString(),
          branchCode: t.branch.code,
          amountCapture: t.amountCapture,
        })),
      };
    },
  );

  app.patch(
    '/:id',
    {
      config: { roles: DASHBOARD_ROLES },
      schema: { params: IdParamSchema, body: UpdateCustomerRequestSchema },
    },
    async (request) => {
      const auth = requireDashboardRole(request);
      const { id } = request.params as { id: string };
      const customer = await updateCustomer(
        { merchantId: auth.merchantId, customerId: id, actorUserId: auth.sub },
        request.body as UpdateCustomerRequest,
      );
      return { customer };
    },
  );

  /** A customer's coupons. Reachable by assistants — redemption happens at the register. */
  app.get('/:id/coupons', { schema: { params: IdParamSchema } }, async (request) => {
    const auth = requireAuth(request);
    const { id } = request.params as { id: string };
    return { coupons: await listCustomerCoupons(auth.merchantId, id) };
  });
}
