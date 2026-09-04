import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { loadEnv } from '../config/env';
import {
  ensureSqliteDirectory,
  liveDatabasePath,
  resolveDataDir,
  resolveMigrationsDir,
} from '../config/paths';
import { applySqlitePragmas, prisma as defaultClient } from './prisma';
import { takeSnapshot } from '../services/backup/snapshot';

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
  log?: (message: string) => void;
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
        throw new Error(
          `الترحيل «${migration.name}» بدأ ولم يكتمل — على الأرجح توقّف التشغيل أثناء التثبيت. ` +
            'يلزم إصلاح يدوي: استعد من نسخة احتياطية أو احذف قاعدة البيانات الفارغة وأعد التشغيل.',
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
    throw new Error(
      `تعذّر أخذ نسخة احتياطية قبل ترحيل قاعدة البيانات، والترحيل موقوف. ` +
        `الترحيلات المعلّقة: ${pending.join('، ')}. السبب: ${reason}. ` +
        'قاعدة البيانات لم تتغيّر — أفرغ مساحة على القرص أو خذ نسخة يدوية ثم أعد التشغيل.',
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

  try {
    await applySqlitePragmas(client);
  } catch (error) {
    throw explainCorruption(error, databaseUrl);
  }

  const log = options.log ?? ((): void => {});
  const pending = await listPendingMigrations({ ...options, client });
  if (pending.length > 0) await snapshotBeforeMigrating(pending, log);

  return applyPendingMigrations({ ...options, client });
}
