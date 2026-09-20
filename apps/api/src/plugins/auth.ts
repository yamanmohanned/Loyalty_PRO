import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { DASHBOARD_ROLES, type AccessTokenClaims, type Role } from '@loyalty-pro/shared-types';
import { forbidden, unauthenticated } from '../lib/errors';
import { verifyAccessToken } from '../lib/jwt';

/**
 * Authentication and role enforcement (CLAUDE.md §7.2).
 *
 * Authorisation is opt-OUT, not opt-in: a global hook authenticates every request
 * and only an explicit `config.public` marker skips it. A route added later without
 * thinking about auth is therefore protected by default — the failure mode of the
 * opposite arrangement is a silently public endpoint, which is exactly the bug
 * nobody notices until it matters.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Present on every authenticated request; undefined only on public routes. */
    auth?: AccessTokenClaims;
  }
  interface FastifyContextConfig {
    /** Marks a route as reachable without a token. Use sparingly and deliberately. */
    public?: boolean;
    /** Roles allowed to reach this route. Omit to allow any authenticated role. */
    roles?: readonly Role[];
  }
}

/** Reads a bearer token, rejecting anything that is not exactly one. */
function extractBearer(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (!header) throw unauthenticated();

  const [scheme, token, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token || rest.length > 0) {
    throw unauthenticated('صيغة رمز الدخول غير صحيحة');
  }
  return token;
}

async function authPlugin(app: FastifyInstance): Promise<void> {
  app.decorateRequest('auth', undefined);

  app.addHook('onRequest', async (request: FastifyRequest, _reply: FastifyReply) => {
    if (request.routeOptions.config?.public) return;

    const claims = await verifyAccessToken(extractBearer(request));
    request.auth = claims;

    const allowed = request.routeOptions.config?.roles;
    if (allowed && !allowed.includes(claims.role)) {
      throw forbidden();
    }
  });
}

export const auth = fp(authPlugin, { name: 'walaa-auth' });

/**
 * The authenticated principal, or a 401. Every handler on a protected route uses
 * this rather than reading `request.auth` directly, so the non-null assertion
 * lives in exactly one place.
 */
export function requireAuth(request: FastifyRequest): AccessTokenClaims {
  if (!request.auth) throw unauthenticated();
  return request.auth;
}

/**
 * Assistants execute the core loop and look customers up — they never see the
 * rules editor or full financial reports (CLAUDE.md §7.2).
 */
export function requireDashboardRole(request: FastifyRequest): AccessTokenClaims {
  const auth = requireAuth(request);
  if (!DASHBOARD_ROLES.includes(auth.role)) throw forbidden();
  return auth;
}

/** OWNER-only actions: anything that reshapes the merchant itself. */
export function requireOwner(request: FastifyRequest): AccessTokenClaims {
  const auth = requireAuth(request);
  if (auth.role !== 'OWNER') throw forbidden();
  return auth;
}
