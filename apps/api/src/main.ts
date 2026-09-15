import { hostname } from 'node:os';
import { buildApp } from './app';
import { configSource, loadEnv } from './config/env';
import { liveDatabasePath } from './config/paths';
import {
  assertMigrationsMatchBuild,
  migrationsMatchBuild,
  verifyDatabaseIdentity,
} from './lib/db-identity';
import { markRunning, markStopped, verifyDatabaseIntegrity } from './lib/db-integrity';
import { assertDatabaseMatchesBuild, isDemoBuild } from './lib/demo-guard';
import { onRestartRequested, RESTART_EXIT_CODE } from './lib/lifecycle';
import { ensureDatabaseReady, installDatabaseTemplateIfAbsent } from './lib/migrate';
import { checkpointWal, prisma, readSqliteSettings } from './lib/prisma';
import {
  applyStagedRestore,
  confirmRestore,
  requestRollback,
  rollbackSentence,
} from './lib/restore-apply';
import { supersedeUnusableDatabase } from './lib/supersede-database';
import { clearStartupFailure } from './lib/startup-error';
import { recordAppliedRestore } from './services/backup/restore.service';
import { applyHeldSales } from './services/held-sale.service';
import { initLicensing, startLicenseClock } from './services/license.service';
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

type BootstrapLog = (message: string, extra?: Record<string, unknown>) => void;

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
  const bootstrapLog: BootstrapLog = (message, extra = {}) => {
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
    ── A restore the owner confirmed is put in place before anything else ───────

    Before the template check and before anything opens a connection: the swap is two
    renames, and Windows will not rename a file something holds open. The staged copy
    was fetched, decrypted and checked when the owner chose it; here it only changes
    places with the live file, which is kept, not deleted (`lib/restore-apply.ts`).

    Confirmed only once the service is actually serving. If this start fails on the
    restored file, the previous database goes back on the next start and the Backup
    screen says why.
  */
  const livePath = liveDatabasePath(env.DATABASE_URL);
  const restored = livePath ? applyStagedRestore(livePath, bootstrapLog) : null;

  try {
    await serve(bootstrapLog);
  } catch (error) {
    if (restored) requestRollback(restored, rollbackSentence(error), bootstrapLog);
    throw error;
  }

  if (restored) {
    const result = confirmRestore(restored, bootstrapLog);
    await recordAppliedRestore(result).catch((error: unknown) => {
      bootstrapLog('the restore could not be written to the restored database trail', {
        error: String(error),
      });
    });
  }
}

/** Everything from placing the database to listening. */
async function serve(bootstrapLog: BootstrapLog): Promise<void> {
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
    ── An EMPTY database from another build is moved aside, not refused ────────

    A merchant installed this release onto a machine that had had an earlier one on it.
    The installer left the old `walaa.db` alone — correctly; an installer that
    overwrites a data directory is one that can destroy a shop. So the service opened a
    file of the wrong shape and refused to start, telling him to restore a backup that
    did not exist from a screen he could not reach, or to reinstall, which does not
    touch the data directory and so changes nothing.

    The file had nothing in it. This asks before refusing: a file with rows in it still
    stops the process below, and an empty one is renamed beside itself and replaced with
    the shipped template.

    Placed HERE deliberately. It must be after `assertMigrationsMatchBuild`, because a
    build that cannot vouch for its own migrations must not be trusted to judge a
    merchant's file; and before anything else opens the database, because Windows will
    not rename a file that a connection is holding open.
  */
  const supersede = await supersedeUnusableDatabase(bootstrapLog, {
    buildIsSound: migrationsMatchBuild() === true,
    /* The build's own signal, not the shape of a filename. `walaa-demo.db` in the
       path would have been a proxy for "this is a demo", and a proxy is what every
       defect in this class has been made of. */
    demo: isDemoBuild(),
  });
  if (supersede.verdict !== 'not-applicable' && supersede.verdict !== 'usable') {
    bootstrapLog('existing database triage', {
      verdict: supersede.verdict,
      parkedAt: supersede.parkedAt ?? null,
      rows: supersede.census?.total ?? null,
      createdBy: supersede.createdBy ?? null,
    });
  }

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

  /*
    The settings every concurrency guarantee rests on, read back from SQLite rather
    than assumed from having set them. WAL is refused on some filesystems and silently
    stays `delete`; foreign keys are off by default on any connection that missed the
    setup. Logging them means a support call — and a concurrency test claiming to have
    run under production settings — can compare rather than trust.
  */
  bootstrapLog('sqlite settings', { ...(await readSqliteSettings()) });

  // The licence: the device ID, the three clock anchors, the status. Before serving, so
  // the first request is already answered under it; its failures are sentences.
  await initLicensing(bootstrapLog);
  // Sales held while read-only are applied as soon as recording is allowed: now, if a
  // licence arrived while the service was stopped, and on every beat of the clock after.
  void applyHeldSales()
    .then((result) => {
      if (result.applied > 0 || result.closed > 0) bootstrapLog('held sales applied', { ...result });
    })
    .catch(() => undefined);
  const stopLicenseClock = startLicenseClock(applyHeldSales);

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
  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    try {
      stopScheduler();
      stopSampler();
      stopLicenseClock();
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

      process.exit(exitCode);
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

  // A restore the owner confirmed ends this process on purpose. The service host sees
  // RESTART_EXIT_CODE and starts it again at once — not as a failure, with no backoff —
  // and that start puts the restored copy in place before opening the database.
  onRestartRequested((reason) => {
    void shutdown(`restart:${reason}`, RESTART_EXIT_CODE);
  });

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
