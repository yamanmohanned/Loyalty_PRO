import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { loadEnv } from '../config/env';
import { ensureSqliteDirectory, resolveMigrationsDir } from '../config/paths';
import { applySqlitePragmas, prisma as defaultClient } from './prisma';

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
 * Full first-boot database bootstrap: create the directory, open the connection with
 * the right pragmas, apply anything pending.
 *
 * This is what makes the installer a single step — there is no "now run the migration
 * tool" instruction for a shop owner to get wrong.
 */
export async function ensureDatabaseReady(options: MigrateOptions = {}): Promise<MigrationOutcome> {
  ensureSqliteDirectory(loadEnv().DATABASE_URL);
  const client = options.client ?? defaultClient;
  await applySqlitePragmas(client);
  return applyPendingMigrations({ ...options, client });
}
