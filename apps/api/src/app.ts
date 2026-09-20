import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadEnv } from './config/env';
import { API_VERSION } from './config/version';
import { isDemoBuild } from './lib/demo-guard';
import { rateLimitedMessage } from './lib/errors';
import { prisma } from './lib/prisma';
import { auth } from './plugins/auth';
import { registerErrorHandler } from './plugins/error-handler';
import { registerZodValidation } from './plugins/zod-validation';
import { registerRealtime } from './plugins/realtime';
import { registerStation } from './plugins/station';
import { authRoutes } from './routes/auth.routes';
import { backupRoutes } from './routes/backup.routes';
import { backupDriveRoutes } from './routes/backup-drive.routes';
import { cardRoutes, customerCardRoutes } from './routes/cards.routes';
import { customerRoutes } from './routes/customers.routes';
import { discountRoutes } from './routes/discount.routes';
import { flagRoutes } from './routes/flags.routes';
import { settingsRoutes } from './routes/settings.routes';
import { stationRoutes } from './routes/stations.routes';
import { ingestRoutes } from './routes/ingest.routes';
import { reportRoutes } from './routes/reports.routes';
import { scanRoutes } from './routes/scan.routes';
import { syncRoutes } from './routes/sync.routes';
import { systemRoutes } from './routes/system.routes';
import { userRoutes } from './routes/users.routes';
import { licenseRoutes } from './routes/license.routes';
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
 * during the free-space work. The customer-phone leak below was found the same way,
 * during the log-permissions audit — see `LOGGABLE_QUERY_PARAMS`.
 *
 * Fifteen minutes of validity is not "safe"; it is fifteen minutes during which anything
 * that can read a log file holds a session. The redaction is here, in the serializer,
 * rather than in `redact` paths, because the whole URL is worth keeping — a support call
 * needs to see which endpoint was called.
 */
/**
 * Query parameters whose value is safe to log. **Everything else is redacted.**
 *
 * ── Why this is an allowlist, and why the denylist had to go ─────────────────
 *
 * This was a denylist: `token`, `query`, `identifier`, `phone`, `q`. It was assembled
 * correctly — each entry was added after finding a real leak — and that is precisely
 * the problem with it. A denylist is a record of the leaks somebody has already
 * noticed. It says nothing about the next route, and the next route is written by
 * whoever is in a hurry.
 *
 * The failure mode is silent and permanent: add `GET /customers?mobile=07701234567`
 * and every request writes a phone number into `api.log` forever, with no error, no
 * test failure, and nothing on any screen. The only way anyone finds out is by reading
 * the log — which is how all five denylist entries were found, one at a time.
 *
 * Inverting it changes what a mistake costs. Forgetting to allowlist a harmless
 * parameter makes a log line slightly less useful; forgetting to denylist a sensitive
 * one discloses a customer's phone number. The first is recoverable by reading this
 * file; the second is not recoverable at all.
 *
 * **What is on the list, and why each is safe.** Paging and sorting take enumerated or
 * numeric values. Date ranges are dates. `range` and `period` are fixed vocabularies.
 * None can carry a phone number, a name, a card token or a bearer token — and if one
 * ever could, it does not belong here.
 *
 * The PATH is always kept: a support call needs to know which endpoint was called, and
 * the endpoint is not the secret.
 */
const LOGGABLE_QUERY_PARAMS = new Set([
  // Paging.
  'page',
  'perPage',
  'limit',
  'offset',
  'cursor',
  // Ordering.
  'sort',
  'order',
  'direction',
  // Windows over time — dates and fixed vocabularies, never free text.
  'from',
  'to',
  'range',
  'period',
  'periodKey',
  'month',
  'year',
  // Enumerated filters. Each is a closed set defined by a Zod enum at the boundary.
  'status',
  'category',
  'role',
  'mode',
  'state',
  'type',
  'format',
]);

/**
 * Replaces every query value except the explicitly safe ones.
 *
 * Note it rewrites the query even when nothing looks sensitive: the old version
 * returned the URL untouched unless it recognised a bad parameter, which is the
 * denylist assumption expressed as a fast path. Under an allowlist there is no such
 * thing as "nothing to do" — an unrecognised parameter is exactly the case that must
 * not pass through.
 */
export function redactUrlToken(url: string): string {
  const separator = url.indexOf('?');
  if (separator === -1) return url;

  const query = new URLSearchParams(url.slice(separator + 1));

  let touched = false;
  for (const name of [...query.keys()]) {
    if (!LOGGABLE_QUERY_PARAMS.has(name)) {
      query.set(name, '[redacted]');
      touched = true;
    }
  }
  if (!touched) return url;

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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  RATE LIMITING CANNOT BE TURNED OFF IN PRODUCTION. NOT BY ANYTHING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The limiter is the only thing standing between a shop's LAN and an unlimited
 * password-guessing surface on `/auth/login`. A till, a tablet and a manager PC share
 * that network with whatever else is plugged into it, and the API answers on it by
 * design so the Station can reach it.
 *
 * The reliability drills need it off — 8 simultaneous callers a round outruns a
 * 120-per-minute budget in seconds, and a drill that measures the limiter instead of
 * the guard it is aiming at reports nothing useful. So there is a switch. The switch
 * is the risk: a variable that disables throttling is one copied `.env`, one support
 * instruction, one "try setting this" away from being set on a merchant's machine.
 *
 * So it is refused in production, here, rather than documented as "do not set this".
 * `NODE_ENV=production` — the value the installer writes and the packaged service runs
 * under — makes the switch inert and says so in the log. A build cannot opt out either:
 * there is no compile-time flag, only this one function, and
 * `rate-limit-production.test.ts` drives `buildApp` under a production environment with
 * every disabling input set at once and asserts a 429 still arrives.
 *
 * The `options.rateLimit` parameter stays for the test suite, which constructs the app
 * in-process. It is subject to the same refusal.
 */
export function rateLimitingDisabled(options: BuildAppOptions = {}): {
  disabled: boolean;
  refusedInProduction: boolean;
} {
  const asked =
    options.rateLimit === false || process.env.LOYALTY_DISABLE_RATE_LIMIT === '1';

  if (!asked) return { disabled: false, refusedInProduction: false };

  /*
    `loadEnv()` at call time, not the module-scope `env`.

    That constant is captured when this file is first imported, which is correct at
    runtime and untestable: a test cannot construct a production environment for a value
    that was read before it ran. Since `loadEnv` caches, this costs a map lookup and
    makes the refusal something that can actually be driven and proven rather than
    asserted about.
  */
  if (loadEnv().NODE_ENV === 'production') return { disabled: false, refusedInProduction: true };

  return { disabled: true, refusedInProduction: false };
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const limiter = rateLimitingDisabled(options);
  const rateLimitEnabled = !limiter.disabled;
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
          // The Google OAuth client secret typed into Settings (§7.6).
          'req.body.clientSecret',
          'res.headers["set-cookie"]',
        ],
        remove: true,
      },
    },
    // Trust the proxy so rate limiting keys on the real client IP behind a load
    // balancer rather than on the balancer itself.
    trustProxy: true,
    /*
      Eight hex characters rather than Fastify's `req-1`, `req-2`…

      The id is now shown to the merchant as «الرقم المرجعي» for support to look up, and
      Fastify's counter restarts at `req-1` with every service start — so the same
      reference would name a different request after each reboot. Random ids stay
      distinct across restarts, and eight characters are short enough to read aloud.
    */
    genReqId: () => globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 8),
    /*
      Passed ONLY in test, and that is what silences FSTDEP023 in production.

      Fastify 5 warns on the top-level `disableRequestLogging` and removes it in 6, so
      the printed advice is to move to `logController`. That is not a drop-in: the
      `LogController` type requires all ten of its members, and hand-rolling nine of
      them to change one is a much larger surface to get wrong than the warning is
      worth.

      The warning fires whenever the option is PRESENT, whatever its value — and the
      only place it needs to be present is the test suite, which turns request logging
      off so unrelated tests do not drown in it. Omitting it in production removes the
      warning from every merchant's startup log, which was the actual complaint: three
      lines of deprecation notice above the reason the service died.

      Revisit at Fastify 6, when `logController` becomes the only option.
    */
    ...(env.NODE_ENV === 'test' ? { disableRequestLogging: true } : {}),
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
  if (limiter.refusedInProduction) {
    app.log.warn(
      'rate limiting cannot be disabled in production — the request to disable it was ignored',
    );
  }

  if (rateLimitEnabled) {
    await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    /*
      Counted in `preHandler`, not `onRequest`: after authentication, the role check and
      validation, and after any `preHandler` a route declares for its own preconditions
      (those run first — the limiter's hook is appended to the route's list). So a limit
      counts attempts at the operation it guards, never requests refused before reaching
      it. At `onRequest` a malformed body, or «نسخ احتياطي الآن» pressed before the key
      ceremony, spent an attempt of a six-an-hour budget and then locked the real backup
      out. `rate-limit.test.ts` pins this.
    */
    hook: 'preHandler',
    // Key on the authenticated user when there is one, so a busy register does not
    // exhaust the budget for everyone else sharing its NAT address.
    keyGenerator: (request) => request.auth?.sub ?? request.ip,
    // statusCode is load-bearing: @fastify/rate-limit throws this object, and
    // without it the error handler cannot tell a throttle from an unknown failure
    // and would answer 500 where the client needs a 429 to know to back off.
    errorResponseBuilder: (request, context) => ({
      statusCode: 429,
      // The error handler turns this into the sentence, so the merchant is told how long.
      retryAfterSeconds: Math.ceil(context.ttl / 1000),
      error: {
        code: 'RATE_LIMITED',
        message: rateLimitedMessage(Math.ceil(context.ttl / 1000)),
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

  /*
    Liveness/readiness. Public by necessity — a probe carries no token.

    `version` and `demo` are here because «تغيير الخادم» has to tell four failures
    apart, and two of them are only visible from this response: an address that answers
    but is not this product (`service`), and one that is this product at a version the
    dashboard cannot talk to (`version`). Without them the screen could only say
    "could not connect", which is the same generic non-answer being removed everywhere
    else. `demo` lets a merchant's real dashboard refuse a demo backend out loud rather
    than silently showing him a fake shop.

    Deliberately no build hash, hostname or path: this is the one unauthenticated
    endpoint, and it should disclose exactly what a client needs to decide whether to
    keep talking.
  */
  app.get('/health', { config: { public: true } }, async () => {
    await prisma.$queryRaw`SELECT 1`;
    return {
      status: 'ok',
      service: 'loyalty-pro-api',
      version: API_VERSION,
      demo: isDemoBuild(),
    };
  });

  await app.register(
    async (api) => {
      await api.register(authRoutes, { prefix: '/auth' });
      await api.register(customerRoutes, { prefix: '/customers' });
      await api.register(customerCardRoutes, { prefix: '/customers' });
      await api.register(cardRoutes, { prefix: '/cards' });
      await api.register(ingestRoutes, { prefix: '/ingest' });
      await api.register(scanRoutes, { prefix: '/scan' });
      await api.register(voucherRoutes, { prefix: '/vouchers' });
      await api.register(discountRoutes, { prefix: '/discount' });
      await api.register(flagRoutes, { prefix: '/flags' });
      await api.register(settingsRoutes, { prefix: '/settings' });
      await api.register(stationRoutes, { prefix: '/stations' });
      await api.register(backupRoutes, { prefix: '/backup' });
      // Its own file, and its own prefix: everything under `/backup` must keep working
      // with Drive absent or broken, and a separate registration makes that boundary
      // something you can see rather than something you have to remember.
      await api.register(backupDriveRoutes, { prefix: '/backup/drive' });
      await api.register(reportRoutes, { prefix: '/reports' });
      await api.register(syncRoutes, { prefix: '/sync' });
      await api.register(systemRoutes, { prefix: '/system' });
      await api.register(userRoutes, { prefix: '/users' });
      await api.register(licenseRoutes, { prefix: '/license' });
    },
    { prefix: API_PREFIX },
  );

  return app;
}
