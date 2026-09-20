import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { DASHBOARD_ROLES, type AccessTokenClaims, type Role } from '@loyalty-pro/shared-types';
import { forbidden, unauthenticated } from '../lib/errors';
import { verifyAccessToken } from '../lib/jwt';
import { resolveDeviceToken, type ResolvedStation } from '../services/station.service';
import { effectiveSettings } from '../services/settings.service';

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
    /**
     * The station this device is, when it presented a valid device token.
     *
     * Resolved on every request, public ones included, because `/stations/me` has to
     * answer on the lock screen before anybody has signed in.
     */
    station?: ResolvedStation;
  }
  interface FastifyContextConfig {
    /** Marks a route as reachable without a token. Use sparingly and deliberately. */
    public?: boolean;
    /** Roles allowed to reach this route. Omit to allow any authenticated role. */
    roles?: readonly Role[];
  }
}

/** Lower-case: Node normalises incoming header names, and Fastify does not re-case them. */
export const STATION_DEVICE_HEADER = 'x-station-device';

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

  app.decorateRequest('station', undefined);

  app.addHook('onRequest', async (request: FastifyRequest, _reply: FastifyReply) => {
    /*
      Resolved before the public check, and for every route, because the one question a
      device asks BEFORE anybody signs in is "am I still a station?" — see
      `GET /stations/me`. A token that names a revoked or unknown station resolves to
      undefined, which is the same answer as presenting none: this device may not act.
    */
    const deviceToken = request.headers[STATION_DEVICE_HEADER];
    if (typeof deviceToken === 'string' && deviceToken.length > 0) {
      request.station = (await resolveDeviceToken(deviceToken)) ?? undefined;
    }

    if (request.routeOptions.config?.public) return;

    const claims = await verifyAccessToken(extractBearer(request));
    request.auth = claims;

    const allowed = request.routeOptions.config?.roles;
    if (allowed && !allowed.includes(claims.role)) {
      throw forbidden();
    }

    /*
      ── Why revocation is checked here and not read from the token ─────────────

      FND-03 requires a revoked device to stop «خلال دقيقة». An access token lives about
      fifteen minutes and cannot be withdrawn, so a `stationId` claim inside it would
      mean a revoked till kept trading for the rest of that window — in front of
      customers, taking money, after the manager had pressed the button and watched the
      row turn red.

      Off by default, and it has to be: the Station app does not pair yet, and turning
      this on before it does would lock every existing till out of its own register. It
      is a merchant setting rather than a constant so that the switch belongs to the
      shop, on the day their stations are all paired — which is the day it starts being
      a real control rather than a declared one.
    */
    if (claims.role === 'STATION') {
      const settings = await effectiveSettings(claims.merchantId);
      if (settings['security.require_paired_station']?.value === true && !request.station) {
        throw unauthenticated(
          'هذا الجهاز غير مرتبط بمحطة، أو تم إبطال ارتباطه. اطلب رمز ربط جديداً من المدير.',
        );
      }
    }
  });
}

export const auth = fp(authPlugin, { name: 'loyalty-pro-auth' });

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
