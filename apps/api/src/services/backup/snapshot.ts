import { statfsSync } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { sqlitePathFromUrl } from '../../config/paths';

/**
 * Taking a consistent copy of a live SQLite database (CLAUDE_v3.md §12.17).
 *
 * ## `VACUUM INTO`, and why it settles the WAL question rather than answering it
 *
 * §12.17 states the trap: the database runs in WAL mode, so the most recent
 * transactions live in `walaa.db-wal` until a checkpoint folds them in, and copying
 * `walaa.db` alone silently restores to an older day.
 *
 * The obvious fix — `PRAGMA wal_checkpoint(TRUNCATE)` and then copy the file — is not
 * actually a fix. It leaves a race: a sale committed between the checkpoint and the copy
 * lands in a new WAL that the copy does not include, and the result is the same silent
 * loss with a smaller window. A shop is busiest exactly when a scheduled backup runs.
 *
 * `VACUUM INTO` is one statement. SQLite takes a read transaction, so the destination is
 * a complete, self-contained database at a single consistent point in time, WAL contents
 * included, with no sidecar of its own. There is no window to race, and nothing for a
 * future maintainer to forget to copy. **The WAL question disappears rather than being
 * managed**, which is the property worth having: §12.17's failure is one nobody notices
 * until they need the backup.
 *
 * It also defragments, so the snapshot is usually smaller than the live file.
 *
 * ## Free space, and why refusing here is right when refusing a sale is not
 *
 * §12.16 forbids refusing a write because storage is low: the discount is already given
 * at the register, so refusing records nothing and manufactures a discrepancy.
 *
 * A backup is the opposite case and the reasoning inverts cleanly. The data is already
 * safe in the live database; declining to copy it loses nothing. Meanwhile a backup is
 * one of the few operations here that can *itself* fill the disk — `VACUUM INTO` writes
 * a second copy of the database, and the archive is a third artefact on top. Running one
 * with no headroom is how a merchant turns "backups have not run lately" into "the till
 * stopped taking sales". So this refuses, loudly, and the live system carries on.
 */

/**
 * Multiple of the database size that must be free before a snapshot is attempted.
 *
 * The snapshot is roughly one database, the compressed archive is much less, and the
 * remainder is margin for the shop continuing to trade while the backup runs. Deliberately
 * generous: the cost of refusing is a log line, and the cost of being wrong is §12.15.
 */
const REQUIRED_FREE_MULTIPLE = 3;

/**
 * Floor beneath which no backup runs regardless of database size.
 *
 * A 20 MB database on a volume with 200 MB left passes a purely proportional check and
 * still leaves the machine one Windows update away from the outage §12.15 describes.
 * This is the CRITICAL threshold from §12.15, used as an absolute gate.
 */
const MINIMUM_FREE_BYTES = 2 * 1024 * 1024 * 1024;

export interface FreeSpace {
  freeBytes: number;
  requiredBytes: number;
  databaseBytes: number;
}

export class InsufficientSpaceError extends Error {
  constructor(readonly space: FreeSpace) {
    super(
      `لا توجد مساحة كافية لأخذ نسخة احتياطية: ${gib(space.freeBytes)} متاحة، ` +
        `والمطلوب ${gib(space.requiredBytes)}`,
    );
    this.name = 'InsufficientSpaceError';
  }
}

const gib = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(2)} GB`;

/**
 * Absolute path to the live SQLite file, or null when the datasource is not a file.
 *
 * The installed service is always handed an absolute path by the service host (§12.11),
 * so the relative branch is development and tests — where Prisma resolves a relative
 * `file:` URL from the schema directory rather than from the working directory. Getting
 * that wrong would look like a missing database rather than a misresolved path.
 */
export function liveDatabasePath(databaseUrl: string): string | null {
  const raw = sqlitePathFromUrl(databaseUrl);
  if (!raw) return null;
  return isAbsolute(raw) ? raw : resolve(process.cwd(), 'prisma', raw);
}

/**
 * Checks that a snapshot has somewhere to go.
 *
 * `statfsSync` reports the filesystem holding `path`, so a backup targeted at a second
 * drive is measured against that drive rather than against `C:` — which matters, because
 * the USB copy §7.3 requires is precisely a different volume.
 */
export function checkFreeSpace(databaseBytes: number, path: string): FreeSpace {
  const stats = statfsSync(path);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  const requiredBytes = Math.max(databaseBytes * REQUIRED_FREE_MULTIPLE, MINIMUM_FREE_BYTES);
  return { freeBytes, requiredBytes, databaseBytes };
}

export interface SnapshotResult {
  path: string;
  bytes: number;
  space: FreeSpace;
}

/**
 * Writes a consistent snapshot of the live database to `destinationPath`.
 *
 * @throws InsufficientSpaceError before touching the disk, when there is not enough room.
 */
export async function takeSnapshot(
  databaseUrl: string,
  destinationPath: string,
  client: PrismaClient = prisma,
): Promise<SnapshotResult> {
  const livePath = liveDatabasePath(databaseUrl);
  if (!livePath) {
    throw new Error('النسخ الاحتياطي مدعوم فقط لقاعدة بيانات SQLite محلية');
  }

  const { size: databaseBytes } = await stat(livePath);
  const space = checkFreeSpace(databaseBytes, dirname(destinationPath));
  if (space.freeBytes < space.requiredBytes) {
    throw new InsufficientSpaceError(space);
  }

  // VACUUM INTO refuses to overwrite, which is a safety feature everywhere except a
  // retry after a crash mid-backup. Clearing a stale temporary file is this caller's
  // job; the destination is one it owns and named.
  await rm(destinationPath, { force: true });

  // SQLite string literals do not treat backslash as an escape, so a Windows path needs
  // no conversion — only an embedded single quote has to be doubled. Parameter binding
  // is not available here: VACUUM INTO takes a literal, not a bound value.
  await client.$queryRawUnsafe(`VACUUM INTO '${destinationPath.replace(/'/g, "''")}'`);

  const { size: bytes } = await stat(destinationPath);
  return { path: destinationPath, bytes, space };
}
