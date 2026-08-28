import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { verifyAccessToken } from '../lib/jwt';
import { subscribe } from '../services/realtime.service';

/**
 * WebSocket endpoint for real-time client updates (CLAUDE_v3.md §7.2).
 *
 * The Station and Agent hold persistent connections and the manager dashboard
 * updates in under a second without polling.
 *
 * **Auth note:** browsers cannot set an Authorization header on a WebSocket
 * handshake, so the token arrives as a query parameter. That is a genuine tradeoff
 * — a token in a URL can land in logs — mitigated by the access token being short
 * lived (~15m) and by this being LAN-internal traffic (§7.1). The global auth hook
 * is bypassed for this route and the check is performed explicitly below.
 */
export async function registerRealtime(app: FastifyInstance): Promise<void> {
  await app.register(websocket);

  app.get(
    '/realtime',
    { websocket: true, config: { public: true } },
    async (socket, request) => {
      const token = (request.query as { token?: string } | undefined)?.token;

      if (!token) {
        socket.close(4401, 'unauthorized');
        return;
      }

      let merchantId: string;
      try {
        const claims = await verifyAccessToken(token);
        merchantId = claims.merchantId;
      } catch {
        socket.close(4401, 'unauthorized');
        return;
      }

      const unsubscribe = subscribe(merchantId, (event) => {
        // A socket that has closed between the publish and this send would throw;
        // the close handler below removes it, and realtime.service swallows the
        // error so one dead client cannot deny events to the others.
        socket.send(JSON.stringify(event));
      });

      socket.on('close', unsubscribe);
      socket.on('error', unsubscribe);

      socket.send(JSON.stringify({ type: 'CONNECTED', at: new Date().toISOString() }));
    },
  );
}
