import { hostname } from 'node:os';
import { buildApp } from './app';
import { configSource, loadEnv } from './config/env';
import { assertMigrationsMatchBuild, verifyDatabaseIdentity } from './lib/db-identity';
import { markRunning, markStopped, verifyDatabaseIntegrity } from './lib/db-integrity';
import { assertDatabaseMatchesBuild } from './lib/demo-guard';
import { ensureDatabaseReady, installDatabaseTemplateIfAbsent } from './lib/migrate';
import { checkpointWal, prisma } from './lib/prisma';
import { clearStartupFailure } from './lib/startup-error';
import { startBackupScheduler } from './services/backup/schedule.service';
import { startStorageSampler } from './services/storage.service';

/**
 * Process entry point.
 *
 * Shutdown is graceful and bounded: stop accepting connections, let in-flight
 * requests finish, close the database pool. A link that is mid-commit when a
 * deploy rolls must not be torn out from under the customer standing at the till.
 */
const env = loadEnv();

export async function main(): Promise<void> {
  /*
    ── The database comes FIRST, and the ordering is a fix ──────────────────────

    This used to build the Fastify app first, "so the bootstrap has a real logger".
    The cost of that convenience only showed up when the database check failed on a
    merchant's machine: the log read

        serving the loyalty station
        configuration loaded
        failed to start: تعذّر أخذ نسخة احتياطية قبل ترحيل قاعدة البيانات…

    — three lines that say the product came up and then, at the bottom, that it never
    did. Registering a route is not serving it, but a log is read by whoever is trying
    to work out what happened, and this one told them the wrong story twice before
    telling them the right one.

    Nothing is announced now until the data layer is actually usable. `bootstrapLog`
    covers the gap before the app exists.

    Hand-rolled rather than a second pino instance: pino is fastify's dependency, not
    ours, and reaching through pnpm's isolated store for it is the kind of import that
    works here and fails in the staged runtime. Eight lines emitting the same shape
    keeps `api.log` in one format for whoever is reading it.
  */
  const bootstrapLog = (message: string, extra: Record<string, unknown> = {}): void => {
    process.stdout.write(
      `${JSON.stringify({
        level: 30,
        time: Date.now(),
        pid: process.pid,
        hostname: hostname(),
        ...extra,
        msg: message,
      })}
`,
    );
  };

  bootstrapLog('configuration loaded', { configFile: configSource ?? '(environment only)' });

  /*
    ── The database is placed before anything opens it ─────────────────────────

    First, and pure filesystem, because *opening* a SQLite connection is what creates
    an empty database file. Anything that connected before this — the demo guard's
    `PRAGMA database_list` included — would find a database present and this would
    never install the shipped template. See `installDatabaseTemplateIfAbsent`.
  */
  const template = installDatabaseTemplateIfAbsent(bootstrapLog);
  if (!template.installed && template.reason !== 'database-present') {
    bootstrapLog('no database template was installed', {
      reason: template.reason,
      databasePath: template.databasePath,
    });
  }

  // The migration files beside this binary must be the ones it was built with. No
  // database is involved, so it is answerable before one is opened, and its failure
  // means the installation is wrong rather than the data.
  await assertMigrationsMatchBuild(bootstrapLog);

  /*
    Read the previous run's marker BEFORE anything else can rewrite it, and replace it
    with this run's. A marker still saying `running` is how an unclean stop is detected,
    and that is the one condition that earns a full `integrity_check` below.
  */
  const previousRun = markRunning();
  bootstrapLog('previous run', {
    state: previousRun?.state ?? '(none recorded)',
    stoppedAt: previousRun?.stoppedAt ?? null,
    lastFullIntegrityCheckAt: previousRun?.lastFullIntegrityCheckAt ?? null,
  });

  /*
    Before anything writes: confirm this build is attached to the database it is
    supposed to be attached to.

    Ordered ahead of `ensureDatabaseReady` deliberately. That call may migrate and take a
    snapshot, and both are writes. A demo build that has latched onto a shop's live
    `walaa.db` must stop BEFORE it touches it, not after it has helpfully migrated it.
  */
  await assertDatabaseMatchesBuild(bootstrapLog);

  // Opens the connection with WAL and the other pragmas the v3 concurrency decision
  // depends on (§12.5), then VERIFIES the schema. On a merchant's machine it does not
  // migrate: the shipped template is already current, and a pending migration there is
  // a refusal with a reason rather than a silent write (see `migrationPolicy`).
  const migrations = await ensureDatabaseReady({ log: bootstrapLog });
  if (migrations.applied.length > 0) {
    bootstrapLog('database migrations applied', {
      migrations: migrations.applied,
      directory: migrations.directory,
    });
  }

  // Whose database is this, and is it the shape this binary was built for — asked of
  // the file SQLite actually opened, not of DATABASE_URL.
  const identity = await verifyDatabaseIdentity({ log: bootstrapLog });

  // And is the file sound. `quick_check` every boot; the full `integrity_check` only
  // when it has been earned — the measured costs behind that split are in
  // `lib/db-integrity.ts`.
  await verifyDatabaseIntegrity({
    file: identity.file,
    previous: previousRun,
    log: bootstrapLog,
  });

  // Only now is there anything worth serving.
  const app = await buildApp();

  // Scheduled backups (§7.3, §12.21). Started HERE rather than in `buildApp` on
  // purpose: `buildApp` is what the test suite constructs, and a scheduler firing
  // mid-suite would take real backups of the test database. It also belongs to the
  // process rather than to the HTTP app — the point of putting it in the service is
  // that it survives a closed manager window.
  const stopScheduler = startBackupScheduler(app.log);

  // Free-space sampling (§12.15). In the process for the same two reasons as the
  // scheduler: `buildApp` is what the test suite constructs, and this belongs to the
  // machine rather than to the HTTP app — the disk keeps filling whether or not anybody
  // has the manager window open.
  const stopSampler = startStorageSampler(app.log);

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
      stopSampler();
      await app.close();

      /*
        ── Leave one file behind, not three ────────────────────────────────────

        The WAL is folded back in and truncated after the last request has finished and
        before the connection closes. Two things come from that: the next start has no
        log to replay, and anything that copies `walaa.db` while the service is stopped
        — an operator, a file-level backup, an upgrade script — gets the whole database
        rather than one that is behind by up to the WAL's ceiling (§12.17).

        It cannot fail a shutdown. A checkpoint blocked by a lingering reader leaves the
        data exactly as committed; SQLite folds the WAL in on the next open regardless.
      */
      const checkpoint = await checkpointWal();
      app.log.info({ checkpoint: checkpoint.detail, ok: checkpoint.ok }, 'wal checkpointed');

      await prisma.$disconnect();

      // Written last, and only on this path: a marker saying `stopped` is the claim
      // that nothing was interrupted, and the next boot skips a five-second integrity
      // check on the strength of it. A crash never reaches this line, which is exactly
      // how the next boot finds out.
      markStopped();

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

  // Started. Clear any record of a previous failure so the desktop app can never show
  // yesterday's reason next to today's working dashboard.
  clearStartupFailure();
}
