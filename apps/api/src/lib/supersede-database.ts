import { existsSync, renameSync, statSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { API_VERSION } from '../config/version';
import { loadEnv } from '../config/env';
import { EXPECTED_SCHEMA_HASH } from '../config/schema-fingerprint';
import { liveDatabasePath } from '../config/paths';
import { computeSchemaHash, identityEnforced, readIdentity } from './db-identity';
import { installDatabaseTemplateIfAbsent } from './migrate';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AN EMPTY DATABASE FROM A DIFFERENT BUILD IS NOT A DEAD END
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── The failure this closes ──────────────────────────────────────────────────
 *
 * A merchant installed 0.2.1 onto a machine that had had an earlier build on it. The
 * data directory still held that build's `loyalty-pro.db`, and the installer had — correctly
 * — not touched it: an installer that overwrites a data directory is an installer that
 * can destroy a shop's customer list.
 *
 * So the service opened a database whose shape was not the one this binary was compiled
 * for, and refused to start with:
 *
 *   «بنية قاعدة البيانات … لا تطابق هذه النسخة من البرنامج. أوقف الخدمة، واستعد أحدث
 *    نسخة احتياطية من شاشة النسخ الاحتياطي»
 *
 * Restore the latest backup — of an installation that had never run, from a screen
 * behind a login that could not be reached, on a machine with no backups on it. And the
 * neighbouring refusal in the same module said «أعد تثبيت البرنامج من ملف التثبيت
 * الكامل», which cannot resolve it either: reinstalling replaces the program and never
 * touches the data directory, so the same file is there afterwards and the same refusal
 * follows.
 *
 * Both sentences were true statements that sent the reader somewhere useless.
 *
 * ── What the file actually was ───────────────────────────────────────────────
 *
 * **Empty.** No merchant, no branch, no customer, no invoice — the residue of an
 * earlier install that had never been set up. There was nothing to protect, and
 * nothing in the startup path ever asked. The refusal was written for the case that
 * matters (a shop's live ledger opened by the wrong build) and applied to the case that
 * does not.
 *
 * So: ask. A file with rows in it still stops the process, because there is no reading
 * of "start anyway" that ends well. A file with nothing in it is moved aside, the
 * shipped template is installed in its place, and the merchant sees the setup screen —
 * which is what he was entitled to see on a machine with no shop on it.
 *
 * ── Where this refuses to act, and why each ──────────────────────────────────
 *
 * - **When the build cannot vouch for itself.** If the migrations beside the binary
 *   are not the ones it was compiled with, the thing that does not match may be the
 *   PROGRAM, and replacing the merchant's file to cure a packaging fault would be
 *   destroying data to fix something that was never in the data.
 * - **When anything in the file cannot be counted.** Not "assume zero" — the opposite.
 *   A table that will not answer is a file this process does not understand, and a file
 *   it does not understand is one it may not throw away.
 * - **Outside production**, where a developer's database legitimately changes shape
 *   between branches and the existing checks already report without stopping.
 * - **In a demo build**, which has its own provenance guard and its own reset.
 *
 * ── Nothing is deleted, ever ─────────────────────────────────────────────────
 *
 * The file is RENAMED, beside itself, with a timestamp. If this judgement is ever
 * wrong the bytes are still on the disk and a support call can put them back. A
 * function that decides a database is expendable should not also be the function that
 * makes that decision irreversible.
 */

/** Bookkeeping this product writes, which says nothing about whether a shop is in here. */
const NON_BUSINESS_TABLES = new Set(['_prisma_migrations', 'db_identity', 'demo_provenance']);

export interface DatabaseCensus {
  /** Every user table found, with its row count. */
  counts: Record<string, number>;
  /** Rows across all of them. */
  total: number;
  /**
   * Whether every table in the file answered.
   *
   * `false` means this process could not establish what is in here — a corrupt page, a
   * lock, a shape it does not understand. It is treated exactly like "holds data".
   */
  readable: boolean;
}

/**
 * What is in this file, asked of every table it actually has.
 *
 * ── Why not `censusBusinessData` ─────────────────────────────────────────────
 *
 * That one counts five tables by name and catches per-table failures as zero, with the
 * comment "a database too broken to answer is not one holding data worth protecting".
 * That reasoning is backwards for a check whose output authorises moving a file aside:
 * a table that will not answer is exactly when you know least, and "I could not read it
 * therefore it was empty" is how a census becomes a proxy for a census.
 *
 * It also cannot see a table it does not know the name of — which is the whole
 * situation here, since the file in question came from a DIFFERENT build. A shop's
 * invoices sitting in a table this release renamed would have counted as zero.
 */
export async function censusEveryTable(client: PrismaClient): Promise<DatabaseCensus> {
  const counts: Record<string, number> = {};

  let tables: Array<{ name: string }>;
  try {
    tables = await client.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    );
  } catch {
    // The file would not even list its tables. Nothing about it is established.
    return { counts, total: 0, readable: false };
  }

  for (const { name } of tables) {
    if (NON_BUSINESS_TABLES.has(name)) continue;
    try {
      const rows = await client.$queryRawUnsafe<Array<{ n: unknown }>>(
        `SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`,
      );
      counts[name] = Number(rows[0]?.n ?? 0);
    } catch {
      return { counts, total: Object.values(counts).reduce((a, b) => a + b, 0), readable: false };
    }
  }

  return { counts, total: Object.values(counts).reduce((a, b) => a + b, 0), readable: true };
}

export type SupersedeVerdict =
  | 'not-applicable'
  | 'usable'
  | 'superseded'
  | 'holds-data'
  | 'unreadable'
  | 'rename-failed';

export interface SupersedeResult {
  verdict: SupersedeVerdict;
  /** Where the old file was moved to, when it was. */
  parkedAt?: string;
  census?: DatabaseCensus;
  /** The version that created it, when the file says. */
  createdBy?: string;
}

type Log = (message: string, extra?: Record<string, unknown>) => void;

/**
 * Moves an unusable but EMPTY database aside and installs the shipped template.
 *
 * Runs on its own short-lived connection, before anything else opens the database,
 * because the file cannot be renamed on Windows while a handle is held on it.
 *
 * Returns without acting in every case it is not certain about — see the header. The
 * caller does not branch on the result; the checks that follow will refuse on their own
 * if this declined, and they are the ones that produce the merchant's sentence.
 */
export async function supersedeUnusableDatabase(
  log: Log,
  options: { buildIsSound: boolean; demo: boolean },
): Promise<SupersedeResult> {
  if (!identityEnforced()) return { verdict: 'not-applicable' };

  if (options.demo) {
    // A demo build has `demo_provenance` and its own reset; it must not take a second,
    // differently-reasoned path over the same file.
    return { verdict: 'not-applicable' };
  }

  if (!options.buildIsSound) {
    /*
      The migrations beside this binary are not the ones it was built with, so a schema
      that disagrees may be disagreeing with a BROKEN BUILD. Replacing the merchant's
      file here would destroy data to cure a packaging fault — and fail identically
      afterwards, because the fault was never in the file.
    */
    log('not superseding: this build cannot vouch for its own migration set', {});
    return { verdict: 'not-applicable' };
  }

  const databasePath = liveDatabasePath(loadEnv().DATABASE_URL);
  if (!databasePath || !existsSync(databasePath) || statSync(databasePath).size === 0) {
    return { verdict: 'not-applicable' };
  }

  const client = new PrismaClient({ datasourceUrl: `file:${databasePath}` });
  let census: DatabaseCensus;
  let schemaHash: string;
  let createdBy: string | undefined;

  try {
    schemaHash = await computeSchemaHash(client);
    if (schemaHash === EXPECTED_SCHEMA_HASH) {
      // The shape is right. Whatever else is true of this file is for the identity
      // check to decide, and it has an answer for every branch that gets there.
      return { verdict: 'usable' };
    }

    census = await censusEveryTable(client);
    createdBy = (await readIdentity(client))?.productVersion;
  } catch (error) {
    log('could not examine the existing database before starting', {
      err: error instanceof Error ? error.message : String(error),
    });
    return { verdict: 'unreadable' };
  } finally {
    /*
      Unconditionally, and before any rename. Prisma holds the file open for the life
      of the client, and Windows refuses to rename an open file — so a `$disconnect`
      that only happened on the success path would turn every failure here into a
      second, unrelated failure about a busy file.
    */
    await client.$disconnect();
  }

  if (!census.readable) {
    log('not superseding: the existing database would not answer for all of its tables', {
      counted: census.counts,
    });
    return { verdict: 'unreadable', census };
  }

  if (census.total > 0) {
    log('not superseding: the existing database holds records', {
      counts: census.counts,
      total: census.total,
      createdBy: createdBy ?? '(no identity row)',
    });
    return { verdict: 'holds-data', census, createdBy };
  }

  /* Empty, readable, and the wrong shape for this build. Nothing to lose. */

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const parkedAt = `${databasePath}.superseded-${stamp}`;

  try {
    renameSync(databasePath, parkedAt);
    // The sidecars belong to the file that has just moved. Leaving them beside the new
    // database would hand SQLite a write-ahead log written against a different schema.
    for (const suffix of ['-wal', '-shm'] as const) {
      const sidecar = `${databasePath}${suffix}`;
      if (existsSync(sidecar)) renameSync(sidecar, `${parkedAt}${suffix}`);
    }
  } catch (error) {
    /*
      Almost always a handle still open on it — another copy of the service, or a
      backup tool. Declining is the whole answer: the identity check runs next and
      refuses with a sentence, which is the correct outcome for a machine where
      something else is holding the shop's database.
    */
    log('could not move the superseded database aside', {
      err: error instanceof Error ? error.message : String(error),
    });
    return { verdict: 'rename-failed', census };
  }

  const installed = installDatabaseTemplateIfAbsent(log);

  log('replaced an empty database from another build with this build’s template', {
    parkedAt,
    createdBy: createdBy ?? '(no identity row)',
    schemaHash,
    expectedSchemaHash: EXPECTED_SCHEMA_HASH,
    tablesFound: Object.keys(census.counts).length,
    templateInstalled: installed.installed,
    installedBy: API_VERSION,
  });

  return { verdict: 'superseded', parkedAt, census, createdBy };
}
