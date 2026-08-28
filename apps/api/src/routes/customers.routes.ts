import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CreateCustomerRequestSchema,
  CustomerSearchQuerySchema,
  DASHBOARD_ROLES,
  ResolveCustomerQuerySchema,
  STATION_ROLES,
  UpdateCustomerRequestSchema,
  type CreateCustomerRequest,
  type UpdateCustomerRequest,
} from '@walaa/shared-types';
import { requireAuth, requireDashboardRole } from '../plugins/auth';
import { getCustomerBalance } from '../services/balance.service';
import {
  createCustomer,
  getCustomer,
  getCustomerCard,
  resolveCustomer,
  searchCustomers,
  updateCustomer,
} from '../services/customer.service';

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

  /**
   * Reprint lookup (§6.2 #5): find a customer who has lost their card, by card
   * number, phone, or name.
   *
   * Rate-limited harder than `/resolve`. This is the only endpoint that can return
   * more than one customer for a partial input, so it is the only one where repeated
   * calls could be used to walk the customer list rather than to answer a question.
   */
  app.get(
    '/search',
    {
      config: { roles: STATION_ROLES, rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: { querystring: CustomerSearchQuerySchema },
    },
    async (request) => {
      const auth = requireAuth(request);
      const { query } = request.query as { query: string };
      return searchCustomers(auth.merchantId, query);
    },
  );

  /**
   * The card details for a reprint — the same number, never a new one.
   *
   * Separate from `/search` so that a name search returns a list with no card
   * numbers in it, and the number is fetched one customer at a time, after the
   * operator has confirmed who is standing in front of them.
   */
  app.get(
    '/:id/card',
    {
      config: { roles: STATION_ROLES, rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: { params: IdParamSchema },
    },
    async (request) => {
      const auth = requireAuth(request);
      const { id } = request.params as { id: string };
      return { card: await getCustomerCard(auth.merchantId, id) };
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

  /** Customer detail. V3-2 adds transactions, vouchers and rule origin. */
  app.get(
    '/:id',
    { config: { roles: DASHBOARD_ROLES }, schema: { params: IdParamSchema } },
    async (request) => {
      const auth = requireDashboardRole(request);
      const { id } = request.params as { id: string };
      const [customer, balance] = await Promise.all([
        getCustomer(auth.merchantId, id),
        getCustomerBalance(auth.merchantId, id),
      ]);
      return { customer, balance };
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
}
