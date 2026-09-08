import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { loadEnv } from '../config/env';
import {
  ensureSqliteDirectory,
  liveDatabasePath,
  resolveDataDir,
  resolveDatabaseTemplate,
  resolveMigrationsDir,
} from '../config/paths';
import { applySqlitePragmas, prisma as defaultClient } from './prisma';
import { InsufficientSpaceError, takeSnapshot } from '../services/backup/snapshot';

/**
 * Runtime migrator — applies committed Prisma migrations without the Prisma CLI.
 *
 * **Why this exists.** The installed product is a Windows Service on a shop's back
 * office PC (CLAUDE_v3.md §12.3). `prisma migrate deploy` would drag the Prisma CLI,
 * its schema engine binary and a Node toolchain onto that machine — tens of megabytes
 * of developer tooling, shipped so it can run once. Worse, it would make the
 * merchant's first boot depend on a subprocess that can fail in ways the installer
 * cannot report. The migration files are 12 KB of SQL; applying them from inside the
 * service is both smaller and more honest about what is happening.
 *
 * **The bookkeeping is Prisma's, not ours.** Applied migrations are recorded in
 * `_prisma_migrations`, with Prisma's own column layout and its checksum algorithm
 * (SHA-256 of the migration file). A database provisioned by this migrator is
 * therefore indistinguishable to `prisma migrate status` from one provisioned by the
 * CLI — which matters the day a developer connects to a merchant's database to
 * diagnose something.
 *
 * **It fails closed.** A migration whose file changed after it was applied, or one
 * left half-applied by a crash, stops the boot. Silently continuing on a schema that
 * is not the schema the code was built against is how a till starts writing rows
 * nobody can read back.
 */

/** Prisma's own table, verbatim, so the CLI recognises what we wrote. */
const MIGRATIONS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id"                    TEXT PRIMARY KEY NOT NULL,
    "checksum"              TEXT NOT NULL,
    "finished_at"           DATETIME,
    "migration_name"        TEXT NOT NULL,
    "logs"                  TEXT,
    "rolled_back_at"        DATETIME,
    "started_at"            DATETIME NOT NULL DEFAULT current_timestamp,
    "applied_steps_count"   INTEGER UNSIGNED NOT NULL DEFAULT 0
)`;

interface AppliedRow {
  migration_name: string;
  checksum: string;
  finished_at: unknown;
  rolled_back_at: unknown;
}

export interface MigrationOutcome {
  /** Directory the migrations were read from. */
  directory: string;
  /** Names applied by this call, in order. */
  applied: string[];
  /** Names already present in `_prisma_migrations` and left alone. */
  skipped: string[];
}

export interface MigrateOptions {
  client?: PrismaClient;
  /** Overrides discovery. Used by the tests. */
  directory?: string;
  /**
   * Structured, like `bootstrapLog` in `main.ts`, which is what is passed here in
   * production. The second argument is where the technical detail goes when the
   * merchant-facing message deliberately withholds it — migration names, counts, the
   * environment the decision was taken in. One-argument callers still typecheck.
   */
  log?: (message: string, extra?: Record<string, unknown>) => void;
}

/** SHA-256 of the migration file, hex — the same value the Prisma CLI stores. */
export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

/**
 * Splits a migration file into executable statements.
 *
 * SQLite's driver takes one statement per call, and Prisma's SQLite migrations are
 * plain DDL: `CREATE TABLE`, `CREATE INDEX`, `PRAGMA`, `INSERT`, separated by `;`.
 * String literals, quoted identifiers and comments are tracked so a `;` inside any of
 * them is not treated as a separator.
 *
 * **Known limit:** a `CREATE TRIGGER ... BEGIN ... ; ... END;` body would be split
 * apart. Prisma's SQLite migration emitter does not produce triggers; if one is ever
 * hand-written into a migration, this needs a BEGIN/END depth counter first.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    // Line comment — discard to end of line.
    if (char === '-' && next === '-') {
      while (index < sql.length && sql[index] !== '\n') index += 1;
      continue;
    }

    // Block comment — discard to the closing marker.
    if (char === '/' && next === '*') {
      index += 2;
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) index += 1;
      index += 2;
      continue;
    }

    // String literal or quoted identifier — copied through verbatim.
    if (char === "'" || char === '"') {
      const quote = char;
      current += char;
      index += 1;
      while (index < sql.length) {
        current += sql[index];
        if (sql[index] === quote) {
          // A doubled quote is an escaped quote, not the end of the literal.
          if (sql[index + 1] === quote) {
            current += sql[index + 1];
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (char === ';') {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = '';
      index += 1;
      continue;
    }

    current += char;
    index += 1;
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

/** Migration directories on disk, chronological — the timestamp prefix sorts. */
export function readMigrationDirectory(directory: string): { name: string; sql: string }[] {
  return readdirSync(directory)
    .filter((name) => statSync(join(directory, name)).isDirectory())
    .filter((name) => existsSync(join(directory, name, 'migration.sql')))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      sql: readFileSync(join(directory, name, 'migration.sql'), 'utf8'),
    }));
}

/**
 * Brings the connected database up to the committed schema.
 *
 * Idempotent: with nothing pending it issues one `CREATE TABLE IF NOT EXISTS` and one
 * `SELECT`, so calling it on every boot costs nothing measurable.
 */
export async function applyPendingMigrations(
  options: MigrateOptions = {},
): Promise<MigrationOutcome> {
  const client = options.client ?? defaultClient;
  const log = options.log ?? ((): void => {});

  const directory = options.directory ?? resolveMigrationsDir();
  if (!directory) {
    throw new Error(
      'تعذّر العثور على مجلد الترحيلات (migrations). حدّد WALAA_MIGRATIONS_DIR أو شغّل الخدمة من مجلد التثبيت.',
    );
  }

  await client.$executeRawUnsafe(MIGRATIONS_TABLE_DDL);

  const rows = await client.$queryRawUnsafe<AppliedRow[]>(
    'SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations"',
  );
  const applied = new Map(rows.map((row) => [row.migration_name, row]));

  const outcome: MigrationOutcome = { directory, applied: [], skipped: [] };

  for (const migration of readMigrationDirectory(directory)) {
    const checksum = migrationChecksum(migration.sql);
    const record = applied.get(migration.name);

    if (record) {
      if (record.checksum !== checksum) {
        throw new Error(
          `الترحيل «${migration.name}» تغيّر بعد تطبيقه (اختلاف البصمة). ` +
            'قاعدة البيانات لا تطابق المخطط المتوقع — أوقف التشغيل وراجع الترحيلات.',
        );
      }
      if (record.rolled_back_at !== null && record.rolled_back_at !== undefined) {
        throw new Error(
          `الترحيل «${migration.name}» مسجّل كمُتراجَع عنه. يلزم إصلاح يدوي قبل التشغيل.`,
        );
      }
      if (record.finished_at === null || record.finished_at === undefined) {
        /*
          ── The remedy must be safe when it is misread ─────────────────────────

          This used to end «استعد من نسخة احتياطية أو احذف قاعدة البيانات الفارغة» —
          restore a backup, or delete the empty database. The second half was written
          for a first install, where the file really is empty and deleting it is the
          quickest way out.

          A first install cannot reach this any more: production copies a pre-migrated
          template and never migrates. What CAN reach it is a database with a shop's
          trading in it — and there, an instruction containing the words "delete the
          database" is one misreading away from the worst outcome this product has.
          The person reading it is already alarmed and looking for the short way out.

          So the dangerous half is gone. Nothing here tells anybody to delete anything.
        */
        throw new Error(
          `تعذّر تشغيل الخدمة: تحديث بنية قاعدة البيانات «${migration.name}» بدأ ولم يكتمل، ` +
            'على الأرجح لأنّ الجهاز توقّف أثناء التحديث. ' +
            'لم تُفتح قاعدة البيانات ولم تتغيّر الآن. ' +
            '**لا تحذف أي ملف** — أوقف الخدمة، واستعد أحدث نسخة احتياطية من شاشة النسخ الاحتياطي، ' +
            'أو تواصل مع الدعم الفني. التفاصيل التقنية مسجّلة في ملف السجل.',
        );
      }
      outcome.skipped.push(migration.name);
      continue;
    }

    const statements = splitSqlStatements(migration.sql);
    log(`applying migration ${migration.name} (${statements.length} statements)`);

    // One transaction for the whole migration: a failure halfway through leaves the
    // database exactly as it was, so the next boot retries cleanly instead of hitting
    // "table already exists" on a half-created schema. SQLite is fully transactional
    // over DDL, which is why this is safe here and would not be on MySQL.
    await client.$transaction([
      ...statements.map((statement) => client.$executeRawUnsafe(statement)),
      client.$executeRawUnsafe(
        `INSERT INTO "_prisma_migrations"
           ("id", "checksum", "migration_name", "started_at", "finished_at", "applied_steps_count")
         VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`,
        randomUUID(),
        checksum,
        migration.name,
        statements.length,
      ),
    ]);

    outcome.applied.push(migration.name);
  }

  return outcome;
}

/**
 * Turns SQLite's "database disk image is malformed" into a message naming the cause.
 *
 * **The cause is usually orphaned sidecars, and the generic error hides it.** SQLite
 * recovers from `-wal` and `-shm` on open. If the database file is replaced — a restore
 * copied over it, an upgrade script, `prisma migrate reset` — while those sidecars are
 * left behind, SQLite replays a log belonging to a file that no longer exists and the
 * open fails as corruption. The data is usually fine; the pairing is not.
 *
 * **How strongly this is claimed.** A `prisma migrate reset` on 2026-09-04 did fail
 * with a malformed image, and clearing all three files fixed it — but the sidecars
 * were already gone by the time the directory was inspected, and three later attempts
 * to stage the failure from mismatched sidecars all opened cleanly. So orphaned
 * sidecars are a *candidate* cause worth naming to whoever is standing in front of the
 * error, not a diagnosis. The message says so rather than asserting it.
 *
 * **It reports and refuses; it never deletes.** Removing a `-wal` beside a live
 * database throws away committed transactions that have not been checkpointed — which
 * is the §12.17 loss, caused by the thing meant to fix it. Whether those sidecars are
 * orphans or the newest sales in the shop is not knowable from here, so the operator
 * decides with the backup in front of them.
 */
function explainCorruption(error: unknown, databaseUrl: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (!/malformed|not a database|file is encrypted/i.test(message)) {
    return error instanceof Error ? error : new Error(message);
  }

  const livePath = liveDatabasePath(databaseUrl);
  const sidecars = livePath
    ? (['-wal', '-shm'] as const).map((s) => `${livePath}${s}`).filter((p) => existsSync(p))
    : [];

  if (sidecars.length === 0) {
    return new Error(
      `قاعدة البيانات تالفة أو غير قابلة للقراءة (${message}). ` +
        'استعد من أحدث نسخة احتياطية — راجع إجراء الاستعادة في دليل التشغيل.',
    );
  }

  return new Error(
    'قاعدة البيانات لا تُفتح. من الأسباب المحتملة وجود ملفات مرافقة لا تطابقها — ' +
      'وقد لا يكون تلفاً فعلياً في البيانات. ' +
      `الملفات الموجودة: ${sidecars.join('، ')}. ` +
      'يحدث هذا عندما يُستبدَل ملف قاعدة البيانات بينما تبقى ملفاته المرافقة بجانبه. ' +
      '**لا تحذفها قبل التأكد**: إن كانت تخص قاعدة البيانات الحالية فهي تحتوي أحدث ' +
      'العمليات، وحذفها يفقدها. أوقف الخدمة، خذ نسخة من مجلد البيانات كاملاً، ' +
      `ثم راجع إجراء الاستعادة في دليل التشغيل. (${message})`,
  );
}

/**
 * Names of migrations on disk that this database has not recorded as applied.
 *
 * Read-only and cheap: one `CREATE TABLE IF NOT EXISTS` and one `SELECT`, the same
 * two statements `applyPendingMigrations` opens with.
 */
export async function listPendingMigrations(options: MigrateOptions = {}): Promise<string[]> {
  const client = options.client ?? defaultClient;
  const directory = options.directory ?? resolveMigrationsDir();
  if (!directory) return [];

  await client.$executeRawUnsafe(MIGRATIONS_TABLE_DDL);
  const rows = await client.$queryRawUnsafe<AppliedRow[]>(
    'SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations"',
  );
  const applied = new Set(rows.map((row) => row.migration_name));

  return readMigrationDirectory(directory)
    .map((migration) => migration.name)
    .filter((name) => !applied.has(name));
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE LEDGER ITSELF, CHECKED ON EVERY BOOT — INCLUDING THE ONES THAT MIGRATE NOTHING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── The gap this closes, found by a kill drill ───────────────────────────────
 *
 * `_prisma_migrations` records a migration as started, and marks `finished_at` when it
 * completes. A row with `finished_at` NULL means the last attempt died half-way; a row
 * with `rolled_back_at` means somebody undid one by hand. Both mean the schema on disk
 * is not the schema the ledger claims, and both were already refused — inside
 * `applyPendingMigrations`, in the loop that walks the migration files.
 *
 * Which was fine until production stopped calling it. The service now ships a
 * pre-migrated template and only VERIFIES, so `applyPendingMigrations` is not reached
 * on a normal boot; and `listPendingMigrations` treats a row's mere PRESENCE as
 * "applied", so a half-finished row is not pending either. The result was a production
 * service that started happily on a database whose last migration had been interrupted
 * — the exact condition the check was written for, made invisible by the change that
 * removed the code path around it.
 *
 * The drill caught it: marking the newest migration unfinished and restarting produced
 * a healthy service instead of a refusal.
 *
 * So the ledger is now inspected on its own, before any decision about migrating, on
 * every boot in every mode. It reads two statements and costs nothing.
 */
export async function assertMigrationLedgerIsSound(
  options: MigrateOptions = {},
): Promise<void> {
  const client = options.client ?? defaultClient;

  await client.$executeRawUnsafe(MIGRATIONS_TABLE_DDL);
  const rows = await client.$queryRawUnsafe<AppliedRow[]>(
    'SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations"',
  );

  const unfinished = rows.filter((row) => row.finished_at === null || row.finished_at === undefined);
  const rolledBack = rows.filter((row) => row.rolled_back_at !== null && row.rolled_back_at !== undefined);

  if (unfinished.length === 0 && rolledBack.length === 0) return;

  const log = options.log ?? ((): void => {});
  log('migration ledger is not sound', {
    unfinished: unfinished.map((r) => r.migration_name),
    rolledBack: rolledBack.map((r) => r.migration_name),
  });

  /*
    Worded like the other installation faults: it is not the merchant's data that is
    wrong, and the remedy he would otherwise reach for — restoring a backup — is not
    the one that helps. The migration NAMES stay in the log; they are English directory
    names with timestamps in them and mean nothing to a shop owner.
  */
  const count = unfinished.length + rolledBack.length;
  throw new Error(
    `تعذّر تشغيل الخدمة: ${count} من تحديثات بنية قاعدة البيانات لم تكتمل — ` +
      'على الأرجح توقّف الجهاز أثناء تحديث البرنامج. ' +
      'لم تُفتح قاعدة البيانات ولم تتغيّر الآن. ' +
      '**لا تحذف أي ملف** — أوقف الخدمة، واستعد أحدث نسخة احتياطية من شاشة النسخ الاحتياطي، ' +
      'أو تواصل مع الدعم الفني. التفاصيل التقنية مسجّلة في ملف السجل.',
  );
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A SNAPSHOT BEFORE ANY MIGRATION, AND FAIL CLOSED IF IT CANNOT BE TAKEN
 * ═══════════════════════════════════════════════════════════════════════════
 * (CLAUDE_UPDATE_4.md §10.2)
 *
 * **The gap this closes.** Migrations run at boot with nothing behind them: the backup
 * scheduler starts *after* this, so the recovery position for a bad migration was the
 * last scheduled backup — up to 24 hours old.
 *
 * **And frequently no backup at all.** §12.19 blocks backups until the key ceremony is
 * confirmed, so a shop that upgrades before completing it has never taken one. The
 * moment of greatest schema risk coincides exactly with the window in which this
 * product guarantees no backup exists.
 *
 * **Why refusing to boot is right here, when refusing a write is wrong.** §12.16
 * forbids the latter absolutely: the discount is already given, so refusing frees
 * nothing and manufactures the cash-versus-POS discrepancy it claims to prevent. A
 * migration inverts cleanly, the same way a backup does (§12.18) — declining loses
 * nothing, because the data is still there and the old binary still runs. A blocked
 * boot during a supervised upgrade produces a phone call; a silent destructive
 * migration produces a shop that finds out weeks later at reconciliation.
 *
 * It runs only when something is actually pending, so an ordinary boot pays nothing.
 */
async function snapshotBeforeMigrating(
  pending: string[],
  log: (message: string) => void,
): Promise<void> {
  const databaseUrl = loadEnv().DATABASE_URL;

  // Nothing to snapshot for a non-file datasource. `takeSnapshot` would refuse anyway;
  // refusing to boot over it would be a wall in front of a database this cannot help.
  if (!liveDatabasePath(databaseUrl)) return;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = join(resolveDataDir(), `pre-migration-${stamp}.db`);

  try {
    const result = await takeSnapshot(databaseUrl, destination);
    log(
      `pre-migration snapshot written: ${result.path} (${result.bytes} bytes) ` +
        `before ${pending.length} migration(s)`,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    /*
      ── The remedy has to match the cause ──────────────────────────────────────

      Every failure here used to end with «أفرغ مساحة على القرص أو خذ نسخة يدوية» —
      free up disk space. A permissions error, a missing directory and a locked file
      all told the merchant to clear his disk, which cannot work, on a screen that had
      already told him one wrong thing. It was not hypothetical: pointing the data
      directory at a folder the process could not read produced `EPERM ... statfs` and
      an instruction to free space on a disk that was 78% empty.

      Only a genuine out-of-space refusal gets the out-of-space instruction. Anything
      else names the folder and says it could not be written, which is both true and
      actionable. `InsufficientSpaceError` already carries the free bytes, the required
      bytes, the database size and the multiple, so the numbers behind the verdict are
      in the sentence rather than left for someone to guess at.
    */
    const folder = resolveDataDir();
    const remedy =
      error instanceof InsufficientSpaceError
        ? `أفرغ مساحة على القرص الذي يحتوي «${folder}» ثم أعد التشغيل.`
        : `تعذّر الكتابة في «${folder}» — تحقّق من وجود هذا المجلد ومن صلاحيات الوصول إليه، ثم أعد التشغيل.`;

    throw new Error(
      `تعذّر أخذ نسخة احتياطية قبل ترحيل قاعدة البيانات، والترحيل موقوف. ` +
        `الترحيلات المعلّقة: ${pending.join('، ')}. السبب: ${reason}. ` +
        `قاعدة البيانات لم تتغيّر — ${remedy}`,
    );
  }
}

/**
 * Full first-boot database bootstrap: create the directory, open the connection with
 * the right pragmas, snapshot if anything is pending, then apply it.
 *
 * This is what makes the installer a single step — there is no "now run the migration
 * tool" instruction for a shop owner to get wrong.
 *
 * The snapshot lives here rather than inside `applyPendingMigrations` on purpose: this
 * is the one caller that is always operating on the real database named by
 * `DATABASE_URL`. The test suite drives `applyPendingMigrations` directly against its
 * own temporary clients, and a snapshot there would either copy the wrong database or
 * have to be remembered-to-disable in every test — the kind of default that is wrong
 * exactly once and expensively.
 */
export async function ensureDatabaseReady(options: MigrateOptions = {}): Promise<MigrationOutcome> {
  const databaseUrl = loadEnv().DATABASE_URL;
  ensureSqliteDirectory(databaseUrl);
  const client = options.client ?? defaultClient;
  const log = options.log ?? ((): void => {});

  try {
    await applySqlitePragmas(client);
  } catch (error) {
    throw explainCorruption(error, databaseUrl);
  }

  /*
    Resolved here rather than left to `applyPendingMigrations`, because the common path
    now returns before ever calling it. A missing migrations directory must still be the
    hard error it has always been: without one, "nothing is pending" is not a verdict,
    it is an absence of evidence, and answering it with a successful boot is how a
    service comes up against a schema nobody checked.
  */
  const directory = options.directory ?? resolveMigrationsDir();
  if (!directory) {
    throw new Error(
      'تعذّر العثور على مجلد الترحيلات (migrations). حدّد WALAA_MIGRATIONS_DIR أو شغّل الخدمة من مجلد التثبيت.',
    );
  }

  /*
    Before any question about what is PENDING: is what is already recorded sound? A
    half-applied migration is not pending — its row exists — so this has to be asked
    separately, and on every boot rather than only on the ones that migrate.
  */
  await assertMigrationLedgerIsSound({ ...options, client });

  const pending = await listPendingMigrations({ ...options, client, directory });

  if (pending.length > 0 && migrationPolicy() === 'verify') {
    /*
      ── A merchant's machine does not migrate ────────────────────────────────

      The shipped template is already at this schema, so reaching here in production
      means one of three things, none of which a service start should resolve on its
      own: the runtime directory pairs a new bundle with an old database, the database
      came from somewhere else, or the template was not shipped at all.

      Every one of those is repaired by a person with the backup in front of them, and
      every one of them gets worse if the process writes first and reports afterwards.

      The migration NAMES stay in the log. They are English directory names with
      timestamps in them and mean nothing to a shop owner; the count and the remedy do.
    */
    log('refusing to migrate outside development', {
      pending,
      count: pending.length,
      nodeEnv: loadEnv().NODE_ENV,
      hint: 'set WALAA_ALLOW_MIGRATIONS=1 to permit this deliberately',
    });

    throw new Error(
      `تعذّر تشغيل الخدمة: قاعدة البيانات تحتاج ${pending.length} تحديثاً لبنيتها، ` +
        'والبرنامج لا يُحدّث بنية قاعدة البيانات من تلقاء نفسه على جهاز المتجر. ' +
        'المطلوب أن تكون قاعدة البيانات والبرنامج من نفس الإصدار. ' +
        'لم يُكتب أي شيء في قاعدة البيانات. أعد تثبيت البرنامج من ملف التثبيت الكامل، ' +
        'أو تواصل مع الدعم الفني. التفاصيل التقنية مسجّلة في ملف السجل.',
    );
  }

  if (pending.length > 0) await snapshotBeforeMigrating(pending, (message) => log(message));

  /*
    Called on every path, including the one where nothing is pending, and that is not
    a wasted call. `applyPendingMigrations` is where an ALREADY-applied migration is
    validated: a file whose checksum no longer matches what was recorded, one marked
    rolled back, one that started and never finished. Returning early on
    "nothing pending" would silently drop all three, because `listPendingMigrations`
    compares names and nothing else — and a schema that quietly stopped being the
    schema the code was built against is the failure this module opens by naming.
  */
  return applyPendingMigrations({ ...options, client, directory });
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHO IS ALLOWED TO MIGRATE, AND WHY IT IS NOT THE MERCHANT'S MACHINE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Applying migrations at boot was the right call while this was the only provisioning
 * step there was — §12.11 wanted an installer with no "now run the migration tool"
 * instruction for a shop owner to get wrong. It is the wrong call now that the build
 * ships an already-migrated template, and it was wrong for a reason that already cost a
 * shop its opening: a first launch that migrates is a first launch that can fail, and
 * the failure it produced was an API exiting 1 on a thirty-second loop with a snapshot
 * guard refusing over disk space it did not need.
 *
 * Development still migrates. That is where migrations are written, where branches move
 * the schema several times a day, and where the whole test suite provisions itself.
 *
 * `WALAA_ALLOW_MIGRATIONS=1` restores the old behaviour in production for one situation:
 * an operator upgrading a shop, deliberately, with the pre-migration snapshot below
 * doing its job and someone watching the log. It is not written into `walaa.env` by
 * anything, and the refusal above names it only in the technical log — a shop owner
 * following a sentence on his screen must never be able to talk himself into it.
 */
export function migrationPolicy(): 'apply' | 'verify' {
  if (process.env.WALAA_ALLOW_MIGRATIONS === '1') return 'apply';
  return loadEnv().NODE_ENV === 'production' ? 'verify' : 'apply';
}

export interface TemplateInstall {
  installed: boolean;
  reason:
    | 'installed'
    | 'database-present'
    | 'no-template'
    | 'not-a-file-datasource'
    | 'template-unreadable';
  databasePath: string | null;
  templatePath: string | null;
  bytes: number | null;
  /** Sidecars moved out of the way because they had no database to belong to. */
  orphanedSidecars: string[];
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  FIRST LAUNCH: COPY THE SHIPPED DATABASE, DO NOT BUILD ONE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Pure filesystem, and it must stay that way: it runs **before any connection is
 * opened**, because opening one is itself what creates the empty file this is trying to
 * avoid. SQLite creates the database on connect, so a guard that ran after the first
 * `PRAGMA` would always find a database present and never install anything.
 *
 * ── A zero-byte file counts as absent, and that is the point ─────────────────
 *
 * SQLite treats a zero-length file as a valid empty database, which is precisely how
 * the `C:\ProgramData\Walaa\walaa.db` incident happened: a file left behind by an
 * earlier install, containing nothing, adopted without a word by a build that had
 * never placed it. Treating it as absent means that exact file gets replaced by the
 * shipped template instead of migrated into existence — and the replacement is
 * announced, with the file named.
 *
 * ── Orphaned sidecars are moved aside, never deleted ─────────────────────────
 *
 * A `-wal` with no database beside it cannot be replayed into anything: the WAL holds
 * page images, and without the base file most of the database is simply not there. But
 * "cannot be used" is not "safe to destroy" — the rule in `explainCorruption` below
 * holds here too. They are renamed with a timestamp, named in the log, and left for a
 * person to look at.
 */
export function installDatabaseTemplateIfAbsent(
  log: (message: string, extra?: Record<string, unknown>) => void = () => {},
): TemplateInstall {
  const databaseUrl = loadEnv().DATABASE_URL;
  const databasePath = liveDatabasePath(databaseUrl);

  const nothing = (reason: TemplateInstall['reason']): TemplateInstall => ({
    installed: false,
    reason,
    databasePath,
    templatePath: null,
    bytes: null,
    orphanedSidecars: [],
  });

  if (!databasePath) return nothing('not-a-file-datasource');

  const present = existsSync(databasePath) && statSync(databasePath).size > 0;
  if (present) return nothing('database-present');

  const templatePath = resolveDatabaseTemplate();
  if (!templatePath) {
    // Normal in development, where `prisma migrate deploy` provisions the database and
    // no template has been built. In production `stage.mjs` refuses to ship without
    // one, so this branch cannot be reached from an installer.
    return nothing('no-template');
  }

  ensureSqliteDirectory(databaseUrl);

  const orphanedSidecars: string[] = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const suffix of ['-wal', '-shm'] as const) {
    const sidecar = `${databasePath}${suffix}`;
    if (!existsSync(sidecar)) continue;
    const parked = `${sidecar}.orphan-${stamp}`;
    try {
      renameSync(sidecar, parked);
      orphanedSidecars.push(parked);
    } catch (error) {
      log('could not move an orphaned sidecar aside', {
        sidecar,
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const existedEmpty = existsSync(databasePath);
  try {
    copyFileSync(templatePath, databasePath);
  } catch (error) {
    log('could not install the shipped database template', {
      templatePath,
      databasePath,
      err: error instanceof Error ? error.message : String(error),
    });
    return { ...nothing('template-unreadable'), templatePath, orphanedSidecars };
  }

  const bytes = statSync(databasePath).size;
  log('installed the shipped database template', {
    templatePath,
    databasePath,
    bytes,
    replacedEmptyFile: existedEmpty,
    orphanedSidecars,
  });

  return {
    installed: true,
    reason: 'installed',
    databasePath,
    templatePath,
    bytes,
    orphanedSidecars,
  };
}
