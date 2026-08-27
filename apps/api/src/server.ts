import { buildApp } from './app';
import { loadEnv } from './config/env';
import { prisma } from './lib/prisma';

/**
 * Process entry point.
 *
 * Shutdown is graceful and bounded: stop accepting connections, let in-flight
 * requests finish, close the database pool. A link that is mid-commit when a
 * deploy rolls must not be torn out from under the customer standing at the till.
 */
const env = loadEnv();

async function main(): Promise<void> {
  const app = await buildApp();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await prisma.$disconnect();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'shutdown failed');
      process.exit(1);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }

  await app.listen({ port: env.API_PORT, host: env.API_HOST });
}

main().catch((error: unknown) => {
  console.error('failed to start:', error);
  process.exit(1);
});
