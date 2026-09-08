import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { API_VERSION } from '../config/version';
import { loadEnv } from '../config/env';
import { resolveMigrationsDir } from '../config/paths';
import { EXPECTED_MIGRATIONS_FINGERPRINT, EXPECTED_SCHEMA_HASH } from '../config/schema-fingerprint';
import { prisma as defaultClient } from './prisma';
import { readMigrationDirectory, migrationChecksum } from './migrate';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  PROVING THE DATABASE THAT WAS ACTUALLY OPENED IS THIS INSTALLATION'S
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── The failure this closes ──────────────────────────────────────────────────
 *
 * A `walaa.db` was found at `C:\ProgramData\Walaa` that no build on that machine had
 * placed, and a demo build adopted it without a word. That file happened to be empty,
 * so the visible symptom was six unexpected migrations. Had it been a shop's live
 * database, a demo build would have migrated, snapshotted and reseeded over a
 * merchant's customer list — and the first anyone would have known is that the numbers
 * were wrong.
 *
 * `lib/demo-guard.ts` closed the demo half of that with a `demo_provenance` row and a
 * check on the open file's *name*. This is the production half, and it asks three
 * questions the name alone cannot answer:
 *
 *   1. **Whose file is this?** A `db_identity` row carries an installation id, when it
 *      was created, and by what. A database this installation did not create, and
 *      that carries someone else's data, is refused in production rather than adopted.
 *   2. **Is it the shape this binary was built for?** A hash derived from
 *      `sqlite_master` — the schema SQLite actually has, not the schema the migration
 *      ledger claims — compared against a value compiled into the build.
 *   3. **Are the migrations beside the binary the ones the binary was built with?** A
 *      fingerprint over the shipped migration set, also compared against a compiled-in
 *      constant, so a runtime directory assembled from two different builds is caught.
 *
 * ── Why `PRAGMA database_list` and not `DATABASE_URL` ────────────────────────
 *
 * `DATABASE_URL` is the file we *asked* for. Every mistake in this class — a typo, a
 * stale environment file, a relative path resolved from an unexpected working
 * directory, an installer that wrote one name and a service that opened another — is a
 * mistake in which the asked-for file and the opened file differ. Only SQLite can say
 * which one it has, and it says so through `PRAGMA database_list`.
 *
 * ── Where it fails closed, and where it does not ─────────────────────────────
 *
 * Refusing to start is right here for the same reason it is right before a migration
 * and wrong at the till (§12.16): nothing is lost by declining. The data is still on
 * disk and the previous build still runs. What is lost by *not* declining is a shop's
 * ledger, written into by a process that was not looking at it.
 *
 * Outside production the same checks run and report, but do not stop the process:
 * development databases are made by `prisma migrate deploy`, carry no identity until
 * one is stamped, and legitimately change shape between branches.
 */

/** The table carrying this installation's signature. Created on demand. */
export const IDENTITY_TABLE = 'db_identity';

const IDENTITY_DDL = `
CREATE TABLE IF NOT EXISTS "${IDENTITY_TABLE}" (
  "id"                     INTEGER PRIMARY KEY CHECK ("id" = 1),
  "installationId"         TEXT NOT NULL,
  "createdAt"              TEXT NOT NULL,
  "createdBy"              TEXT NOT NULL,
  "productVersion"         TEXT NOT NULL,
  "schemaHash"             TEXT NOT NULL,
  "migrationsFingerprint"  TEXT NOT NULL,
  "adoptedAt"              TEXT,
  "adoptedReason"          TEXT
)`;

export interface DatabaseIdentity {
  installationId: string;
  createdAt: string;
  createdBy: string;
  productVersion: string;
  schemaHash: string;
  migrationsFingerprint: string;
  adoptedAt: string | null;
  adoptedReason: string | null;
}

/**
 * Objects excluded from the schema hash.
 *
 * `sqlite_%` is SQLite's own bookkeeping (`sqlite_sequence` appears with the first
 * AUTOINCREMENT row, `sqlite_stat1` after an ANALYZE), and neither is part of the
 * schema this binary was built against. `db_identity` and `demo_provenance` are
 * written by the runtime rather than by a migration, so including them would make the
 * hash change the moment it was first recorded — a check that invalidates itself.
 */
const HASH_EXCLUDED = new Set([IDENTITY_TABLE, 'demo_provenance']);

/** The path SQLite genuinely has open, as SQLite reports it. Never `DATABASE_URL`. */
export async function openDatabaseFile(client: PrismaClient = defaultClient): Promise<string> {
  const rows = await client.$queryRawUnsafe<Array<{ file: string | null }>>('PRAGMA database_list');
  return rows.find((row) => row.file)?.file ?? '';
}

/**
 * Removes SQL comments from a stored `CREATE` statement, leaving string literals and
 * quoted identifiers untouched.
 *
 * ── Why this is here, and what it cost to find ───────────────────────────────
 *
 * SQLite stores the DDL text it was handed, comments and all. This project has **two**
 * ways of handing it that text, and they do not agree:
 *
 *   - the Prisma CLI (`prisma migrate dev`) executes the migration file verbatim, so
 *     every `--` comment written in it is preserved inside `sqlite_master`;
 *   - this project's runtime migrator strips comments while splitting statements
 *     (`splitSqlStatements` in `lib/migrate.ts`), so the same DDL is stored without
 *     them.
 *
 * The shipped template is built by the second; a developer's database by the first.
 * Measured: their `card` and `card_batch` definitions diverge at exactly the first
 * `--` comment and at nothing else — 57 objects, identical names, identical
 * semantics, two different hashes.
 *
 * That is the check refusing a database that is perfectly correct, over a difference
 * that is not a schema difference at all. Because the refusal is a boot refusal in
 * production, its consequence is a shop that will not open because of the wording of a
 * comment in a migration file.
 *
 * So the hash is taken over what the schema *is*, not over how the statement that
 * created it happened to be typed. Quotes are tracked because a `--` inside a string
 * literal or a quoted identifier is text rather than a comment, and stripping it would
 * change the very thing this is trying to capture.
 */
export function stripSqlComments(sql: string): string {
  let out = '';
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (char === '-' && next === '-') {
      while (index < sql.length && sql[index] !== '\n') index += 1;
      out += ' ';
      continue;
    }

    if (char === '/' && next === '*') {
      index += 2;
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) index += 1;
      index += 2;
      out += ' ';
      continue;
    }

    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const closing = char === '[' ? ']' : char;
      out += char;
      index += 1;
      while (index < sql.length) {
        out += sql[index];
        if (sql[index] === closing) {
          // A doubled quote is an escaped quote, not the end of the literal.
          if (sql[index + 1] === closing && closing !== ']') {
            out += sql[index + 1];
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

    out += char;
    index += 1;
  }

  return out;
}

/**
 * A hash of the schema SQLite actually has.
 *
 * Whitespace inside each stored `CREATE` statement is collapsed before hashing. That
 * is not cosmetic: a database provisioned by `prisma migrate deploy` and one
 * provisioned by this project's own runtime migrator (`lib/migrate.ts`) execute the
 * same DDL but can store it with different leading whitespace, because the runtime
 * splitter trims each statement. Hashing the raw text would make the two disagree
 * about a schema that is identical, and a check that cries wolf on a correct database
 * is a check that gets turned off.
 *
 * Rows with a NULL `sql` — the indexes SQLite creates for UNIQUE constraints — are
 * skipped for the same reason: they carry no text and are implied by the table they
 * belong to.
 */
export async function computeSchemaHash(client: PrismaClient = defaultClient): Promise<string> {
  const rows = await client.$queryRawUnsafe<Array<{ type: string; name: string; sql: string | null }>>(
    "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name",
  );

  const hash = createHash('sha256');
  for (const row of rows) {
    if (row.name.startsWith('sqlite_')) continue;
    if (HASH_EXCLUDED.has(row.name)) continue;
    const normalised = stripSqlComments(row.sql ?? '').replace(/\s+/g, ' ').trim();
    hash.update(`${row.type}\u0000${row.name}\u0000${normalised}\u0000`);
  }
  return hash.digest('hex');
}

/**
 * A hash over the committed migration set — every name and every file checksum, in
 * order.
 *
 * This describes the *build*, not the database: it answers "are the migration files
 * shipped beside this binary the ones it was built with", which the database cannot
 * be asked. A runtime directory assembled from two different builds — a new bundle
 * with an old `migrations/`, or the reverse — passes every other check here and is
 * exactly how a schema silently diverges from the code that reads it.
 */
export function computeMigrationsFingerprint(directory: string): string {
  const hash = createHash('sha256');
  for (const migration of readMigrationDirectory(directory)) {
    hash.update(`${migration.name}\u0000${migrationChecksum(migration.sql)}\u0000`);
  }
  return hash.digest('hex');
}

/** This installation's signature, or `null` if the file carries none. */
export async function readIdentity(
  client: PrismaClient = defaultClient,
): Promise<DatabaseIdentity | null> {
  try {
    const rows = await client.$queryRawUnsafe<DatabaseIdentity[]>(
      `SELECT "installationId", "createdAt", "createdBy", "productVersion", "schemaHash",
              "migrationsFingerprint", "adoptedAt", "adoptedReason"
         FROM "${IDENTITY_TABLE}" WHERE "id" = 1`,
    );
    return rows[0] ?? null;
  } catch {
    // No such table — which is the answer, not an error. Every database made before
    // this check existed, and every one made by `prisma migrate deploy`, lands here.
    return null;
  }
}

export interface StampOptions {
  client?: PrismaClient;
  /** What created this file, in words a support call can use. */
  createdBy: string;
  /** Set when an existing file was taken over rather than created. */
  adoptedReason?: string | null;
  /** Overrides the id. Only the tests supply one; production wants a fresh UUID. */
  installationId?: string;
}

/**
 * Writes (or rewrites) the signature.
 *
 * Called by the template builder at build time, by the development seed, and by the
 * runtime when it adopts a provably-empty file. Never called to silence a mismatch.
 */
export async function stampIdentity(options: StampOptions): Promise<DatabaseIdentity> {
  const client = options.client ?? defaultClient;
  await client.$executeRawUnsafe(IDENTITY_DDL);

  const existing = await readIdentity(client);

  // Measured from the migration files on disk, never copied from the compiled-in
  // constant. The template builder writes that constant *from* this run, so reading it
  // here would let a stale value stamp itself into the file it is supposed to describe.
  const directory = resolveMigrationsDir();

  const identity: DatabaseIdentity = {
    installationId: options.installationId ?? existing?.installationId ?? randomUUID(),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    createdBy: options.createdBy,
    productVersion: API_VERSION,
    schemaHash: await computeSchemaHash(client),
    migrationsFingerprint: directory
      ? computeMigrationsFingerprint(directory)
      : EXPECTED_MIGRATIONS_FINGERPRINT,
    adoptedAt: options.adoptedReason ? new Date().toISOString() : (existing?.adoptedAt ?? null),
    adoptedReason: options.adoptedReason ?? existing?.adoptedReason ?? null,
  };

  await client.$executeRawUnsafe(`DELETE FROM "${IDENTITY_TABLE}"`);
  await client.$executeRawUnsafe(
    `INSERT INTO "${IDENTITY_TABLE}"
       ("id", "installationId", "createdAt", "createdBy", "productVersion",
        "schemaHash", "migrationsFingerprint", "adoptedAt", "adoptedReason")
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    identity.installationId,
    identity.createdAt,
    identity.createdBy,
    identity.productVersion,
    identity.schemaHash,
    identity.migrationsFingerprint,
    identity.adoptedAt,
    identity.adoptedReason,
  );

  return identity;
}

/** Tables whose emptiness means "this file holds nothing a merchant would miss". */
const BUSINESS_TABLES = ['merchant', 'branch', 'user', 'customer', 'transaction'] as const;

export interface BusinessDataCensus {
  counts: Record<string, number>;
  total: number;
}

/**
 * How much a database would cost to be wrong about.
 *
 * The distinction this draws is the whole reason adoption can ever be safe: taking
 * over a file with nothing in it loses nothing and can be done with a log line, while
 * taking over a file with a merchant's customers in it is the failure this module
 * exists to prevent. A missing table counts as zero — a database too broken to
 * answer is not one holding data worth protecting.
 */
export async function censusBusinessData(
  client: PrismaClient = defaultClient,
): Promise<BusinessDataCensus> {
  const counts: Record<string, number> = {};
  for (const table of BUSINESS_TABLES) {
    try {
      const rows = await client.$queryRawUnsafe<Array<{ n: unknown }>>(
        `SELECT COUNT(*) AS n FROM "${table}"`,
      );
      counts[table] = Number(rows[0]?.n ?? 0);
    } catch {
      counts[table] = 0;
    }
  }
  return { counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
}

/**
 * Whether an identity failure stops the process.
 *
 * Production enforces. `WALAA_DB_OVERRIDE=1` downgrades enforcement to a loud warning
 * and exists for exactly one situation: a support engineer standing at a machine,
 * with a backup in hand, who has decided that this file is the right one. It is not a
 * configuration setting, it is not written into `walaa.env` by anything, and every
 * use of it is recorded in the log with the reason it was needed.
 */
export function identityEnforced(): boolean {
  if (process.env.WALAA_DB_OVERRIDE === '1') return false;
  return loadEnv().NODE_ENV === 'production';
}

export type IdentityVerdict =
  | 'verified'
  | 'stamped-new'
  | 'adopted-empty'
  | 'mismatch-tolerated';

export interface IdentityResult {
  verdict: IdentityVerdict;
  file: string;
  identity: DatabaseIdentity | null;
  schemaHash: string;
  expectedSchemaHash: string;
}

type Log = (message: string, extra?: Record<string, unknown>) => void;

/**
 * The build's own consistency: the migration files shipped beside this binary must be
 * the set it was compiled against.
 *
 * Separate from everything else here because it is answerable without a database, and
 * because its failure means the *installation* is wrong rather than the data. Runs in
 * every environment; only production refuses over it, since a developer switching
 * branches changes this legitimately several times a day.
 */
export async function assertMigrationsMatchBuild(log: Log): Promise<void> {
  const directory = resolveMigrationsDir();
  if (!directory) {
    // `ensureDatabaseReady` produces the actionable error for a missing migrations
    // directory. Duplicating it here would mean two different sentences for one fault.
    return;
  }

  const actual = computeMigrationsFingerprint(directory);
  if (actual === EXPECTED_MIGRATIONS_FINGERPRINT) {
    log('migration set verified', { directory, fingerprint: actual.slice(0, 12) });
    return;
  }

  log('migration set does not match the build', {
    directory,
    expected: EXPECTED_MIGRATIONS_FINGERPRINT,
    actual,
  });

  if (!identityEnforced()) return;

  /*
    Worded so it cannot be mistaken for a data problem.

    Everything about this failure is inside the installed program: the migration files
    beside the binary are not the ones it was built against. The database has not been
    opened, let alone written to. A merchant reading a refusal will reach for the
    remedy he knows — restore a backup — and here that would overwrite good data to
    cure a packaging fault, and fail identically afterwards. So the message says what
    is wrong with the software, says his data is untouched, and rules the backup out by
    name.
  */
  throw new Error(
    'تعذّر تشغيل الخدمة: ملفات البرنامج المثبّتة غير متطابقة — ملفات تحديث قاعدة البيانات ' +
      'لا تخصّ هذه النسخة من البرنامج. هذه مشكلة في التثبيت وليست في بياناتك. ' +
      'قاعدة بياناتك لم تُفتح ولم تتغيّر. ' +
      '**لا تستعد نسخة احتياطية** — أعد تثبيت البرنامج من ملف التثبيت الكامل، ولا تنسخ ملفات ' +
      'من تثبيت آخر، أو تواصل مع الدعم الفني. التفاصيل التقنية مسجّلة في ملف السجل.',
  );
}

/**
 * Is this installation internally consistent — do the migration files beside the
 * binary match the fingerprint compiled into it?
 *
 * `null` when it cannot be established, which is treated exactly like `false`: not
 * knowing whether the build is sound is not a licence to blame the merchant's data.
 */
function migrationsMatchBuild(): boolean | null {
  let directory: string | null;
  try {
    directory = resolveMigrationsDir();
  } catch {
    return null;
  }
  if (!directory) return null;

  try {
    return computeMigrationsFingerprint(directory) === EXPECTED_MIGRATIONS_FINGERPRINT;
  } catch {
    return null;
  }
}

/**
 * Verifies — and where it is safe, establishes — the identity of the open database.
 *
 * Runs after migrations have been verified, so the schema it hashes is the final one.
 */
export async function verifyDatabaseIdentity(
  options: { client?: PrismaClient; log: Log } = { log: () => {} },
): Promise<IdentityResult> {
  const client = options.client ?? defaultClient;
  const log = options.log;

  const file = await openDatabaseFile(client);
  const schemaHash = await computeSchemaHash(client);
  const identity = await readIdentity(client);
  const enforced = identityEnforced();

  /*
    ── The schema SQLite has, against the schema this binary was built for ──────

    Checked before the identity row and independently of it. A file can carry a
    perfectly valid identity and a migration ledger claiming everything is applied
    while its actual tables are something else — a hand-edited column, a restore of an
    older file whose ledger was doctored, a half-applied migration that was recorded
    anyway. The ledger is a claim; `sqlite_master` is the thing itself.
  */
  if (schemaHash !== EXPECTED_SCHEMA_HASH) {
    log('database schema does not match the build', {
      file,
      expected: EXPECTED_SCHEMA_HASH,
      actual: schemaHash,
    });

    if (enforced) {
      /*
        ── Two causes, opposite remedies, and only one of them is his ───────────

        The hashes disagreeing means one of two things, and telling them apart is the
        whole value of the message:

          **The database is foreign.** The build is internally consistent — the
          migration files beside the binary are the ones it was compiled against — so
          the thing that does not belong is the file. His data is the problem, and
          restoring a backup is the remedy.

          **The BUILD is stale.** Someone added a migration and shipped without
          regenerating the constants, or a runtime directory was assembled from two
          different releases. His database is very probably perfect. Telling him to
          restore a backup here would be advising him to overwrite good data to cure a
          packaging mistake — and if he did, the new file would fail the same check,
          because the fault never was in the file.

        The second is not hypothetical: these constants shipped once as placeholders
        that had never been generated, which would have produced exactly this refusal
        against every correct database in the field.

        `assertMigrationsMatchBuild` runs before this and already refuses the stale
        case in production, so this branch is belt to that brace. It is written anyway
        because that check returns early when the migrations directory cannot be found
        — and "I could not verify the build" is precisely when blaming the data is
        least defensible.
      */
      if (migrationsMatchBuild() !== true) {
        log('refusing on a schema mismatch this build cannot vouch for', {
          file,
          expected: EXPECTED_SCHEMA_HASH,
          actual: schemaHash,
          migrationsMatchBuild: migrationsMatchBuild(),
        });

        throw new Error(
          'تعذّر تشغيل الخدمة: نسخة البرنامج المثبّتة غير مكتملة — ملفاتها الداخلية لا تتفق مع بعضها. ' +
            'هذه مشكلة في التثبيت وليست في بياناتك. ' +
            'قاعدة بياناتك لم تُفتح ولم تتغيّر، ولا تحتاج إلى أي إجراء. ' +
            '**لا تستعد نسخة احتياطية ولا تحذف أي ملف** — أعد تثبيت البرنامج من ملف التثبيت الكامل، ' +
            'أو تواصل مع الدعم الفني. التفاصيل التقنية مسجّلة في ملف السجل.',
        );
      }

      throw new Error(
        `تعذّر تشغيل الخدمة: بنية قاعدة البيانات في الملف «${file}» لا تطابق هذه النسخة من البرنامج. ` +
          'المطلوب قاعدة بيانات أنشأها هذا الإصدار أو نسخة احتياطية منه. ' +
          'أوقف الخدمة، واستعد أحدث نسخة احتياطية من شاشة النسخ الاحتياطي، أو تواصل مع الدعم الفني قبل أي خطوة أخرى — ' +
          'لا تحذف أي ملف. التفاصيل التقنية مسجّلة في ملف السجل.',
      );
    }
  }

  if (identity) {
    // A file this installation knows. The only thing left to say is which one it is,
    // so a support call can match the machine to the log without asking anybody to
    // read file dates aloud.
    log('database identity verified', {
      file,
      installationId: identity.installationId,
      createdBy: identity.createdBy,
      createdAt: identity.createdAt,
      schemaMatches: schemaHash === EXPECTED_SCHEMA_HASH,
    });
    return {
      verdict: schemaHash === EXPECTED_SCHEMA_HASH ? 'verified' : 'mismatch-tolerated',
      file,
      identity,
      schemaHash,
      expectedSchemaHash: EXPECTED_SCHEMA_HASH,
    };
  }

  /*
    ── No signature. Two very different files look identical at this point ──────

    One is a database this installation made before identity existed, or one a
    developer's `prisma migrate deploy` just created: nothing in it, nothing to lose.
    The other is a stranger's — the `C:\ProgramData\Walaa` file, or a shop's live
    database dropped in by a well-meaning restore.

    The census tells them apart by the only measure that matters. An empty file is
    adopted and the adoption is written down, in the file and in the log; a file with
    a merchant's rows in it stops the process in production, because there is no
    reading of "start anyway" that ends well.
  */
  const census = await censusBusinessData(client);

  if (census.total === 0) {
    const stamped = await stampIdentity({
      client,
      createdBy: `adopted-empty@${API_VERSION}`,
      adoptedReason: 'no identity row and no business data',
    });
    log('adopted an empty database and recorded this installation on it', {
      file,
      installationId: stamped.installationId,
      counts: census.counts,
    });
    return {
      verdict: 'adopted-empty',
      file,
      identity: stamped,
      schemaHash,
      expectedSchemaHash: EXPECTED_SCHEMA_HASH,
    };
  }

  log('database carries data but no identity from this installation', {
    file,
    counts: census.counts,
    enforced,
  });

  if (enforced) {
    throw new Error(
      `تعذّر تشغيل الخدمة: الملف «${file}» يحتوي بيانات (${census.counts.customer ?? 0} زبون، ` +
        `${census.counts.transaction ?? 0} عملية) ولا يحمل توقيع هذا التثبيت. ` +
        'المطلوب أن يفتح البرنامج قاعدة البيانات التي أنشأها هو. ' +
        'لم يُكتب أي شيء في الملف. أوقف الخدمة وتواصل مع الدعم الفني — قد تكون هذه قاعدة بيانات ' +
        'تخص تثبيتاً آخر، وحذفها أو الكتابة فوقها يفقد بياناتها. التفاصيل التقنية مسجّلة في ملف السجل.',
    );
  }

  const stamped = await stampIdentity({
    client,
    createdBy: `adopted-existing@${API_VERSION}`,
    adoptedReason: `no identity row; ${census.total} business row(s) present`,
  });
  log('adopted an existing database OUTSIDE production and recorded the adoption', {
    file: basename(file),
    installationId: stamped.installationId,
  });

  return {
    verdict: 'mismatch-tolerated',
    file,
    identity: stamped,
    schemaHash,
    expectedSchemaHash: EXPECTED_SCHEMA_HASH,
  };
}
