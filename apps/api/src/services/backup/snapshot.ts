import { rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { liveDatabasePath } from '../../config/paths';
import { readFreeSpace } from '../storage.service';

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
 * ── Recalibrated after it took a shop down (2026-09-06) ─────────────────────
 *
 * This used to be `CRITICAL_FREE_BYTES` — 2 GiB — on the argument below that the
 * number raising the manager's banner and the number refusing a backup should be one
 * number. That argument is about **coherent reporting**. It is not a statement about
 * how much room copying a database needs, and using it as one turned a guard into an
 * outage:
 *
 *   a 5.4 MB database, 1.09 GB free, and the API refused to start — forever, on a
 *   30-second retry loop — because a pre-migration snapshot of 5.4 MB was judged to
 *   need 2 GB. The disk had two hundred times the room the copy required.
 *
 * Worse, this ran at BOOT: `ensureDatabaseReady` snapshots before migrating, so the
 * refusal was not "your scheduled backup was skipped", it was "the product does not
 * start". A guard whose failure mode is a dead till is not protecting the till.
 *
 * So the two numbers are now separate, and each says what it is for:
 *
 *   - `CRITICAL_FREE_BYTES` (2 GiB) still raises the banner. It answers "is this
 *     machine in trouble?", and that question has nothing to do with file sizes.
 *   - `MINIMUM_FREE_BYTES` (256 MiB) answers "is there room to write this copy?".
 *     Above the proportional requirement for any database under ~85 MB, and enough
 *     that the copy cannot itself be what fills the volume.
 *
 * The proportional part is unchanged and still does the real work: a large database
 * is still required to have three times its own size free.
 *
 * A 20 MB database on a volume with 200 MB left passes a purely proportional check and
 * still leaves the machine close to the outage §12.15 describes — which is why a floor
 * exists at all. It is a floor for *this operation*, not a verdict on the machine; the
 * verdict is the banner, and it fires independently at 2 GiB.
 */
const MINIMUM_FREE_BYTES = 256 * 1024 * 1024;

export interface FreeSpace {
  freeBytes: number;
  requiredBytes: number;
  databaseBytes: number;
}

export class InsufficientSpaceError extends Error {
  constructor(readonly space: FreeSpace) {
    super(
      `لا توجد مساحة كافية لأخذ نسخة احتياطية: ${gib(space.freeBytes)} متاحة، ` +
        `والمطلوب ${gib(space.requiredBytes)} ` +
        // The database size and the multiple, in the message itself. The original said
        // only "2.00 GB required" against a 5 MB database, and the number looked
        // arbitrary because nothing on screen connected it to anything.
        `(حجم قاعدة البيانات ${gib(space.databaseBytes)} × ${REQUIRED_FREE_MULTIPLE}، ` +
        `بحدٍّ أدنى ${gib(MINIMUM_FREE_BYTES)})`,
    );
    this.name = 'InsufficientSpaceError';
  }
}

const gib = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(2)} GB`;

/**
 * Checks that a snapshot has somewhere to go.
 *
 * `readFreeSpace` reports the filesystem holding `path`, so a backup targeted at a second
 * drive is measured against that drive rather than against the system drive — which
 * matters, because the USB copy §7.3 requires is precisely a different volume.
 */
export function checkFreeSpace(databaseBytes: number, path: string): FreeSpace {
  const { freeBytes } = readFreeSpace(path);
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
