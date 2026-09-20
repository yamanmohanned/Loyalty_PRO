import { PrismaClient } from '@prisma/client';
import type { StorageFailureCause } from '@loyalty-pro/shared-types';
import { loadEnv } from '../config/env';

/**
 * One PrismaClient for the process. Creating more than one exhausts the
 * connection pool under load, and in dev the watcher would leak a client per reload.
 */

const env = loadEnv();

declare global {
  var __walaaPrisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  globalThis.__walaaPrisma ??
  new PrismaClient({
    log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (env.NODE_ENV !== 'production') globalThis.__walaaPrisma = prisma;

/**
 * SQLite connection settings the v3 concurrency decision depends on (§12.5).
 *
 * `journal_mode = WAL` is the important one. SQLite's default (`delete`) takes a
 * whole-database lock for every write, so a dashboard read blocks behind an agent
 * ingestion and vice versa. WAL lets readers proceed concurrently with the single
 * writer, which is precisely the shape of traffic here: many readers, one API
 * service writing.
 *
 * WAL is persisted in the database file header, so it survives restarts — but a
 * freshly created file starts in `delete` mode, so this must run on every
 * bootstrap path (server, seed, tests) or a new install silently gets the slow,
 * lock-prone behaviour.
 *
 * `busy_timeout` gives a blocked writer five seconds to wait rather than failing
 * immediately, and `foreign_keys` is off by default in SQLite — without it the
 * relations declared in the schema would not actually be enforced.
 */
export async function applySqlitePragmas(client: PrismaClient = prisma): Promise<void> {
  // `$queryRawUnsafe`, not `$executeRawUnsafe`: several PRAGMAs return a row
  // (journal_mode answers with the mode it settled on), and Prisma rejects a
  // result set from an execute call.
  await client.$queryRawUnsafe('PRAGMA journal_mode = WAL');
  await client.$queryRawUnsafe('PRAGMA busy_timeout = 5000');
  await client.$queryRawUnsafe('PRAGMA foreign_keys = ON');
  // NORMAL is the recommended durability setting under WAL: it survives an
  // application crash, trading only a power-loss window that a UPS or the
  // mandatory backups (§7.3) already cover.
  await client.$queryRawUnsafe('PRAGMA synchronous = NORMAL');
  await client.$queryRawUnsafe(`PRAGMA wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`);
}

/**
 * What SQLite actually settled on, read back rather than assumed.
 *
 * ── Why this is worth a round trip at boot ───────────────────────────────────
 *
 * Every claim this system makes about behaving correctly when two people press the
 * same button at once rests on these five values. `journal_mode` decides whether a
 * reader blocks a writer at all; `busy_timeout` decides whether contention becomes a
 * failed sale or a short wait; `foreign_keys` decides whether the relations in the
 * schema are enforced or decorative.
 *
 * Setting them is not the same as having them. `journal_mode = WAL` is refused on
 * some filesystems and silently stays `delete`; `foreign_keys` is reset to off by
 * anything that opens a fresh connection without this function; a pooled connection
 * that missed the setup answers differently from the one that ran it.
 *
 * So they are read back and logged at boot. It also makes a test honest: a concurrency
 * result proves nothing unless the settings it ran under are the settings that ship,
 * and this is how the two are compared rather than assumed to match.
 */
export interface SqliteSettings {
  journal_mode: string;
  busy_timeout: number;
  foreign_keys: number;
  synchronous: number;
  wal_autocheckpoint: number;
}

export async function readSqliteSettings(
  client: PrismaClient = prisma,
): Promise<SqliteSettings> {
  const one = async (pragma: string): Promise<unknown> => {
    const rows = await client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `PRAGMA ${pragma}`,
    );
    return Object.values(rows[0] ?? {})[0];
  };

  return {
    journal_mode: String(await one('journal_mode')),
    busy_timeout: Number(await one('busy_timeout')),
    foreign_keys: Number(await one('foreign_keys')),
    synchronous: Number(await one('synchronous')),
    wal_autocheckpoint: Number(await one('wal_autocheckpoint')),
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE WAL SIZE, SET FROM ARITHMETIC RATHER THAN LEFT TO A DEFAULT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * **What was observed.** The development database was 385 KB with a 2.38 MB `-wal`
 * beside it — a write-ahead log six times the size of the database it belongs to,
 * which reads like a checkpoint that never ran.
 *
 * **What it actually was.** 2,434,952 bytes is the 32-byte WAL header plus exactly
 * 591 frames of (4096-byte page + 24-byte frame header). SQLite's default
 * `wal_autocheckpoint` is **1000 frames**, so the file was 409 frames short of the
 * threshold that would have checkpointed it. Nothing had gone wrong. The default is
 * expressed in *pages*, and is therefore not proportional to the database at all: on
 * a small database the WAL is allowed to reach ~3.93 MiB no matter how little is in
 * the main file, and on a 500 MB database the same 3.93 MiB is a rounding error.
 *
 * **Why not simply leave it.** Three costs scale with the WAL's ceiling, and none of
 * them is paid for by a bigger one at this write volume:
 *
 *   - a crash replays the whole WAL on the next open;
 *   - anything that copies `loyalty-pro.db` without its sidecar is behind by up to the
 *     WAL's size (the §12.17 loss — `backup/snapshot.ts` avoids it with
 *     `VACUUM INTO`, but the ceiling is the size of the hole for anything that does
 *     not);
 *   - the sidecar is that much of the volume §12.15 is about.
 *
 * **What a checkpoint costs, measured.** Against a 5.4 MB database carrying a
 * 636-frame (2.6 MB) WAL: `wal_checkpoint(PASSIVE)` **21.5 ms** to fold every frame
 * back, then `wal_checkpoint(TRUNCATE)` **0.8 ms** with nothing left to do. A shop
 * writing a few dozen page-images per sale crosses 512 frames a handful of times a
 * day, so this buys a ~2.0 MiB ceiling for tens of milliseconds a day.
 *
 * 512 rather than something smaller because the WAL's entire purpose is to let
 * readers proceed while the single writer works; checkpointing on every few writes
 * would spend the property being paid for.
 */
export const WAL_AUTOCHECKPOINT_PAGES = 512;

/**
 * Folds the WAL back into the database and truncates it to nothing.
 *
 * Called on clean shutdown, so an installation that is stopped by the Service Control
 * Manager, by an upgrade, or by the merchant closing the app leaves one file behind
 * rather than three — and the next start has no log to replay.
 *
 * **Never throws.** It runs while the process is already on its way out, where a
 * blocked checkpoint (`busy`, because something still holds a read) is a fact to
 * record, not a reason to fail a shutdown. The data is committed either way: an
 * un-checkpointed WAL is folded in automatically on the next open.
 */
export async function checkpointWal(
  client: PrismaClient = prisma,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const rows = await client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      'PRAGMA wal_checkpoint(TRUNCATE)',
    );
    const row = rows[0] ?? {};
    const busy = Number(row.busy ?? 0);
    return {
      ok: busy === 0,
      detail: `busy=${String(row.busy ?? '?')} log=${String(row.log ?? '?')} checkpointed=${String(row.checkpointed ?? '?')}`,
    };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Prisma's code for a unique-constraint violation. The idempotency guard fires as this. */
export const PRISMA_UNIQUE_VIOLATION = 'P2002';
/**
 * SQLite reports contention as SQLITE_BUSY rather than a serialization failure.
 * With WAL enabled and the API as the sole writer (docs/legacy/CLAUDE_v3.md §12.5) this should
 * be rare, but a busy timeout plus a retry is the correct handling when it happens.
 */
export const SQLITE_BUSY = 'SQLITE_BUSY';

interface PrismaLikeError {
  code?: unknown;
  meta?: unknown;
}

export function prismaErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as PrismaLikeError).code;
  return typeof code === 'string' ? code : null;
}

export const isUniqueViolation = (error: unknown): boolean =>
  prismaErrorCode(error) === PRISMA_UNIQUE_VIOLATION;

/**
 * Which column a unique violation was actually about.
 *
 * A table with two unique constraints produces the same P2002 for both, and
 * treating them alike turns one failure into the other's error message. Prisma
 * reports the offending field(s) in `meta.target`; on SQLite that arrives as a
 * string like `customer.barcode_token`, so this matches on substring rather than
 * equality and accepts either the column or the field name.
 */
export function uniqueViolationTargets(error: unknown, column: string): boolean {
  if (!isUniqueViolation(error)) return false;
  const meta = (error as PrismaLikeError).meta;
  if (!meta || typeof meta !== 'object') return false;

  const target = (meta as { target?: unknown }).target;
  const haystack = Array.isArray(target) ? target.join(',') : String(target ?? '');
  return haystack.toLowerCase().includes(column.toLowerCase());
}

export const isBusyError = (error: unknown): boolean => {
  if (prismaErrorCode(error) === SQLITE_BUSY) return true;
  return error instanceof Error && error.message.includes('SQLITE_BUSY');
};

/**
 * Signatures of a datastore that could not accept a write for want of storage.
 *
 * Matched on message text, which is not how anything else in this file works and
 * needs the reason stated: Prisma has no dedicated error code for a full disk. It
 * surfaces the driver's message, so the driver's words are the only thing to match.
 *
 * **The Station's honest-failure behaviour does not depend on this list being
 * complete.** A storage failure that slips through is still a 5xx, and the Station
 * treats any failed write as unsaved (§12.16). Matching only sharpens the wording
 * and the server-side log; missing a signature costs precision, not safety.
 */
const STORAGE_FAILURE_SIGNATURES: Readonly<Record<StorageFailureCause, readonly string[]>> = {
  DISK_FULL: ['SQLITE_FULL', 'database or disk is full', 'ENOSPC', 'no space left on device'],
  // SQLite reports a database it cannot write to — including one whose WAL cannot be
  // extended — as readonly. A permissions fault produces the same words. The words
  // alone therefore cannot tell a full disk from a locked-down file; the error handler
  // settles it with the measured free space, which can.
  READ_ONLY: ['attempt to write a readonly database', 'SQLITE_READONLY'],
  IO_ERROR: ['SQLITE_IOERR', 'disk I/O error'],
};

/** Most specific first: a message naming both a full disk and an I/O error is a full disk. */
const CAUSE_PRECEDENCE: readonly StorageFailureCause[] = ['DISK_FULL', 'READ_ONLY', 'IO_ERROR'];

/** The driver's message and code, lowercased, or null for something that is not an error. */
function errorHaystack(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  return [
    error instanceof Error ? error.message : '',
    String((error as { code?: unknown }).code ?? ''),
  ]
    .join(' ')
    .toLowerCase();
}

/** Why the datastore could not store a write, by the driver's own words — or null. */
export function storageFailureCause(error: unknown): StorageFailureCause | null {
  const haystack = errorHaystack(error);
  if (!haystack) return null;
  return (
    CAUSE_PRECEDENCE.find((cause) =>
      STORAGE_FAILURE_SIGNATURES[cause].some((signature) =>
        haystack.includes(signature.toLowerCase()),
      ),
    ) ?? null
  );
}

/** True when a write failed because the datastore could not store it (§12.15). */
export function isStorageFailure(error: unknown): boolean {
  return storageFailureCause(error) !== null;
}

/**
 * The database file itself is damaged.
 *
 * Distinct from a storage failure: the disk has room and accepts writes, and the file
 * on it no longer parses. Retrying does nothing; restoring a backup does.
 */
const DAMAGE_SIGNATURES = [
  'SQLITE_CORRUPT',
  'database disk image is malformed',
  'SQLITE_NOTADB',
  'file is not a database',
];

export function isDatabaseDamaged(error: unknown): boolean {
  const haystack = errorHaystack(error);
  return haystack !== null && DAMAGE_SIGNATURES.some((s) => haystack.includes(s.toLowerCase()));
}
