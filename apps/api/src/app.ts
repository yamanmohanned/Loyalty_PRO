import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadEnv } from './config/env';
import { prisma } from './lib/prisma';
import { auth } from './plugins/auth';
import { registerErrorHandler } from './plugins/error-handler';
import { registerZodValidation } from './plugins/zod-validation';
import { authRoutes } from './routes/auth.routes';
import { couponRoutes } from './routes/coupons.routes';
import { customerRoutes } from './routes/customers.routes';
import { reportRoutes } from './routes/reports.routes';
import { ruleRoutes } from './routes/rules.routes';
import { syncRoutes } from './routes/sync.routes';
import { transactionRoutes } from './routes/transactions.routes';

const env = loadEnv();

export const API_PREFIX = '/api/v1';

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
      redact: {
        // Secrets and tokens never reach the log (CLAUDE.md §7.6, §11).
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.refreshToken',
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
    contentSecurityPolicy: false, // this service returns JSON, never HTML
    // DENY rather than helmet's SAMEORIGIN default: a JSON API is never framed.
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

  // Liveness/readiness. Public by necessity — a probe carries no token.
  app.get('/health', { config: { public: true } }, async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', service: 'walaa-api' };
  });

  await app.register(
    async (api) => {
      await api.register(authRoutes, { prefix: '/auth' });
      await api.register(customerRoutes, { prefix: '/customers' });
      await api.register(transactionRoutes, { prefix: '/transactions' });
      await api.register(couponRoutes, { prefix: '/coupons' });
      await api.register(ruleRoutes, { prefix: '/rules' });
      await api.register(reportRoutes, { prefix: '/reports' });
      await api.register(syncRoutes, { prefix: '/sync' });
    },
    { prefix: API_PREFIX },
  );

  return app;
}
