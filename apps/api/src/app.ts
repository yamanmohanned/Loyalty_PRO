import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadEnv } from './config/env';
import { prisma } from './lib/prisma';
import { auth } from './plugins/auth';
import { registerErrorHandler } from './plugins/error-handler';
import { registerZodValidation } from './plugins/zod-validation';
import { registerRealtime } from './plugins/realtime';
import { registerStation } from './plugins/station';
import { authRoutes } from './routes/auth.routes';
import { backupRoutes } from './routes/backup.routes';
import { customerRoutes } from './routes/customers.routes';
import { discountRoutes } from './routes/discount.routes';
import { flagRoutes } from './routes/flags.routes';
import { ingestRoutes } from './routes/ingest.routes';
import { reportRoutes } from './routes/reports.routes';
import { scanRoutes } from './routes/scan.routes';
import { syncRoutes } from './routes/sync.routes';
import { systemRoutes } from './routes/system.routes';
import { voucherRoutes } from './routes/vouchers.routes';

const env = loadEnv();

export const API_PREFIX = '/api/v1';

/**
 * Removes the access token from a URL before it is logged.
 *
 * The WebSocket handshake carries its token as a query parameter, because a browser
 * cannot set headers on an upgrade (§12.9). The plugin documented that tradeoff and
 * mitigated it with a short TTL — but the mitigation missed where the token actually
 * ends up: Fastify's request log records `req.url`, so every reconnect wrote a live
 * bearer token in cleartext into `api.log`, on the same volume as the database, readable
 * by anyone who can read the data directory. Found by reading the service's own log
 * during the free-space work.
 *
 * Fifteen minutes of validity is not "safe"; it is fifteen minutes during which anything
 * that can read a log file holds a session. The redaction is here, in the serializer,
 * rather than in `redact` paths, because the whole URL is worth keeping — a support call
 * needs to see which endpoint was called.
 */
export function redactUrlToken(url: string): string {
  const separator = url.indexOf('?');
  if (separator === -1) return url;

  const query = new URLSearchParams(url.slice(separator + 1));
  if (!query.has('token')) return url;

  query.set('token', '[redacted]');
  return `${url.slice(0, separator)}?${query.toString()}`;
}

export interface BuildAppOptions {
  /**
   * Enable rate limiting. Defaults to on.
   *
   * Tests that exercise unrelated routes turn this off, because they would
   * otherwise share one login bucket across a whole file and start failing on the
   * eleventh request for reasons having nothing to do with what they assert.
   * Rate limiting itself is covered by its own suite, with this left on.
   */
  rateLimit?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const rateLimitEnabled = options.rateLimit ?? true;
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // Structured logs in production; readable ones while developing (§3.2).
      ...(env.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }
        : {}),
      serializers: {
        // Fastify's default request serializer, with the URL passed through the
        // redaction above. Written out rather than wrapped, because the default is not
        // exported and a wrapper that silently stopped applying would be invisible.
        req(request) {
          return {
            method: request.method,
            url: redactUrlToken(request.url),
            host: request.host,
            remoteAddress: request.ip,
            remotePort: request.socket?.remotePort,
          };
        },
      },
      redact: {
        // Secrets and tokens never reach the log (CLAUDE.md §7.6, §11).
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.refreshToken',
          // The backup encryption key, in either direction. §12.19: this key must never
          // reach a log line — a log file is readable by anyone who can read the data
          // directory, which is a wider set than the people who may hold the key.
          'req.body.key',
          'req.body.backupKey',
          'res.headers["set-cookie"]',
        ],
        remove: true,
      },
    },
    // Trust the proxy so rate limiting keys on the real client IP behind a load
    // balancer rather than on the balancer itself.
    trustProxy: true,
    disableRequestLogging: env.NODE_ENV === 'test',
    bodyLimit: 1_048_576, // 1 MiB — a sync batch of 100 operations fits comfortably
  });

  registerZodValidation(app);
  registerErrorHandler(app);

  await app.register(helmet, {
    // HSTS (CLAUDE.md §7.3). Two years, subdomains included, preload-eligible.
    hsts: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
    /**
     * A content security policy, because this service is no longer JSON-only.
     *
     * It used to be, and the option was switched off with a comment saying so. §12.3
     * then made this process serve the Loyalty Station's own HTML and JavaScript on the
     * same port, and the comment stopped being true without anybody noticing — which is
     * the ordinary way a security header goes missing.
     *
     * The bundle is entirely self-hosted (fonts included, §14), so `'self'` is the whole
     * policy. `'unsafe-inline'` is granted to styles only: React writes inline `style`
     * attributes, and no HTML here comes from user input.
     */
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'", 'data:'],
        // The Station's own WebSocket, on this origin.
        connectSrc: ["'self'", 'ws:', 'wss:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        // Removed, not defaulted. §7.1 makes LAN traffic deliberately plain HTTP, and
        // helmet's default `upgrade-insecure-requests` would have the tablet rewrite
        // every request to https:// against a service that does not speak it — turning a
        // hardening header into a total outage of the Station.
        upgradeInsecureRequests: null,
      },
    },
    // DENY rather than helmet's SAMEORIGIN default: nothing here is ever framed.
    frameguard: { action: 'deny' },
  });

  await app.register(cors, {
    origin: env.API_CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
  });

  /**
   * Rate limiting (CLAUDE.md §7.5).
   *
   * **Tradeoff:** the store is in-process memory, so limits are per-instance. That
   * is correct for a single-instance deployment and wrong the moment this scales
   * horizontally — move to the Redis store when a second instance appears.
   */
  if (rateLimitEnabled) {
    await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    // Key on the authenticated user when there is one, so a busy register does not
    // exhaust the budget for everyone else sharing its NAT address.
    keyGenerator: (request) => request.auth?.sub ?? request.ip,
    // statusCode is load-bearing: @fastify/rate-limit throws this object, and
    // without it the error handler cannot tell a throttle from an unknown failure
    // and would answer 500 where the client needs a 429 to know to back off.
    errorResponseBuilder: (request) => ({
      statusCode: 429,
      error: {
        code: 'RATE_LIMITED',
        message: 'عدد كبير من المحاولات — انتظر قليلاً ثم أعد المحاولة',
        requestId: request.id,
      },
    }),
    });
  }

  await app.register(auth);

  // Registered after auth so the global hook exists; the route marks itself public
  // and authenticates its own handshake token (browsers cannot set headers on a
  // WebSocket upgrade).
  await registerRealtime(app);

  // The Loyalty Station's own files, when a build exists (§12.3). Also after auth,
  // for the same reason: its routes opt out explicitly rather than by accident.
  await registerStation(app);

  // Liveness/readiness. Public by necessity — a probe carries no token.
  app.get('/health', { config: { public: true } }, async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', service: 'walaa-api' };
  });

  await app.register(
    async (api) => {
      await api.register(authRoutes, { prefix: '/auth' });
      await api.register(customerRoutes, { prefix: '/customers' });
      await api.register(ingestRoutes, { prefix: '/ingest' });
      await api.register(scanRoutes, { prefix: '/scan' });
      await api.register(voucherRoutes, { prefix: '/vouchers' });
      await api.register(discountRoutes, { prefix: '/discount' });
      await api.register(flagRoutes, { prefix: '/flags' });
      await api.register(backupRoutes, { prefix: '/backup' });
      await api.register(reportRoutes, { prefix: '/reports' });
      await api.register(syncRoutes, { prefix: '/sync' });
      await api.register(systemRoutes, { prefix: '/system' });
    },
    { prefix: API_PREFIX },
  );

  return app;
}
