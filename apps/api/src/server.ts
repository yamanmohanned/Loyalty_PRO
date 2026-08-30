import { buildApp } from './app';
import { configSource, loadEnv } from './config/env';
import { ensureDatabaseReady } from './lib/migrate';
import { prisma } from './lib/prisma';
import { startBackupScheduler } from './services/backup/schedule.service';

/**
 * Process entry point.
 *
 * Shutdown is graceful and bounded: stop accepting connections, let in-flight
 * requests finish, close the database pool. A link that is mid-commit when a
 * deploy rolls must not be torn out from under the customer standing at the till.
 */
const env = loadEnv();

async function main(): Promise<void> {
  // Built before the database work so the bootstrap has a real logger: nothing is
  // served until `listen()` below, and Prisma connects lazily on its first query.
  const app = await buildApp();
  app.log.info({ configFile: configSource ?? '(environment only)' }, 'configuration loaded');

  // Everything the database needs before the first request, in one step: create the
  // data directory, open the connection with WAL and the other pragmas the v3
  // concurrency decision depends on (§12.5), then apply any migration the installed
  // binary is newer than. On a merchant's machine this IS the provisioning step —
  // there is no separate migration command for anyone to forget (§12.11).
  const migrations = await ensureDatabaseReady({
    log: (message) => app.log.info(message),
  });
  if (migrations.applied.length > 0) {
    app.log.info(
      { migrations: migrations.applied, directory: migrations.directory },
      'database migrations applied',
    );
  }

  // Scheduled backups (§7.3, §12.21). Started HERE rather than in `buildApp` on
  // purpose: `buildApp` is what the test suite constructs, and a scheduler firing
  // mid-suite would take real backups of the test database. It also belongs to the
  // process rather than to the HTTP app — the point of putting it in the service is
  // that it survives a closed manager window.
  const stopScheduler = startBackupScheduler(app.log);

  // Both stdin events below can fire for the same close, and a signal can arrive
  // while a shutdown is already unwinding. Closing twice is not harmful so much as
  // confusing in a log a support call is reading.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    try {
      stopScheduler();
      await app.close();
      await prisma.$disconnect();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'shutdown failed');
      process.exit(1);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }

  // Supervised by the Windows Service host: shut down when its end of the pipe
  // closes. Windows has no SIGTERM, and a service process has no console, so it
  // cannot send the child a CTRL_BREAK either — `GenerateConsoleCtrlEvent` needs a
  // console the service does not have. Closing stdin is the one stop signal that
  // crosses that boundary without opening a control port on the network.
  if (process.env.WALAA_SUPERVISED === '1') {
    process.stdin.on('end', () => {
      void shutdown('stdin-closed');
    });
    process.stdin.on('close', () => {
      void shutdown('stdin-closed');
    });
    process.stdin.resume();
  }

  await app.listen({ port: env.API_PORT, host: env.API_HOST });
}

main().catch((error: unknown) => {
  console.error('failed to start:', error);
  process.exit(1);
});
