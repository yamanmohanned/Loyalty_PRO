import { existsSync, statSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { RestoreOutcome, RestoreRefusalReason, StagedRestore } from '@walaa/shared-types';
import { loadEnv } from '../../config/env';
import { liveDatabasePath, resolveMigrationsDir } from '../../config/paths';
import { EXPECTED_SCHEMA_HASH } from '../../config/schema-fingerprint';
import { computeSchemaHash } from '../../lib/db-identity';
import { AppError } from '../../lib/errors';
import { canRestart, requestRestart } from '../../lib/lifecycle';
import { applyPendingMigrations, readMigrationDirectory } from '../../lib/migrate';
import { prisma } from '../../lib/prisma';
import {
  clearStaged,
  isApplyRequested,
  readRestoreResult,
  readStagedManifest,
  restoreDirectoryFor,
  sha256File,
  stagedDatabasePath,
  writeApplyRequest,
  writeStagedManifest,
  type RestoreResultRecord,
  type StagedManifest,
} from '../../lib/restore-apply';
import { AUDIT_ACTIONS, recordAudit } from '../audit.service';
import { readFreeSpace } from '../storage.service';
import { readArchiveHeader, type ArchiveHeader } from './archive';
import { resolveDestinations, restoreArchive, runBackup, type RestoreResult } from './backup.service';
import { DriveError, asDriveError } from './drive-errors';
import { fingerprintMatches, keyFingerprint, parseBackupKey } from './key';

/**
 * Restoring a copy over the shop's data, from the Backup screen (CLAUDE_v3.md §7.3).
 *
 * Two steps, and nothing live changes in the first:
 *
 *  1. **Stage** — fetch the chosen copy from wherever it is kept (this machine, a USB
 *     drive, Google Drive), decrypt it BESIDE the live database, and check it: the key,
 *     the file's integrity, its structure against this build. The merchant is then shown
 *     what he is about to put back — how old it is, what is in it against what is in the
 *     program now, and what will no longer exist.
 *  2. **Apply** — only after he confirms: take an ordinary backup of the current state
 *     (so undoing this is the same action from the same list), record the request, and
 *     restart. The swap itself happens at boot (`lib/restore-apply.ts`), with the
 *     previous files kept and a rollback if the service will not start on the copy.
 *
 * `tools/restore.ts` remains the support technician's offline path; this is the
 * merchant's, and it never replaces a file that has not been checked.
 */

export interface RestoreActor {
  merchantId: string;
  actorUserId: string | null;
  actorName: string | null;
}

/** Headroom beyond the files themselves: SQLite's own scratch while checking and upgrading. */
const MARGIN_BYTES = 64 * 1024 * 1024;

const gb = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(2)} GB`;

const refuse = (
  reason: RestoreRefusalReason,
  message: string,
  details: Record<string, unknown> = {},
): AppError => new AppError('RESTORE_REFUSED', message, { details: { reason, ...details } });

/** A thrown message kept only when it is one of ours — Arabic, no driver English, no paths. */
function arabicDetail(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : '';
  return /^[\u0600-\u06FF«]/.test(message) ? ` (${message})` : '';
}

const TEXT = {
  notFileDatabase:
    'هذا التشغيل لا يستخدم ملف قاعدة بيانات على هذا الجهاز، فلا يمكن الاستعادة فيه.',
  noDestination:
    'مكان الحفظ الذي اخترت منه النسخة لم يعد متاحاً على هذا الجهاز. حدّث الصفحة واختر النسخة من القائمة من جديد.',
  copyGone: 'هذه النسخة لم تعد موجودة في مكان حفظها. حدّث الصفحة واختر نسخة من القائمة.',
  fetch: (label: string, detail: string) =>
    `تعذّر تنزيل النسخة من «${label}»${detail}. لم يتغيّر شيء في بيانات المتجر. أعد المحاولة؛ وإن تكرّر فاختر نسخة من مكان حفظ آخر.`,
  fetchDrive: (message: string, remedy: string) =>
    `${message} ${remedy} لم يتغيّر شيء في بيانات المتجر.`,
  damaged:
    'ملف هذه النسخة تالف أو ناقص، فلا يمكن فتحه. لم يتغيّر شيء في بيانات المتجر. اختر نسخة أخرى.',
  integrity:
    'فُتحت النسخة لكن فحص السلامة وجد فيها أخطاء، فلن تُستعاد. لم يتغيّر شيء في بيانات المتجر. اختر نسخة أخرى، وتواصل مع الدعم الفني.',
  keyOther:
    'هذه النسخة مشفّرة بمفتاح غير مفتاح هذا الجهاز — على الأرجح أُخذت على جهاز آخر أو قبل تغيير المفتاح. أدخل أدناه مفتاح التشفير المكتوب على الورقة التي حُفظت يوم إعداد النسخ الاحتياطي لذلك الجهاز.',
  keyWrongTyped:
    'المفتاح الذي أدخلته لا يفتح هذه النسخة. تأكّد أنه مفتاح الجهاز الذي أُخذت عليه هذه النسخة، وانسخه كما هو مكتوب على الورقة.',
  keyInvalid:
    'هذا ليس مفتاح تشفير صالحاً — المفتاح 44 حرفاً ورقماً، ويُنسخ كما هو مكتوب على الورقة تماماً. أعد إدخاله.',
  noKey:
    'لا يوجد مفتاح تشفير على هذا الجهاز، فلا يمكن فتح أي نسخة به. أدخل أدناه مفتاح النسخة المكتوب على الورقة.',
  newer:
    'هذه النسخة أُخذت بإصدار أحدث من البرنامج المثبّت هنا، فلا يستطيع هذا الإصدار تشغيلها. حدّث البرنامج على هذا الجهاز إلى الإصدار نفسه أو أحدث، ثم أعد الاستعادة. لم يتغيّر شيء.',
  schemaMismatch:
    'بنية البيانات في هذه النسخة لا تتفق مع هذا الإصدار من البرنامج، فلن تُستعاد. لم يتغيّر شيء في بيانات المتجر. تواصل مع الدعم الفني ومعك تاريخ النسخة.',
  noSpace: (free: number, needed: number) =>
    `لا توجد مساحة كافية على القرص لتجهيز الاستعادة: ${gb(free)} متاحة، والمطلوب ${gb(needed)}. فرّغ مساحة على هذا الجهاز الآن، ثم أعد المحاولة — لم يتغيّر شيء في بيانات المتجر.`,
  nothingStaged: 'لا توجد نسخة مُجهَّزة للاستعادة. اختر النسخة من القائمة أولاً.',
  stagedChanged:
    'الملف المُجهَّز للاستعادة تغيّر بعد فحصه، فلن يُستخدم. اختر النسخة من القائمة وجهّزها من جديد.',
  safetyFailed: (reason: string) =>
    `قبل الاستعادة تُؤخذ نسخة احتياطية من الوضع الحالي حتى يمكن الرجوع إليه، وتعذّر أخذها: ${reason} لم يُستبدل شيء.`,
  safetyNoCopy: 'لم تصل النسخة إلى أي مكان حفظ.',
  safetyGeneric: 'حدث خلل أثناء أخذها.',
};

function restoreDirectory(): string {
  const live = liveDatabasePath(loadEnv().DATABASE_URL);
  if (!live) throw refuse('NOT_FOUND', TEXT.notFileDatabase);
  return restoreDirectoryFor(live);
}

/** The key to open the copy with: the one typed from paper, or this machine's own. */
function keyFor(typed: string | undefined): { key: Buffer; typed: boolean } {
  if (typed !== undefined && typed.trim() !== '') {
    try {
      // Whitespace is dropped: a key copied off paper arrives with spaces and line breaks.
      const key = parseBackupKey(typed.replace(/\s+/g, ''));
      if (key) return { key, typed: true };
    } catch {
      /* Wrong length — the refusal below says so. */
    }
    throw refuse('KEY_INVALID', TEXT.keyInvalid);
  }

  let configured: Buffer | null = null;
  try {
    configured = parseBackupKey(loadEnv().BACKUP_KEY);
  } catch {
    configured = null;
  }
  if (!configured) throw refuse('KEY_MISMATCH', TEXT.noKey, { fingerprint: null });
  return { key: configured, typed: false };
}

function assertRoom(directory: string, neededBytes: number): void {
  const { freeBytes } = readFreeSpace(directory);
  if (freeBytes < neededBytes) {
    throw refuse('NO_SPACE', TEXT.noSpace(freeBytes, neededBytes), { freeBytes, neededBytes });
  }
}

function fetchSentence(kind: string, label: string, error: unknown): string {
  if (kind === 'drive') {
    const failure = (error instanceof DriveError ? error : asDriveError(error, 'restore fetch')).toFailure();
    return TEXT.fetchDrive(failure.message, failure.remedy);
  }
  return TEXT.fetch(label, arabicDetail(error));
}

/**
 * Makes the staged copy something this build can serve, or refuses it.
 *
 * Production never migrates the LIVE database at boot (`migrationPolicy`). This is not
 * that: it runs the build's own migrations against the staged COPY, which the live
 * database does not depend on, and the result must hash to exactly the schema this
 * build expects — or the copy is refused and nothing changes. A copy from a NEWER build
 * carries migrations this build has never seen and is refused outright.
 */
async function bringToThisBuild(path: string): Promise<string[]> {
  const url = `file:${path.split('\\').join('/')}`;
  const client = new PrismaClient({ datasources: { db: { url } } });
  try {
    if ((await computeSchemaHash(client)) === EXPECTED_SCHEMA_HASH) return [];

    const directory = resolveMigrationsDir();
    const known = new Set(directory ? readMigrationDirectory(directory).map((m) => m.name) : []);
    const recorded = await client
      .$queryRawUnsafe<Array<{ migration_name: string }>>('SELECT migration_name FROM "_prisma_migrations"')
      .catch(() => [] as Array<{ migration_name: string }>);
    if (recorded.some((row) => !known.has(row.migration_name))) throw refuse('SCHEMA_NEWER', TEXT.newer);

    let applied: string[];
    try {
      applied = (await applyPendingMigrations({ client, directory: directory ?? undefined })).applied;
    } catch {
      throw refuse('SCHEMA_MISMATCH', TEXT.schemaMismatch);
    }
    if ((await computeSchemaHash(client)) !== EXPECTED_SCHEMA_HASH) {
      throw refuse('SCHEMA_MISMATCH', TEXT.schemaMismatch);
    }

    // Folded into the file before it is hashed and later moved on its own: the swap
    // moves `pending.db` alone, so nothing may be left in a WAL beside it.
    await client.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)');
    return applied;
  } finally {
    await client.$disconnect();
    // Empty after the checkpoint, and SQLite's own scratch in any case.
    await rm(`${path}-shm`, { force: true });
    if (existsSync(`${path}-wal`) && statSync(`${path}-wal`).size === 0) {
      await rm(`${path}-wal`, { force: true });
    }
  }
}

async function currentCounts(merchantId: string): Promise<{ customers: number; transactions: number }> {
  const [customers, transactions] = await Promise.all([
    prisma.customer.count({ where: { merchantId } }),
    prisma.transaction.count({ where: { merchantId } }),
  ]);
  return { customers, transactions };
}

function stagedView(manifest: StagedManifest, applyRequested: boolean): StagedRestore {
  return {
    stagedAt: manifest.stagedAt,
    stagedByName: manifest.stagedByName,
    source: { kind: manifest.source.kind, label: manifest.source.label, name: manifest.source.name },
    copyTakenAt: manifest.copyTakenAt,
    latestActivityAt: manifest.latestActivityAt,
    copy: { customers: manifest.copy.customers, transactions: manifest.copy.transactions },
    current: manifest.current,
    upgraded: manifest.upgraded.length > 0,
    applyRequested,
  };
}

/** Step 1. Fetches, decrypts and checks a copy beside the live database. Replaces nothing. */
export async function stageRestore(
  actor: RestoreActor,
  ref: { kind: string; id: string },
  typedKey?: string,
): Promise<StagedRestore> {
  const destination = resolveDestinations().find((d) => d.kind === ref.kind);
  if (!destination) throw refuse('NOT_FOUND', TEXT.noDestination);

  let copies: Awaited<ReturnType<typeof destination.list>>;
  try {
    copies = await destination.list();
  } catch (error) {
    throw refuse('FETCH_FAILED', fetchSentence(destination.kind, destination.label, error));
  }
  const copy = copies.find((candidate) => candidate.id === ref.id);
  if (!copy) throw refuse('NOT_FOUND', TEXT.copyGone);

  const { key, typed } = keyFor(typedKey);
  const directory = restoreDirectory();
  await mkdir(directory, { recursive: true });
  clearStaged(directory);

  const incoming = join(directory, 'incoming.walaabk');
  const pending = stagedDatabasePath(directory);

  // The archive, and roughly the copy beside it; measured again once the header says
  // how large the decrypted copy really is.
  assertRoom(directory, copy.bytes * 2 + MARGIN_BYTES);

  try {
    try {
      await destination.fetch(copy.id, incoming);
    } catch (error) {
      throw refuse('FETCH_FAILED', fetchSentence(destination.kind, destination.label, error));
    }

    let header: ArchiveHeader;
    try {
      header = await readArchiveHeader(incoming);
    } catch {
      throw refuse('DAMAGED', TEXT.damaged);
    }

    // Before decrypting, so a copy from another machine is a question about a key and
    // not a GCM error — the same words a corrupt file produces.
    if (!fingerprintMatches(header.keyFingerprint, keyFingerprint(key))) {
      throw refuse('KEY_MISMATCH', typed ? TEXT.keyWrongTyped : TEXT.keyOther, {
        fingerprint: header.keyFingerprint,
      });
    }
    assertRoom(directory, header.plaintextBytes + MARGIN_BYTES);

    let restored: RestoreResult;
    try {
      restored = await restoreArchive(incoming, pending, key);
    } catch (error) {
      throw refuse('DAMAGED', `${TEXT.damaged}${arabicDetail(error)}`);
    }
    if (restored.integrity !== 'ok') throw refuse('DAMAGED', TEXT.integrity);

    const upgraded = await bringToThisBuild(pending);
    const current = await currentCounts(actor.merchantId);

    const manifest: StagedManifest = {
      version: 1,
      stagedAt: new Date().toISOString(),
      stagedBy: actor.actorUserId,
      stagedByName: actor.actorName,
      source: { kind: destination.kind, label: destination.label, id: copy.id, name: copy.name },
      copyTakenAt: header.createdAt,
      latestActivityAt: restored.latestAuditAt,
      copy: restored.counts,
      current,
      upgraded,
      sha256: sha256File(pending),
      bytes: statSync(pending).size,
    };
    writeStagedManifest(directory, manifest);

    await recordAudit({
      merchantId: actor.merchantId,
      actorUserId: actor.actorUserId,
      action: AUDIT_ACTIONS.BACKUP_RESTORE_STAGED,
      entityType: 'backup',
      entityId: copy.name,
      after: {
        source: destination.kind,
        copyTakenAt: header.createdAt,
        counts: restored.counts,
        upgraded,
      },
    });

    return stagedView(manifest, false);
  } catch (error) {
    clearStaged(directory);
    throw error;
  } finally {
    await rm(incoming, { force: true });
  }
}

/** Forgets the staged copy. The live database is not touched. */
export function cancelStagedRestore(): void {
  let directory: string;
  try {
    directory = restoreDirectory();
  } catch {
    return;
  }
  clearStaged(directory);
}

/**
 * Step 2. The merchant confirmed: back up the present, record the request, restart.
 *
 * The backup comes first and is required. It is the undo — the replaced state appears
 * in the same list and is restored the same way — and a restore that cannot offer one
 * is refused rather than carried out without it.
 */
/** Throws unless a checked copy is waiting to be applied. Cheap: no hashing. */
export function assertRestoreStaged(): void {
  const directory = restoreDirectory();
  if (!readStagedManifest(directory) || !existsSync(stagedDatabasePath(directory))) {
    throw refuse('NOTHING_STAGED', TEXT.nothingStaged);
  }
}

export async function requestApply(actor: RestoreActor): Promise<{ restarting: boolean }> {
  const directory = restoreDirectory();
  const manifest = readStagedManifest(directory);
  const pending = stagedDatabasePath(directory);

  if (!manifest || !existsSync(pending)) throw refuse('NOTHING_STAGED', TEXT.nothingStaged);
  if (sha256File(pending) !== manifest.sha256) {
    clearStaged(directory);
    throw refuse('NOTHING_STAGED', TEXT.stagedChanged);
  }

  let safetyBackupName: string;
  try {
    const safety = await runBackup({ merchantId: actor.merchantId, actorUserId: actor.actorUserId });
    if (!safety.ok) throw refuse('PRE_RESTORE_BACKUP_FAILED', TEXT.safetyFailed(TEXT.safetyNoCopy));
    safetyBackupName = safety.name;
  } catch (error) {
    if (error instanceof AppError && error.code === 'RESTORE_REFUSED') throw error;
    const reason = error instanceof AppError ? error.message : TEXT.safetyGeneric;
    throw refuse('PRE_RESTORE_BACKUP_FAILED', TEXT.safetyFailed(reason));
  }

  writeApplyRequest(directory, {
    requestedAt: new Date().toISOString(),
    requestedBy: actor.actorUserId,
    requestedByName: actor.actorName,
    safetyBackupName,
  });

  await recordAudit({
    merchantId: actor.merchantId,
    actorUserId: actor.actorUserId,
    action: AUDIT_ACTIONS.BACKUP_RESTORE_REQUESTED,
    entityType: 'backup',
    entityId: manifest.source.name,
    after: { safetyBackupName, copyTakenAt: manifest.copyTakenAt },
  });

  return { restarting: canRestart() && requestRestart('restore') };
}

/** What the Backup screen shows: the staged copy, and what the last restore did. */
export function restoreStatus(): { staged: StagedRestore | null; last: RestoreOutcome | null } {
  let directory: string;
  try {
    directory = restoreDirectory();
  } catch {
    return { staged: null, last: null };
  }

  const manifest = readStagedManifest(directory);
  const result = readRestoreResult(directory);

  return {
    staged:
      manifest && existsSync(stagedDatabasePath(directory))
        ? stagedView(manifest, isApplyRequested(directory))
        : null,
    last: result
      ? {
          ok: result.ok,
          at: result.at,
          requestedByName: result.requestedByName,
          source: result.source,
          copyTakenAt: result.copyTakenAt,
          copy: result.copy,
          safetyBackupName: result.safetyBackupName,
          failure: result.failure,
        }
      : null,
  };
}

/**
 * Written into the restored database's own trail once it is serving, so its history
 * says a restore happened — not only the file beside it.
 */
export async function recordAppliedRestore(result: RestoreResultRecord): Promise<void> {
  const merchant = await prisma.merchant.findFirst({ select: { id: true } });
  if (!merchant) return;

  await recordAudit({
    merchantId: merchant.id,
    actorUserId: null,
    action: AUDIT_ACTIONS.BACKUP_RESTORED,
    entityType: 'backup',
    entityId: result.source?.name ?? 'restore',
    after: {
      requestedByName: result.requestedByName,
      copyTakenAt: result.copyTakenAt,
      counts: result.copy,
      safetyBackupName: result.safetyBackupName,
    },
  });
}
