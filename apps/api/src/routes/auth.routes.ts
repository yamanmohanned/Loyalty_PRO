import type { FastifyInstance } from 'fastify';
import { LoginRequestSchema, RefreshRequestSchema } from '@walaa/shared-types';
import { requireAuth } from '../plugins/auth';
import { login, logout, refresh, revokeAllForUser } from '../services/auth.service';

/**
 * Auth routes.
 *
 * `/login` and `/refresh` are public by necessity — they are how a caller obtains
 * a token in the first place — and carry a tighter rate limit than the rest of the
 * API because they are the endpoints worth brute-forcing (CLAUDE.md §7.5).
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
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
