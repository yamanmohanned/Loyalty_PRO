import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { loadEnv } from '../../config/env';
import { resolveDataDir } from '../../config/paths';
import { AppError, backupBlocked } from '../../lib/errors';
import { AUDIT_ACTIONS, recordAudit } from '../audit.service';
import { readArchive, writeArchive, type ArchiveHeader } from './archive';
import {
  archiveName,
  LocalDirectoryDestination,
  type BackupDestination,
  type StoredBackup,
} from './destinations';
import { driveCredentials, GoogleDriveDestination } from './drive';
import { assertBackupsEnabled } from './key-ceremony.service';
import { keyFingerprint, parseBackupKey } from './key';
import { InsufficientSpaceError, takeSnapshot } from './snapshot';

/**
 * Backup, restore, and the verification that makes either worth having
 * (CLAUDE_v3.md §7.3, §12.17).
 *
 * §5.1 accepted a real risk when it put all storage on one machine: a disk failure, a
 * theft or ransomware loses everything. §7.3 is the mitigation and calls it mandatory,
 * with a line that governs the design of this file — **"an untested backup is not a
 * backup — this is the most commonly skipped step and the most costly."**
 *
 * A step gets skipped when it is a procedure. So the monthly restore test is not
 * documentation here; it is `verifyRestore()`, one call, which takes a real backup,
 * pushes it to the real destinations, pulls it back down, restores it, and proves a
 * transaction written moments earlier survived the trip. What a merchant has to do
 * monthly is press a button and read a date.
 */

export interface DestinationOutcome {
  kind: string;
  label: string;
  ok: boolean;
  /** Identifier at the destination, when it succeeded. */
  id?: string;
  /** Why it did not, when it did not. Safe to show an operator. */
  error?: string;
  /** Archives removed by retention. */
  pruned?: string[];
}

export interface BackupRun {
  startedAt: string;
  finishedAt: string;
  name: string;
  header: ArchiveHeader;
  snapshotBytes: number;
  archiveBytes: number;
  destinations: DestinationOutcome[];
  /** True when at least one destination holds the archive. */
  ok: boolean;
}

export interface BackupContext {
  merchantId: string;
  /** Null for a scheduled run with no human behind it. */
  actorUserId: string | null;
}

/** The configured key. Throws when backup is not set up, which callers check first. */
function requireKey(): Buffer {
  const key = parseBackupKey(loadEnv().BACKUP_KEY);
  if (!key) throw new Error('لم يتم إعداد مفتاح التشفير للنسخ الاحتياطي');
  return key;
}

/** The fingerprint of the configured key, for the operator to match against an archive. */
export function configuredKeyFingerprint(): string | null {
  const key = parseBackupKey(loadEnv().BACKUP_KEY);
  return key ? keyFingerprint(key) : null;
}

export function localBackupDirectory(): string {
  return loadEnv().BACKUP_LOCAL_DIR ?? join(resolveDataDir(), 'backups');
}

/**
 * The configured destinations, in the order §7.3 lists them.
 *
 * Drive registers only when its credentials exist — a Google Cloud project and OAuth
 * client are a one-time human setup (§7.3), not something this code can conjure. When
 * they are absent the destination is simply not in the list, so the Backup screen shows
 * no off-machine copy rather than a placeholder implying one.
 */
export function resolveDestinations(): BackupDestination[] {
  const env = loadEnv();
  const destinations: BackupDestination[] = [
    new LocalDirectoryDestination('local', localBackupDirectory(), 'نسخة محلية'),
  ];

  if (env.BACKUP_USB_DIR) {
    destinations.push(new LocalDirectoryDestination('usb', env.BACKUP_USB_DIR, 'قرص خارجي'));
  }

  const credentials = driveCredentials(env);
  if (credentials) {
    destinations.push(new GoogleDriveDestination(credentials));
  }

  return destinations;
}

/**
 * The one-backup-at-a-time lock.
 *
 * Two backups running together share a staging directory, a snapshot filename and a
 * `VACUUM INTO` destination — the second would delete the first's snapshot out from
 * under it and both would produce nonsense. The realistic collision is not two managers
 * clicking at once; it is the nightly scheduled run starting while somebody is part-way
 * through a manual one, or through a restore verification.
 *
 * In-process, which is sufficient and will stop being sufficient if this ever runs as
 * more than one instance — the same caveat as the rate limiter (§12.9). A single Windows
 * Service on the manager PC is the deployment (§12.3), and both the scheduler and the
 * HTTP route live inside it, so one lock covers every caller there is.
 */
let inFlight: Promise<unknown> | null = null;

/** Whether a backup or verification is running right now. */
export const isBackupRunning = (): boolean => inFlight !== null;

async function withBackupLock<T>(operation: () => Promise<T>): Promise<T> {
  if (inFlight) {
    throw backupBlocked('هناك نسخة احتياطية قيد التنفيذ بالفعل');
  }

  const task = operation();
  inFlight = task;
  try {
    return await task;
  } finally {
    inFlight = null;
  }
}

/** Scratch space for the snapshot and the archive being built. */
function stagingDirectory(): string {
  return join(localBackupDirectory(), '.staging');
}

/**
 * Creates the staging directory, or fails with something a manager can act on.
 *
 * Found by running this against the live API: unelevated, the backup directory defaults
 * under `%PROGRAMDATA%\Walaa`, which the installer locks to SYSTEM and Administrators,
 * so `mkdir` returns EPERM. The packaged service runs as LocalSystem and does not hit it
 * — but a misconfigured `BACKUP_LOCAL_DIR`, a USB path that vanished, or a full disk all
 * land here too, and every one of them was answering "حدث خطأ غير متوقع".
 *
 * A backup that cannot start is not a bug the manager should be asked to shrug at. It is
 * §7.3's mandatory safeguard not running, and it names the directory so somebody can fix
 * it.
 */
async function prepareStaging(): Promise<string> {
  const staging = stagingDirectory();
  try {
    await mkdir(staging, { recursive: true });
    return staging;
  } catch (error) {
    const code = (error as { code?: string }).code;
    throw new AppError(
      'STORAGE_UNAVAILABLE',
      `تعذّر تجهيز مجلد النسخ الاحتياطي (${code ?? 'خطأ'}): ${staging}`,
      { cause: error },
    );
  }
}

/**
 * Takes a backup and pushes it to every configured destination.
 *
 * **A destination that fails does not fail the run.** §7.3's 3-2-1 means partial success
 * is the ordinary case: the USB stick is out of the machine most of the day and the
 * internet drops for an hour. Each destination reports for itself, and `ok` asks the
 * only question that matters — does at least one copy of this archive exist somewhere.
 */
export async function runBackup(
  context: BackupContext,
  destinations: BackupDestination[] = resolveDestinations(),
  now: Date = new Date(),
): Promise<BackupRun> {
  return withBackupLock(() => runBackupUnlocked(context, destinations, now));
}

/** The body of a backup, assuming the caller holds the lock. */
async function runBackupUnlocked(
  context: BackupContext,
  destinations: BackupDestination[],
  now: Date,
): Promise<BackupRun> {
  // The ceremony gate (§12.19). An archive encrypted with a key nobody has recorded off
  // this machine is not a backup, and producing one while reporting success is exactly
  // the deception the ceremony exists to prevent. Checked before any work, so a refusal
  // costs nothing and cannot half-write anything.
  await assertBackupsEnabled(context.merchantId);

  const env = loadEnv();
  const key = requireKey();
  const startedAt = now.toISOString();

  const staging = await prepareStaging();

  const name = archiveName(now);
  const snapshotPath = join(staging, 'snapshot.db');
  const archivePath = join(staging, name);

  try {
    const snapshot = await takeSnapshot(env.DATABASE_URL, snapshotPath);
    const { header, archiveBytes } = await writeArchive(snapshotPath, archivePath, key, now);

    // The snapshot is the largest artefact and is of no further use once encrypted.
    // Removed here rather than in the `finally` so the disk is clear before the copies
    // begin — on a machine §12.15 is about, that ordering is not fussiness.
    await rm(snapshotPath, { force: true });

    const outcomes: DestinationOutcome[] = [];
    for (const destination of destinations) {
      try {
        if (!(await destination.isAvailable())) {
          outcomes.push({
            kind: destination.kind,
            label: destination.label,
            ok: false,
            error: 'غير متاح حالياً',
          });
          continue;
        }

        const stored = await destination.put(archivePath, name);
        const pruned = await destination.prune(env.BACKUP_KEEP);
        outcomes.push({
          kind: destination.kind,
          label: destination.label,
          ok: true,
          id: stored.id,
          pruned,
        });
      } catch (error) {
        outcomes.push({
          kind: destination.kind,
          label: destination.label,
          ok: false,
          error: error instanceof Error ? error.message : 'فشل غير معروف',
        });
      }
    }

    const run: BackupRun = {
      startedAt,
      finishedAt: new Date().toISOString(),
      name,
      header,
      snapshotBytes: snapshot.bytes,
      archiveBytes,
      destinations: outcomes,
      ok: outcomes.some((o) => o.ok),
    };

    await recordAudit({
      merchantId: context.merchantId,
      actorUserId: context.actorUserId,
      action: run.ok ? AUDIT_ACTIONS.BACKUP_COMPLETED : AUDIT_ACTIONS.BACKUP_FAILED,
      entityType: 'backup',
      entityId: name,
      after: {
        archiveBytes,
        snapshotBytes: snapshot.bytes,
        keyFingerprint: header.keyFingerprint,
        destinations: outcomes.map((o) => ({ kind: o.kind, ok: o.ok, error: o.error })),
      },
    });

    return run;
  } catch (error) {
    // A refusal for want of space is recorded as loudly as a crash: "backups stopped
    // running three weeks ago" is exactly the discovery §7.3 exists to prevent.
    await recordAudit({
      merchantId: context.merchantId,
      actorUserId: context.actorUserId,
      action: AUDIT_ACTIONS.BACKUP_FAILED,
      entityType: 'backup',
      entityId: name,
      after: {
        error: error instanceof Error ? error.message : 'فشل غير معروف',
        outOfSpace: error instanceof InsufficientSpaceError,
        ...(error instanceof InsufficientSpaceError ? { space: error.space } : {}),
      },
    });
    throw error;
  } finally {
    await rm(snapshotPath, { force: true });
    await rm(archivePath, { force: true });
  }
}

export interface RestoreResult {
  header: ArchiveHeader;
  /** Where the restored database was written. */
  path: string;
  /** SQLite's own verdict on the restored file. */
  integrity: string;
  counts: { customers: number; transactions: number; vouchers: number; auditEntries: number };
  /** The newest audit row in the restored copy — how recent this backup actually is. */
  latestAuditAt: string | null;
}

/**
 * Restores an archive to a file and inspects it. Never touches the live database.
 *
 * Restoring *over* the live database is deliberately not offered here. It is a decision
 * with a human and a stopped service behind it, not an API call one click away from a
 * dashboard — and every path in this module that a scheduler can reach must be incapable
 * of destroying the thing it exists to protect.
 */
export async function restoreArchive(archivePath: string, destinationPath: string): Promise<RestoreResult> {
  const key = requireKey();
  const header = await readArchive(archivePath, destinationPath, key);

  // Prisma wants a URL; on Windows the path separators have to be forward slashes for
  // it, though SQLite itself is happy either way.
  const url = `file:${destinationPath.split('\\').join('/')}`;
  const client = new PrismaClient({ datasources: { db: { url } } });

  try {
    const integrityRows =
      await client.$queryRawUnsafe<Array<Record<string, string>>>('PRAGMA integrity_check');
    const integrity = Object.values(integrityRows[0] ?? {})[0] ?? 'unknown';

    const [customers, transactions, vouchers, auditEntries] = await Promise.all([
      client.customer.count(),
      client.transaction.count(),
      client.voucher.count(),
      client.auditLog.count(),
    ]);

    const latest = await client.auditLog.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    return {
      header,
      path: destinationPath,
      integrity,
      counts: { customers, transactions, vouchers, auditEntries },
      latestAuditAt: latest?.createdAt.toISOString() ?? null,
    };
  } finally {
    await client.$disconnect();
  }
}

export interface RestoreVerification {
  ok: boolean;
  /** Where the archive was fetched back from — the whole chain, not just the local copy. */
  verifiedFrom: string;
  run: BackupRun;
  restore: RestoreResult;
  /** The §12.17 assertion: was the row written just before the backup actually in it. */
  recencyProven: boolean;
  sentinelId: string;
  failure?: string;
}

/**
 * The monthly restore test of §7.3, as one call (CLAUDE_v3.md §12.17).
 *
 * ## Why it is shaped like this
 *
 * A restore test that only proves the file opens would pass against exactly the bug
 * §12.17 is about. A backup taken by naively copying `walaa.db` without its `-wal`
 * sidecar restores cleanly, reports healthy, contains every table — and is missing the
 * most recent day of sales, which is precisely the day anyone restoring actually needs.
 *
 * So the assertion is recency, and it is made the only way it can be made honestly:
 *
 *  1. write a sentinel row into the live database,
 *  2. take a **real** backup through the **real** destinations,
 *  3. fetch it **back from a destination**, not from the staging file that never left,
 *  4. restore it,
 *  5. require that exact sentinel to be present.
 *
 * Step 3 is what makes this a test of the backup rather than of the encryption. A
 * verification that read the archive it had just written in memory would prove nothing
 * about the copy that is actually on the USB stick.
 */
export async function verifyRestore(
  context: BackupContext,
  destinations: BackupDestination[] = resolveDestinations(),
  now: Date = new Date(),
): Promise<RestoreVerification> {
  return withBackupLock(() => verifyRestoreUnlocked(context, destinations, now));
}

/**
 * The verification body. Holds the lock across the whole round trip rather than only
 * across its backup: the archive it restores must be the one it just took, and a manual
 * backup landing in between would prune or replace it.
 */
async function verifyRestoreUnlocked(
  context: BackupContext,
  destinations: BackupDestination[],
  now: Date,
): Promise<RestoreVerification> {
  await assertBackupsEnabled(context.merchantId);

  const staging = await prepareStaging();

  const sentinelId = `verify-${now.toISOString()}-${Math.random().toString(36).slice(2, 10)}`;

  // (1) The sentinel. Written before the backup, so its presence afterwards can only
  // mean the backup captured work committed moments before it ran.
  await recordAudit({
    merchantId: context.merchantId,
    actorUserId: context.actorUserId,
    action: AUDIT_ACTIONS.BACKUP_VERIFICATION_STARTED,
    entityType: 'backup_verification',
    entityId: sentinelId,
    after: { startedAt: now.toISOString() },
  });

  // (2) A real backup to the real destinations. The unlocked form: this function
  // already holds the lock, and calling the public one would deadlock against itself.
  const run = await runBackupUnlocked(context, destinations, now);

  const landed = run.destinations.find((o) => o.ok && o.id);
  if (!landed?.id) {
    throw new Error('لم تصل النسخة الاحتياطية إلى أي وجهة — لا يمكن التحقق منها');
  }

  const fetchedPath = join(staging, `verify-${run.name}`);
  const restoredPath = join(staging, `verify-${run.name}.db`);

  try {
    // (3) Back down from a destination, so the transport is part of what is proven.
    const source = destinations.find((d) => d.kind === landed.kind);
    if (!source) throw new Error('تعذّر تحديد وجهة النسخة الاحتياطية');
    await source.fetch(landed.id, fetchedPath);

    // (4) and (5).
    const restore = await restoreArchive(fetchedPath, restoredPath);
    const recencyProven = await sentinelPresent(restoredPath, sentinelId);
    const integrityOk = restore.integrity === 'ok';
    const ok = recencyProven && integrityOk;

    const failure = ok
      ? undefined
      : !integrityOk
        ? `فحص السلامة أعاد: ${restore.integrity}`
        : 'النسخة الاحتياطية لا تحتوي على أحدث العمليات — تحقّق من إعداد النسخ الاحتياطي';

    if (ok) {
      await recordAudit({
        merchantId: context.merchantId,
        actorUserId: context.actorUserId,
        action: AUDIT_ACTIONS.BACKUP_VERIFIED,
        entityType: 'backup',
        entityId: run.name,
        after: {
          verifiedFrom: landed.kind,
          sentinelId,
          counts: restore.counts,
          integrity: restore.integrity,
        },
      });
    }

    return {
      ok,
      verifiedFrom: landed.kind,
      run,
      restore,
      recencyProven,
      sentinelId,
      failure,
    };
  } finally {
    await rm(fetchedPath, { force: true });
    await rm(restoredPath, { force: true });
    await rm(`${restoredPath}-wal`, { force: true });
    await rm(`${restoredPath}-shm`, { force: true });
  }
}

/** Looks for the sentinel row in a restored database file. */
async function sentinelPresent(restoredPath: string, sentinelId: string): Promise<boolean> {
  const url = `file:${restoredPath.split('\\').join('/')}`;
  const client = new PrismaClient({ datasources: { db: { url } } });
  try {
    const found = await client.auditLog.count({
      where: { entityId: sentinelId, action: AUDIT_ACTIONS.BACKUP_VERIFICATION_STARTED },
    });
    return found === 1;
  } finally {
    await client.$disconnect();
  }
}

/** Everything stored at every configured destination, for the manager's backup screen. */
export async function listBackups(
  destinations: BackupDestination[] = resolveDestinations(),
): Promise<Array<{ kind: string; label: string; available: boolean; backups: StoredBackup[] }>> {
  return Promise.all(
    destinations.map(async (destination) => ({
      kind: destination.kind,
      label: destination.label,
      available: await destination.isAvailable(),
      backups: await destination.list().catch(() => []),
    })),
  );
}
