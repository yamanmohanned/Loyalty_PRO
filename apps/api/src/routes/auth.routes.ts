import type { FastifyInstance } from 'fastify';
import {
  type BootstrapRequest,
  BootstrapRequestSchema,
  type BootstrapStatus,
  LoginRequestSchema,
  RefreshRequestSchema,
} from '@walaa/shared-types';
import { requireAuth } from '../plugins/auth';
import { login, logout, refresh, revokeAllForUser } from '../services/auth.service';
import { bootstrapInstallation, bootstrapRequired } from '../services/bootstrap.service';

/**
 * Auth routes.
 *
 * `/login` and `/refresh` are public by necessity — they are how a caller obtains
 * a token in the first place — and carry a tighter rate limit than the rest of the
 * API because they are the endpoints worth brute-forcing (CLAUDE.md §7.5).
 *
 * `/me` and `/logout-all` carry no `roles` list, and that is a decision rather than an
 * omission: they are the two things every authenticated caller must be able to do
 * regardless of role — read back who it is holding this token, and throw all of its own
 * sessions away. Every other route in this API names its roles explicitly, so that a
 * role added later cannot quietly inherit access to anything.
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Is this installation still without an account?
   *
   * Public, because nothing can authenticate before the first account exists. It
   * answers a bare boolean and nothing else — a caller who learns "already set up"
   * has learned exactly what a failed login would have told them.
   */
  app.get(
    '/bootstrap',
    { config: { public: true, rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (): Promise<BootstrapStatus> => ({ required: await bootstrapRequired() }),
  );

  /**
   * Creates the shop and its owner. Once, ever.
   *
   * Self-closing: the count and the insert share one transaction, so this refuses from
   * the moment a single user exists. The rate limit is tight because the window in
   * which it can succeed is measured in minutes and a caller hammering it afterwards is
   * not a merchant.
   */
  app.post(
    '/bootstrap',
    {
      config: { public: true, rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: { body: BootstrapRequestSchema },
    },
    async (request, reply) => {
      const body = request.body as BootstrapRequest;
      await bootstrapInstallation(body, { ip: request.ip });

      /*
        No token is returned. The owner signs in with the credentials he has just
        chosen, which is the one moment he is certain to remember them — and it proves
        the account works before he walks away from the machine.
      */
      return reply.code(201).send({ created: true });
    },
  );

  app.post(
    '/login',
    {
      config: {
        public: true,
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
      schema: { body: LoginRequestSchema },
    },
    async (request) => {
      const { username, password } = request.body as { username: string; password: string };
      return login(username, password);
    },
  );

  app.post(
    '/refresh',
    {
      config: {
        public: true,
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
      schema: { body: RefreshRequestSchema },
    },
    async (request) => {
      const { refreshToken } = request.body as { refreshToken: string };
      return refresh(refreshToken);
    },
  );

  app.post(
    '/logout',
    {
      config: { public: true },
      schema: { body: RefreshRequestSchema },
    },
    async (request, reply) => {
      const { refreshToken } = request.body as { refreshToken: string };
      await logout(refreshToken);
      reply.status(204);
      return null;
    },
  );

  /** Revokes every session for the caller — "sign out everywhere". */
  app.post('/logout-all', async (request, reply) => {
    const auth = requireAuth(request);
    const revoked = await revokeAllForUser(auth.sub);
    reply.status(200);
    return { revoked };
  });

  /** Who am I — lets a client validate a stored token on launch. */
  app.get('/me', async (request) => {
    const auth = requireAuth(request);
    return {
      id: auth.sub,
      merchantId: auth.merchantId,
      branchId: auth.branchId,
      role: auth.role,
    };
  });
}
