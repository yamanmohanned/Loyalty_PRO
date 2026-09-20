import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  CreateStationRequestSchema,
  DASHBOARD_ROLES,
  PairStationRequestSchema,
  type CreateStationRequest,
  type PairStationRequest,
} from '@loyalty-pro/shared-types';
import { requireDashboardRole } from '../plugins/auth';
import {
  StationError,
  createStation,
  listStations,
  pairStation,
  regeneratePairing,
  revokeStation,
  toSummary,
} from '../services/station.service';

/**
 * Stations (PRD §7, FND-03).
 *
 * Everything here is the manager's except `POST /pair`, which is **public** — the
 * device presenting a pairing code has no account yet, and requiring one would mean
 * somebody with a password has to stand at every tablet. That is precisely what the
 * three-minute acceptance criterion rules out. The code is the credential: twelve
 * characters from a thirty-character alphabet, single-use, fifteen minutes, and rate
 * limited below.
 *
 * §13.9's rule is that authentication is opt-OUT, so `config.public` is the explicit
 * marker that makes this one route reachable — and it is the only one in the file.
 */

const IdParamSchema = z.object({ id: z.string().uuid('معرّف غير صالح') }).strict();

/** Maps the service's refusals onto status codes, so the handlers stay readable. */
const STATUS_FOR: Record<StationError['code'], number> = {
  NAME_TAKEN: 409,
  NOT_FOUND: 404,
  ALREADY_REVOKED: 409,
  ALREADY_PAIRED: 409,
  BAD_CODE: 400,
};

export async function stationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { config: { roles: DASHBOARD_ROLES } }, async (request) => {
    const auth = requireDashboardRole(request);
    return { stations: await listStations(auth.merchantId) };
  });

  app.post(
    '/',
    {
      config: { roles: DASHBOARD_ROLES, rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: { body: CreateStationRequestSchema },
    },
    async (request, reply) => {
      const auth = requireDashboardRole(request);
      try {
        const created = await createStation(
          auth.merchantId,
          request.body as CreateStationRequest,
          auth.sub,
        );
        return reply.code(201).send({
          station: created.station,
          pairing: {
            code: created.code,
            url: pairingUrl(request.headers.host, created.code),
            expiresAt: created.expiresAt.toISOString(),
          },
        });
      } catch (error) {
        return refuse(reply, error);
      }
    },
  );

  /** A new code for a station whose first one expired before the tablet arrived. */
  app.post(
    '/:id/pairing',
    {
      config: { roles: DASHBOARD_ROLES, rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: { params: IdParamSchema },
    },
    async (request, reply) => {
      const auth = requireDashboardRole(request);
      const { id } = request.params as { id: string };
      try {
        const issued = await regeneratePairing(auth.merchantId, id, auth.sub);
        return {
          station: issued.station,
          pairing: {
            code: issued.code,
            url: pairingUrl(request.headers.host, issued.code),
            expiresAt: issued.expiresAt.toISOString(),
          },
        };
      } catch (error) {
        return refuse(reply, error);
      }
    },
  );

  /**
   * Ends a station. The device stops on its next request, not on its next token
   * refresh — which is what makes the one-minute criterion true.
   */
  app.post(
    '/:id/revoke',
    { config: { roles: DASHBOARD_ROLES }, schema: { params: IdParamSchema } },
    async (request, reply) => {
      const auth = requireDashboardRole(request);
      const { id } = request.params as { id: string };
      try {
        return { station: await revokeStation(auth.merchantId, id, auth.sub) };
      } catch (error) {
        return refuse(reply, error);
      }
    },
  );

  /**
   * The device redeems its code. Public, and rate-limited hard.
   *
   * Six a minute from one address: a person typing twelve characters gets several
   * goes at a typo, and an attacker gets 8,640 guesses a day against roughly 5.9 × 10¹⁷
   * possibilities in a fifteen-minute window. The limit is what turns "short code" into
   * "short code that is not guessable".
   */
  app.post(
    '/pair',
    {
      config: { public: true, rateLimit: { max: 6, timeWindow: '1 minute' } },
      schema: { body: PairStationRequestSchema },
    },
    async (request, reply) => {
      const body = request.body as PairStationRequest;
      try {
        const { station, deviceToken } = await pairStation(body.code, body.deviceLabel);
        return {
          stationId: station.id,
          name: station.name,
          type: station.type,
          deviceToken,
        };
      } catch (error) {
        return refuse(reply, error);
      }
    },
  );

  /**
   * What the device asks to find out whether it is still a station.
   *
   * Authenticated by the device token alone — no user session — because its answer must
   * be available on the lock screen, before anybody has signed in. A device whose
   * station was revoked gets 401 and knows to wipe its token and show the pairing
   * screen again.
   */
  app.get('/me', { config: { public: true } }, async (request, reply) => {
    if (!request.station) {
      return reply.code(401).send({
        error: {
          code: 'STATION_UNKNOWN',
          message: 'هذا الجهاز غير مرتبط بمحطة، أو تم إبطال ارتباطه. اطلب رمز ربط جديداً من المدير.',
        },
      });
    }
    return { station: request.station };
  });
}

/**
 * The URL the QR encodes.
 *
 * Built from the Host header the manager's own dashboard reached the API on, because
 * that is by definition an address that works on this shop's network — the service has
 * no configured public address, and a LAN IP guessed from an interface list is the one
 * the tablet cannot reach as often as not.
 */
function pairingUrl(host: string | undefined, code: string): string {
  const base = host ? `http://${host}` : '';
  return `${base}/?pair=${encodeURIComponent(code)}`;
}

function refuse(reply: FastifyReply, error: unknown) {
  if (error instanceof StationError) {
    return reply.code(STATUS_FOR[error.code]).send({
      error: { code: error.code, message: error.message },
    });
  }
  throw error;
}

export { toSummary };
