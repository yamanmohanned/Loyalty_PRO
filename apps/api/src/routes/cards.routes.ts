import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DASHBOARD_ROLES,
  ExportCardBatchRequestSchema,
  GenerateCardBatchRequestSchema,
  ReplaceCardRequestSchema,
  ReportCardLostRequestSchema,
  RestoreCardRequestSchema,
  STATION_ROLES,
  VoidCardBatchRequestSchema,
  VoidCardRequestSchema,
  type ExportCardBatchRequest,
} from '@walaa/shared-types';
import { requireAuth, requireDashboardRole } from '../plugins/auth';
import {
  exportCardBatch,
  generateCardBatch,
  getCard,
  listCardBatches,
  listCustomerCards,
  reportCardLost,
  replaceCard,
  replaceCardWithThermal,
  restoreCard,
  voidCard,
  voidCardBatch,
} from '../services/card.service';
import { observeLicense } from '../services/license.service';

const IdParamSchema = z.object({ id: z.string().uuid('معرّف غير صالح') }).strict();

/**
 * Physical card stock (§12.25).
 *
 * **Role split, and the reasoning behind it.** Batches are inventory and money: the
 * merchant orders them, and the export carries every card number in the range. Those
 * are dashboard actions, OWNER and MANAGER only.
 *
 * The card lifecycle — lost, restored, replaced — is a counter action. It happens
 * while the customer is standing there, and routing it through the manager would mean
 * telling somebody to come back tomorrow because the owner is out. So the Station may
 * perform it, which is the same reasoning that lets it redeem a voucher.
 *
 * Voiding a card is deliberately NOT a station action. It destroys stock, it is never
 * urgent, and the person who paid for the cards should be the one writing them off.
 */
export async function cardRoutes(app: FastifyInstance): Promise<void> {
  /* ── Batches — dashboard only ───────────────────────────────────────────── */

  app.get('/batches', { config: { roles: DASHBOARD_ROLES } }, async (request) => {
    const auth = requireDashboardRole(request);
    return listCardBatches(auth.merchantId);
  });

  /**
   * Generating a batch takes a quantity and nothing else — the server picks the
   * starting serial, which is what makes an overlapping range unreachable rather
   * than merely validated against (§12.25).
   */
  app.post(
    '/batches',
    {
      config: { roles: DASHBOARD_ROLES, rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { body: GenerateCardBatchRequestSchema },
    },
    async (request, reply) => {
      const auth = requireDashboardRole(request);
      // Allowed while read-only; the status is still evaluated and noted.
      await observeLicense(request.log, 'CARD_BATCH');
      const batch = await generateCardBatch(
        { merchantId: auth.merchantId, actorUserId: auth.sub },
        request.body as never,
      );
      reply.status(201);
      return { batch };
    },
  );

  /**
   * The print-ready export.
   *
   * Rate-limited harder than a read deserves on its own: this response contains every
   * card number in the requested range, and repeatedly pulling it is what harvesting
   * would look like. It is audited with an actor for the same reason.
   *
   * An empty body exports the whole batch; a serial range exports a reprint slice and
   * is audited as exactly that, so "who has seen these numbers" stays answerable.
   */
  app.post(
    '/batches/:id/export',
    {
      config: { roles: DASHBOARD_ROLES, rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { params: IdParamSchema, body: ExportCardBatchRequestSchema },
    },
    async (request) => {
      const auth = requireDashboardRole(request);
      const { id } = request.params as { id: string };
      const body = request.body as ExportCardBatchRequest;
      return exportCardBatch({ merchantId: auth.merchantId, actorUserId: auth.sub }, id, body);
    },
  );

  /** The wholesale remedy for a leaked export file. Blanks only. */
  app.post(
    '/batches/:id/void',
    {
      config: { roles: DASHBOARD_ROLES },
      schema: { params: IdParamSchema, body: VoidCardBatchRequestSchema },
    },
    async (request) => {
      const auth = requireDashboardRole(request);
      const { id } = request.params as { id: string };
      const { reason } = request.body as { reason: string };
      return voidCardBatch({ merchantId: auth.merchantId, actorUserId: auth.sub }, id, reason);
    },
  );

  /* ── Individual cards ───────────────────────────────────────────────────── */

  app.get(
    '/:id',
    { config: { roles: STATION_ROLES }, schema: { params: IdParamSchema } },
    async (request) => {
      const auth = requireAuth(request);
      const { id } = request.params as { id: string };
      return { card: await getCard(auth.merchantId, id) };
    },
  );

  /**
   * Reporting a card lost — the answer to a card someone finds on the floor, and the
   * one that actually bounds the exposure. A station action because the customer is
   * usually on the phone or at the counter when they realise.
   */
  app.post(
    '/:id/lost',
    {
      config: { roles: STATION_ROLES, rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: { params: IdParamSchema, body: ReportCardLostRequestSchema },
    },
    async (request) => {
      const auth = requireAuth(request);
      const { id } = request.params as { id: string };
      const { reason } = request.body as { reason?: string };
      return {
        card: await reportCardLost({ merchantId: auth.merchantId, actorUserId: auth.sub }, id, reason),
      };
    },
  );

  /**
   * "I found it." Requires a stated reason because it re-arms a credential that was
   * deliberately disarmed, and refuses by name when a replacement is already live.
   */
  app.post(
    '/:id/restore',
    {
      config: { roles: STATION_ROLES, rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: { params: IdParamSchema, body: RestoreCardRequestSchema },
    },
    async (request) => {
      const auth = requireAuth(request);
      const { id } = request.params as { id: string };
      const { reason } = request.body as { reason: string };
      return {
        card: await restoreCard({ merchantId: auth.merchantId, actorUserId: auth.sub }, id, reason),
      };
    },
  );

  /**
   * Replacing a card with another physical card.
   *
   * The new card is scanned exactly as at registration — never typed. The old number
   * dies here, which is the difference between a replacement and a reprint.
   */
  app.post(
    '/:id/replace',
    {
      config: { roles: STATION_ROLES, rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: { params: IdParamSchema, body: ReplaceCardRequestSchema },
    },
    async (request) => {
      const auth = requireAuth(request);
      const { id } = request.params as { id: string };
      const { cardNumber, reason } = request.body as { cardNumber: string; reason?: string };
      return replaceCard(
        { merchantId: auth.merchantId, actorUserId: auth.sub },
        id,
        cardNumber,
        reason,
      );
    },
  );

  /**
   * Replacing a card when there is no blank to hand — a paper card, printed now.
   *
   * The fallback that keeps §6.3's promise: a customer who lost their card is never
   * turned away because the stock drawer is empty.
   */
  app.post(
    '/:id/replace-thermal',
    {
      config: { roles: STATION_ROLES, rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: { params: IdParamSchema, body: ReportCardLostRequestSchema },
    },
    async (request) => {
      const auth = requireAuth(request);
      const { id } = request.params as { id: string };
      const { reason } = request.body as { reason?: string };
      return replaceCardWithThermal(
        { merchantId: auth.merchantId, actorUserId: auth.sub },
        id,
        reason,
      );
    },
  );

  /** Writing off a misprint. Dashboard only: it destroys stock somebody paid for. */
  app.post(
    '/:id/void',
    {
      config: { roles: DASHBOARD_ROLES },
      schema: { params: IdParamSchema, body: VoidCardRequestSchema },
    },
    async (request) => {
      const auth = requireDashboardRole(request);
      const { id } = request.params as { id: string };
      const { reason } = request.body as { reason: string };
      return { card: await voidCard({ merchantId: auth.merchantId, actorUserId: auth.sub }, id, reason) };
    },
  );
}

/**
 * A customer's card history, mounted under `/customers` (§12.25).
 *
 * Every card they have ever held, not only the live one: the first thing a support
 * call needs is whether the number in front of them is this person's old card, and
 * "not found" does not answer that.
 */
export async function customerCardRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/:id/cards',
    { config: { roles: STATION_ROLES }, schema: { params: IdParamSchema } },
    async (request) => {
      const auth = requireAuth(request);
      const { id } = request.params as { id: string };
      return { cards: await listCustomerCards(auth.merchantId, id) };
    },
  );
}
