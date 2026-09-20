import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { loadEnv } from '../../config/env';
import { findRepoEnvFile, resolveDataDir } from '../../config/paths';
import { EXPECTED_SCHEMA_HASH } from '../../config/schema-fingerprint';
import { computeSchemaHash } from '../../lib/db-identity';
import { AppError, backupBlocked } from '../../lib/errors';
import { storageFailureCause } from '../../lib/prisma';
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
 * (docs/legacy/CLAUDE_v3.md §7.3, §12.17).
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

/**
 * Where the on-machine copy is written.
 *
 * `BACKUP_LOCAL_DIR` wins wherever it is set. Otherwise the installed service writes
 * under its data directory (`%PROGRAMDATA%\LoyaltyPro\backups`), which is the right
 * answer on a merchant machine and the wrong one in a checkout: a dev process runs
 * unelevated and cannot write there, so every scheduled run failed with EPERM and
 * logged a 507 every five minutes.
 *
 * **That is worse than untidy.** 507 is the code §12.22's free-space warning uses for a
 * volume that has genuinely run out — the one storage signal that must never be
 * background noise. A developer who has learned to scroll past it has been trained by
 * us to miss the real one.
 *
 * The dev branch is gated on the repository marker rather than on `NODE_ENV`, because
 * that marker cannot exist on an installed machine (`findRepoEnvFile` requires both
 * `pnpm-workspace.yaml` and `.env` — the reasoning is in `config/paths.ts`). A shop's
 * backups can therefore never be redirected into a directory that does not exist there.
 */
export function localBackupDirectory(): string {
  const configured = loadEnv().BACKUP_LOCAL_DIR;
  if (configured) return configured;

  const repoEnvFile = findRepoEnvFile();
  if (repoEnvFile) return join(dirname(repoEnvFile), '.loyalty-pro-dev', 'backups');

  return join(resolveDataDir(), 'backups');
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

/** Throws while a backup or verification is running — checked again inside the lock. */
export function assertNoBackupRunning(): void {
  if (inFlight) throw backupBlocked('هناك نسخة احتياطية قيد التنفيذ بالفعل');
}

async function withBackupLock<T>(operation: () => Promise<T>): Promise<T> {
  assertNoBackupRunning();

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
 * Creates the staging directory and clears whatever an interrupted run left in it.
 *
 * Found by running this against the live API: a dev process is unelevated, and the
 * directory it defaulted to under `%PROGRAMDATA%\Walaa` is locked by the installer to
 * SYSTEM and Administrators, so `mkdir` returned EPERM on every scheduled run.
 * `localBackupDirectory` now keeps a checkout out of ProgramData entirely, so that
 * particular EPERM is gone — but a misconfigured `BACKUP_LOCAL_DIR`, a USB path that
 * vanished, or a full disk all still land here, and every one of them was answering
 * "حدث خطأ غير متوقع".
 *
 * A backup that cannot start is not a bug the manager should be asked to shrug at. It is
 * §7.3's mandatory safeguard not running, and it names the directory so somebody can fix
 * it.
 *
 * ── The sweep, and the leak it closes ────────────────────────────────────────
 *
 * `runBackupUnlocked` removes its snapshot and archive in a `finally`, which covers an
 * error and does nothing at all for a **killed process** — a power cut, a Windows
 * restart, a `Stop-Process` during the nightly run. Measured on a 400 MB database:
 * three `Stop-Process -Force` calls part-way through three backups left
 *
 *     snapshot.db                             420,716,544
 *     walaa-2026-09-08T02-45-15-487Z.walaabk   35,818,710
 *     walaa-2026-09-08T02-46-16-850Z.walaabk   62,308,623
 *     walaa-2026-09-08T02-46-50-077Z.walaabk   52,379,919
 *                                            ─────────────
 *                                            571,223,796 bytes
 *
 * and nothing in the product would ever have removed them. `snapshot.db` is reused by
 * name so it stops growing, but the archive carries `archiveName(now)` — a fresh name
 * every run — so each interrupted backup adds a permanent partial file. The nightly
 * schedule means the machine most likely to be interrupted mid-backup is also the one
 * accumulating fastest.
 *
 * That is §12.15's full disk being manufactured by the mechanism that exists to protect
 * against it, in the directory a manager never opens, on the volume that stops the till
 * when it fills. The leftovers are invisible to `LocalDirectoryDestination.list`, which
 * reads only `*.walaabk` at the top level, so the Backup screen showed nothing wrong.
 *
 * The sweep is safe because `withBackupLock` guarantees no other run is in flight and
 * this directory holds nothing but the current run's scratch. It **never throws**: a
 * file that cannot be deleted is a fact to report in the audit row, not a reason to skip
 * §7.3's mandatory backup — refusing there would turn a wasted gigabyte into no backups
 * at all.
 */
async function prepareStaging(): Promise<{ path: string; reclaimedBytes: number }> {
  const staging = stagingDirectory();
  try {
    await mkdir(staging, { recursive: true });
  } catch (error) {
    const code = (error as { code?: string }).code;
    throw new AppError(
      'STORAGE_UNAVAILABLE',
      // The errno code and the path were in the sentence, and «صلاحيات الوصول إلى هذا
      // المسار» is an ACL on ProgramData that a merchant cannot change. Both go to the
      // log through `cause`; the sentence keeps the one thing he can check.
      'تعذّر تجهيز مجلد النسخ الاحتياطي، فلم تُؤخذ أي نسخة. قاعدة البيانات لم تتغيّر. ' +
        'إن كان مجلد النسخ على قرص خارجي فتأكّد أنه موصول وأعد المحاولة؛ وإلا فتواصل مع الدعم الفني.',
      { cause: new Error(`${code ?? 'unknown'}: ${staging}`, { cause: error }) },
    );
  }

  let reclaimedBytes = 0;
  try {
    for (const name of await readdir(staging)) {
      const path = join(staging, name);
      try {
        const { size } = await stat(path);
        await rm(path, { recursive: true, force: true });
        reclaimedBytes += size;
      } catch {
        /* Locked or vanished. The next run tries again; neither is worth failing over. */
      }
    }
  } catch {
    /* The directory was readable enough to create and is not now. Carry on. */
  }

  return { path: staging, reclaimedBytes };
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
  const snapshotPath = join(staging.path, 'snapshot.db');
  const archivePath = join(staging.path, name);

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
        // Only when there was something to reclaim. A nonzero value here is the
        // fingerprint of a previous run that was killed rather than failed, and it is
        // the only place that fact is ever recorded.
        ...(staging.reclaimedBytes > 0 ? { staleStagingReclaimedBytes: staging.reclaimedBytes } : {}),
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
        ...(staging.reclaimedBytes > 0 ? { staleStagingReclaimedBytes: staging.reclaimedBytes } : {}),
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
  /**
   * Rows pointing at parents that are not there, as `table -> parent` pairs.
   *
   * Separate from `integrity` because it answers a different question and deserves a
   * different reaction: the pages can be perfectly sound while a row is orphaned.
   * `lib/db-integrity.ts` makes the same split at boot, for the same reason — one is a
   * refusal, the other is something to know about.
   */
  foreignKeyViolations: number;
  /**
   * The schema hash of the restored file, and whether it is the one this build expects.
   *
   * An archive taken before a schema change restores perfectly and then cannot be
   * served: the binary would query columns the file does not have. Whoever is
   * recovering needs to learn that here, holding a file they can still keep, rather
   * than from a service that refuses to start after they have overwritten the original.
   */
  schemaHash: string;
  schemaMatchesBuild: boolean;
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
 * of destroying the thing it exists to protect. `tools/restore.ts` is the human's end of
 * that: an offline command that produces the replacement file and reports on it, leaving
 * the operator to put it in place with the service stopped.
 *
 * `key` is optional and overrides the configured one. It exists for the recovery this
 * whole subsystem is for: the shop's machine is gone, a fresh install has generated its
 * own new `BACKUP_KEY`, and the only key that opens last week's archive is the one the
 * merchant wrote down during the ceremony (§12.19). Without a way to supply it, the
 * ceremony would produce a key with nowhere to be typed.
 *
 * ── The destination appears only when it is finished ─────────────────────────
 *
 * Everything is written to `<destination>.partial` and renamed at the very end, after
 * the checksum, the integrity check and the schema hash have all passed. `destinationPath`
 * therefore never exists in a half-made state.
 *
 * That is not tidiness, it is the only defence against a **killed** restore — the case
 * no `try/catch` can reach. Measured against a 420 MB archive:
 *
 *   - `Stop-Process -Force` at t+2s left a 267,908,956-byte truncated `loyalty-pro.db`;
 *   - at t+3.5s it left a **full-length 420,716,544-byte file that opens cleanly,
 *     passes `PRAGMA quick_check` and reports the correct 28 transactions** — because
 *     decryption had finished and only the SHA-256 verification had not.
 *
 * The second is the dangerous one. It is indistinguishable from a completed restore by
 * every check an operator would think to run, and the runbook's next instruction is to
 * copy that file over the shop's database. With the rename, the same kill leaves
 * `loyalty-pro.db.partial`, which nobody puts into place, and no `loyalty-pro.db` at all.
 */
export async function restoreArchive(
  archivePath: string,
  destinationPath: string,
  key: Buffer = requireKey(),
): Promise<RestoreResult> {
  const workingPath = `${destinationPath}.partial`;

  // ═══ THE SIDECARS MUST GO FIRST, AND THIS IS NOT HOUSEKEEPING ═══
  //
  // SQLite recovers from `-wal` and `-shm` on open. Write a fresh database file to a
  // path that still has the *previous* database's sidecars beside it, and SQLite tries
  // to replay a log belonging to a file that no longer exists — the open fails with
  // **"database disk image is malformed"**, which reads as a corrupt archive and sends
  // whoever is restoring after the wrong problem entirely.
  //
  // Stated at the strength the evidence supports: this is a documented SQLite
  // behaviour, not something reproduced here. Three attempts to stage it — main file
  // truncated to zero, truncated mid-page, and replaced by a different database, each
  // with its original WAL restored — all opened cleanly, because SQLite validates the
  // WAL header's salt against the main file and discards a log that does not match.
  // So the guard below is hygiene against a real mechanism whose trigger conditions
  // are narrower than they look, and it costs two `rm` calls.
  //
  // Removing them is safe **here specifically** and nowhere else: both paths are files
  // this function is about to overwrite wholesale, so anything those sidecars describe
  // is already being discarded. Never do this beside a live database — a WAL holds
  // committed transactions, and deleting one loses sales.
  for (const path of [workingPath, destinationPath]) {
    await rm(`${path}-wal`, { force: true });
    await rm(`${path}-shm`, { force: true });
  }
  await rm(workingPath, { force: true });

  const header = await readArchive(archivePath, workingPath, key);

  // Prisma wants a URL; on Windows the path separators have to be forward slashes for
  // it, though SQLite itself is happy either way.
  const url = `file:${workingPath.split('\\').join('/')}`;
  const client = new PrismaClient({ datasources: { db: { url } } });

  try {
    const integrityRows =
      await client.$queryRawUnsafe<Array<Record<string, string>>>('PRAGMA integrity_check');
    const integrity = Object.values(integrityRows[0] ?? {})[0] ?? 'unknown';

    const fkRows = await client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      'PRAGMA foreign_key_check',
    );

    const schemaHash = await computeSchemaHash(client);

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

    // Closed before the rename, not in the `finally`. On Windows a rename of a file a
    // process still holds open fails with EBUSY, and the sidecars SQLite created while
    // inspecting belong to the working file rather than to the finished one.
    await client.$disconnect();
    await rm(`${workingPath}-wal`, { force: true });
    await rm(`${workingPath}-shm`, { force: true });

    await rm(destinationPath, { force: true });
    await rename(workingPath, destinationPath);

    return {
      header,
      path: destinationPath,
      integrity,
      foreignKeyViolations: fkRows.length,
      schemaHash,
      schemaMatchesBuild: schemaHash === EXPECTED_SCHEMA_HASH,
      counts: { customers, transactions, vouchers, auditEntries },
      latestAuditAt: latest?.createdAt.toISOString() ?? null,
    };
  } finally {
    // Idempotent: a second disconnect on an already-closed client is a no-op, and this
    // is the only path that closes it when an inspection query throws.
    await client.$disconnect();
    // Whatever failed, the half-made file does not survive to be mistaken for a restore.
    // A no-op on the success path, where the rename has already consumed it.
    await rm(workingPath, { force: true });
    await rm(`${workingPath}-wal`, { force: true });
    await rm(`${workingPath}-shm`, { force: true });
  }
}

export interface RestoreVerification {
  ok: boolean;
  /**
   * Where the archive was fetched back from — the whole chain, not just the local copy.
   * Null when the test failed before any destination received it.
   */
  verifiedFrom: string | null;
  /** Null when the backup step itself failed. */
  run: BackupRun | null;
  /** Null when the test failed before the copy could be opened. */
  restore: RestoreResult | null;
  /** The §12.17 assertion: was the row written just before the backup actually in it. */
  recencyProven: boolean;
  sentinelId: string;
  failure?: string;
}

/**
 * The monthly restore test of §7.3, as one call (docs/legacy/CLAUDE_v3.md §12.17).
 *
 * ## Why it is shaped like this
 *
 * A restore test that only proves the file opens would pass against exactly the bug
 * §12.17 is about. A backup taken by naively copying `loyalty-pro.db` without its `-wal`
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
  // The one precondition that still throws: with backups blocked there is no test to
  // run, and BACKUP_BLOCKED sends the dashboard to the key ceremony.
  await assertBackupsEnabled(context.merchantId);

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

  /*
    ── Every failure from here on is a RESULT, recorded and shown ───────────────

    It used to be an exception: "no destination received the copy" and "could not fetch
    it back" were thrown as plain `Error`s, which the error handler turns into a flat
    «حدث خطأ غير متوقع», and nothing was recorded — so the Backup screen went on saying
    «لم يُجرَ اختبار استعادة بعد» after a test that had run and failed. A failed test is
    the most important thing this screen can report. So each stage's failure becomes a
    sentence naming what failed and what to do, and it is written to the trail exactly
    like a pass.
  */
  let run: BackupRun | null = null;
  let verifiedFrom: string | null = null;
  let restore: RestoreResult | null = null;
  let recencyProven = false;
  let failure: string | undefined;
  const scratch: string[] = [];

  try {
    // The backup folder first, and inside the recorded stages: a folder that cannot be
    // made — an external drive not plugged in, a mistyped path — is a failed test the
    // merchant must see on the screen, not an exception thrown before anything was
    // written down.
    const staging = await stage('BACKUP', prepareStaging);

    // (2) A real backup to the real destinations. The unlocked form: this function
    // already holds the lock, and calling the public one would deadlock against itself.
    run = await stage('BACKUP', () => runBackupUnlocked(context, destinations, now));

    const landed = run.destinations.find((o) => o.ok && o.id);
    if (!landed?.id) throw new VerificationFailure(noCopyLanded(run.destinations));
    verifiedFrom = landed.kind;

    const fetchedPath = join(staging.path, `verify-${run.name}`);
    const restoredPath = join(staging.path, `verify-${run.name}.db`);
    scratch.push(fetchedPath, restoredPath, `${restoredPath}-wal`, `${restoredPath}-shm`);

    // (3) Back down from a destination, so the transport is part of what is proven.
    const source = destinations.find((d) => d.kind === landed.kind);
    if (!source) throw new VerificationFailure(VERIFY_TEXT.unknown);
    await stage('FETCH', () => source.fetch(landed.id!, fetchedPath), landed.label);

    // (4) and (5).
    restore = await stage('RESTORE', () => restoreArchive(fetchedPath, restoredPath));
    recencyProven = await sentinelPresent(restoredPath, sentinelId);

    if (restore.integrity !== 'ok') {
      failure = VERIFY_TEXT.integrity(restore.integrity);
    } else if (!recencyProven) {
      // «تحقّق من إعداد النسخ الاحتياطي» — no setting makes a snapshot miss the write
      // made just before it. This is a defect, and the honest instruction is not to
      // trust this archive.
      failure = VERIFY_TEXT.recency;
    }
  } catch (error) {
    failure = error instanceof VerificationFailure ? error.message : VERIFY_TEXT.unknown;
  } finally {
    for (const path of scratch) await rm(path, { force: true });
  }

  const ok = failure === undefined;

  try {
    await recordAudit({
      merchantId: context.merchantId,
      actorUserId: context.actorUserId,
      action: ok ? AUDIT_ACTIONS.BACKUP_VERIFIED : AUDIT_ACTIONS.BACKUP_VERIFY_FAILED,
      entityType: 'backup',
      entityId: run?.name ?? sentinelId,
      after: {
        verifiedFrom,
        sentinelId,
        ...(restore ? { counts: restore.counts, integrity: restore.integrity } : {}),
        ...(failure ? { failure } : {}),
      },
    });
  } catch {
    // A disk that has just refused the test may refuse this row too. The result still
    // goes back to the screen that asked; only the lasting record is lost, and the
    // storage banner is already saying why.
  }

  return { ok, verifiedFrom, run, restore, recencyProven, sentinelId, failure };
}

/** A stage failure already phrased for the merchant. */
class VerificationFailure extends Error {}

type VerifyStage = 'BACKUP' | 'FETCH' | 'RESTORE';

/** Runs one stage, turning whatever it throws into a sentence that names the stage. */
async function stage<T>(which: VerifyStage, work: () => Promise<T>, label?: string): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new VerificationFailure(verificationSentence(which, error, label));
  }
}

/** A driver's or the OS's words, kept only if they are already Arabic — never a path. */
function arabicDetail(message: string | undefined): string {
  if (!message || /[A-Za-z]/.test(message)) return '';
  return ` (${message})`;
}

const VERIFY_TEXT = {
  diskFull:
    'المساحة الحرة على القرص شبه منتهية، فتوقّف اختبار الاستعادة. فرّغ مساحة على هذا الجهاز الآن، ثم أعد الاختبار — لم يتغيّر شيء في بيانات المتجر.',
  readOnly:
    'لا يستطيع البرنامج الكتابة في مجلد بياناته على هذا الجهاز — صلاحيات الملفات تمنع ذلك، فتوقّف اختبار الاستعادة. لم يتغيّر شيء في بيانات المتجر. لا يُصلَح هذا من داخل البرنامج: تواصل مع الدعم الفني.',
  ioError:
    'القرص على هذا الجهاز أعاد خطأ أثناء اختبار الاستعادة، وقد يكون يتعطّل. أعد الاختبار؛ وإن تكرّر فتواصل مع الدعم الفني لفحص القرص.',
  backup: (detail: string) =>
    `تعذّر أخذ نسخة الاختبار${detail}. لم يتغيّر شيء في بيانات المتجر. أعد الاختبار؛ وإن تكرّر فتواصل مع الدعم الفني.`,
  fetch: (label: string, detail: string) =>
    `أُخذت النسخة لكن تعذّر استرجاعها من «${label}»${detail} — أي أن النسخة المحفوظة هناك قد لا تُسترجع وقت الحاجة. أعد الاختبار؛ وإن تكرّر فتواصل مع الدعم الفني.`,
  restore: (detail: string) =>
    `استُرجعت النسخة لكنها لم تُفتح${detail} — لا تعتمد عليها، وتواصل مع الدعم الفني.`,
  noCopy: (lines: string) =>
    `لم تصل نسخة الاختبار إلى أي مكان حفظ: ${lines}. لم يتغيّر شيء في بيانات المتجر؛ عالج السبب ثم أعد الاختبار.`,
  integrity: (verdict: string) =>
    `النسخة استُرجعت لكن فحص السلامة لم ينجح${arabicDetail(verdict)} — لا تعتمد عليها، وتواصل مع الدعم الفني.`,
  recency:
    'النسخة الاحتياطية لا تحتوي على آخر عملية سُجّلت قبلها مباشرة — لا تعتمد عليها، وتواصل مع الدعم الفني.',
  unknown:
    'تعذّر إكمال اختبار الاستعادة. لم يتغيّر شيء في بيانات المتجر. أعد الاختبار؛ وإن تكرّر فتواصل مع الدعم الفني.',
  unwritable: 'تعذّرت الكتابة فيه',
};

/**
 * What a failed stage means, for the person reading the Backup screen.
 *
 * The environment first: a full disk, a folder the service may not write, a disk that
 * returns errors. Those are the likeliest causes on the machine this was reported from
 * — 1.3 GB free — and each has a remedy that is not "try again".
 */
function verificationSentence(which: VerifyStage, error: unknown, label?: string): string {
  // Already a full sentence, with the numbers and the remedy.
  if (error instanceof InsufficientSpaceError) return error.message;

  switch (storageFailureCause(error)) {
    case 'DISK_FULL':
      return VERIFY_TEXT.diskFull;
    case 'READ_ONLY':
      return VERIFY_TEXT.readOnly;
    case 'IO_ERROR':
      return VERIFY_TEXT.ioError;
    default:
      break;
  }

  // Our own refusals already speak Arabic and name their remedy.
  if (error instanceof AppError) return error.message;

  const detail = arabicDetail(error instanceof Error ? error.message : undefined);
  if (which === 'FETCH') return VERIFY_TEXT.fetch(label ?? '—', detail);
  if (which === 'RESTORE') return VERIFY_TEXT.restore(detail);
  return VERIFY_TEXT.backup(detail);
}

/** Why no destination took the copy, one clause per destination. */
function noCopyLanded(outcomes: DestinationOutcome[]): string {
  if (outcomes.some((o) => storageFailureCause(new Error(o.error ?? '')) === 'DISK_FULL')) {
    return VERIFY_TEXT.diskFull;
  }
  const lines = outcomes
    .map((o) => {
      const said = o.error && !/[A-Za-z]/.test(o.error) ? o.error : VERIFY_TEXT.unwritable;
      return `«${o.label}» — ${said}`;
    })
    .join('؛ ');
  return VERIFY_TEXT.noCopy(lines || '—');
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
