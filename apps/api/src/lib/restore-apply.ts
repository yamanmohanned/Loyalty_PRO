import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Putting a restored copy in place of the shop's database — at boot, and only at boot.
 *
 * ── Why at boot ──────────────────────────────────────────────────────────────
 *
 * The staged copy has already been fetched, decrypted, integrity-checked and brought to
 * this build's schema by `services/backup/restore.service.ts`, beside the live file and
 * on the same volume. What is left is two renames, and they must happen while nothing
 * holds the database open: Windows refuses to rename an open file, and replacing a
 * database under a live connection is how committed sales get lost. The first lines of
 * `main()` are the one moment that is guaranteed.
 *
 * ── Why every step is written down before it is taken ────────────────────────
 *
 * A power cut can land between any two of these renames. The dangerous gap is after
 * the live set has been moved aside and before the copy has been moved in: the next
 * boot would find no database, and `installDatabaseTemplateIfAbsent` would helpfully
 * install an EMPTY one — a shop that restored a backup and ended up with nothing.
 * So `applied.json` is written first; a boot that finds it finishes the swap (or undoes
 * it) before anything else runs.
 *
 * ── Nothing is thrown away ────────────────────────────────────────────────────
 *
 * The previous set — database AND its WAL, which holds committed transactions — is
 * moved into `restore/before-<time>/`, not deleted. If the service will not start on the
 * restored file, the next start puts that set back and records why. After two failed
 * boots on the restored file it is rolled back without being asked.
 */

const PENDING_DB = 'pending.db';
const MANIFEST = 'pending.json';
const APPLY = 'apply.json';
const APPLIED = 'applied.json';
const RESULT = 'last-result.json';
/** A SQLite database is up to three files, and they only mean something together. */
const SIDECARS = ['', '-wal', '-shm'] as const;

/** Boots of an unconfirmed restored file before it is given up on and rolled back. */
export const MAX_RESTORED_BOOTS = 2;

export interface StagedManifest {
  version: 1;
  stagedAt: string;
  stagedBy: string | null;
  stagedByName: string | null;
  source: { kind: string; label: string; id: string; name: string };
  copyTakenAt: string;
  latestActivityAt: string | null;
  copy: { customers: number; transactions: number; vouchers: number; auditEntries: number };
  current: { customers: number; transactions: number };
  /** Migrations applied to the staged copy so this build can open it. */
  upgraded: string[];
  /** Of `pending.db` as checked — a file changed after checking is never swapped in. */
  sha256: string;
  bytes: number;
}

export interface ApplyRequest {
  requestedAt: string;
  requestedBy: string | null;
  requestedByName: string | null;
  /** The backup taken of the state being replaced — the merchant's undo. */
  safetyBackupName: string | null;
}

interface AppliedRecord {
  at: string;
  manifest: StagedManifest;
  request: ApplyRequest;
  /** Folder under `restore/` holding the previous set. */
  keptAs: string;
  boots: number;
  /** Set when a boot on the restored file failed: the next start rolls it back. */
  rollback?: string;
}

export interface RestoreResultRecord {
  ok: boolean;
  at: string;
  requestedByName: string | null;
  source: { kind: string; label: string; name: string } | null;
  copyTakenAt: string | null;
  copy: { customers: number; transactions: number } | null;
  safetyBackupName: string | null;
  /** Folder under `restore/` holding the replaced set, on success. */
  keptAs: string | null;
  failure: string | null;
}

export interface AppliedRestore {
  directory: string;
  livePath: string;
  record: AppliedRecord;
}

type Log = (message: string, extra?: Record<string, unknown>) => void;

/** Beside the live database, so the swap is a rename on one volume and needs no space. */
export function restoreDirectoryFor(livePath: string): string {
  return join(dirname(livePath), 'restore');
}

export function stagedDatabasePath(directory: string): string {
  return join(directory, PENDING_DB);
}

function readJson<T>(path: string): T | null {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null;
  } catch {
    return null;
  }
}

/** Written to a temporary name and renamed, so a cut mid-write never leaves half a record. */
function writeJson(path: string, value: unknown): void {
  const partial = `${path}.partial`;
  writeFileSync(partial, JSON.stringify(value, null, 2), 'utf8');
  renameSync(partial, path);
}

/** SHA-256 of a file, read in 1 MiB pieces — a shop's database can be hundreds of MB. */
export function sha256File(path: string): string {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read: number;
    while ((read = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

export const readStagedManifest = (directory: string): StagedManifest | null =>
  readJson<StagedManifest>(join(directory, MANIFEST));

export const readRestoreResult = (directory: string): RestoreResultRecord | null =>
  readJson<RestoreResultRecord>(join(directory, RESULT));

export const isApplyRequested = (directory: string): boolean => existsSync(join(directory, APPLY));

export function writeStagedManifest(directory: string, manifest: StagedManifest): void {
  writeJson(join(directory, MANIFEST), manifest);
}

export function writeApplyRequest(directory: string, request: ApplyRequest): void {
  writeJson(join(directory, APPLY), request);
}

/** Forgets a staged copy and any request to apply it. The live database is not touched. */
export function clearStaged(directory: string): void {
  for (const name of [
    PENDING_DB,
    `${PENDING_DB}-wal`,
    `${PENDING_DB}-shm`,
    `${PENDING_DB}.partial`,
    MANIFEST,
    APPLY,
  ]) {
    rmSync(join(directory, name), { force: true });
  }
}

/** Moves a database and its sidecars together. Whatever is already gone is skipped. */
function moveSet(from: string, to: string): void {
  for (const suffix of SIDECARS) {
    if (existsSync(from + suffix)) renameSync(from + suffix, to + suffix);
  }
}

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-');

const TEXT = {
  stagedMissing:
    'طُلبت استعادة نسخة لكن الملف المُجهَّز لها لم يعد موجوداً أو تغيّر بعد فحصه، فلم يُستبدل شيء — البيانات كما كانت. اختر النسخة من شاشة «النسخ الاحتياطي» وأعد الاستعادة.',
  rolledBack: (detail: string) =>
    'لم تعمل الخدمة على النسخة المستعادة، فأُعيدت بيانات المتجر كما كانت قبل الاستعادة — لم يُفقد شيء.' +
    (detail ? ` السبب: ${detail}.` : '') +
    ' لا تُعد المحاولة بهذه النسخة قبل التواصل مع الدعم الفني.',
  repeated:
    'تعطّلت الخدمة أكثر من مرة عند تشغيلها على النسخة المستعادة، فأُعيدت بيانات المتجر كما كانت قبل الاستعادة — لم يُفقد شيء. لا تُعد المحاولة بهذه النسخة قبل التواصل مع الدعم الفني.',
};

/**
 * The sentence recorded when a boot on the restored file fails.
 *
 * Carries only the first clause of the startup error — WHAT went wrong — and only when
 * it is one of this product's own Arabic sentences (they begin with an Arabic letter);
 * a driver's English stays in the log.
 *
 * Not the whole sentence, and that was measured rather than assumed: a live rollback
 * recorded the entire startup refusal, which is written for a merchant whose service
 * will not start at all — «**إعادة تثبيت البرنامج لن تحل هذه المشكلة**… تواصل مع الدعم
 * الفني قبل أي خطوة أخرى» — with its markdown asterisks printed literally, on a screen
 * where the data had already been put back and none of that advice applied.
 */
export function rollbackSentence(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : '';
  if (!/^[؀-ۿ]/.test(message)) return TEXT.rolledBack('');
  const what = message
    .replace(/^تعذّر تشغيل الخدمة:\s*/, '')
    .replace(/\*\*/g, '')
    .split(/[،.]\s/)[0]
    ?.trim();
  return TEXT.rolledBack(what ?? '');
}

function resultOf(record: AppliedRecord, ok: boolean, failure: string | null): RestoreResultRecord {
  return {
    ok,
    at: new Date().toISOString(),
    requestedByName: record.request.requestedByName,
    source: {
      kind: record.manifest.source.kind,
      label: record.manifest.source.label,
      name: record.manifest.source.name,
    },
    copyTakenAt: record.manifest.copyTakenAt,
    copy: {
      customers: record.manifest.copy.customers,
      transactions: record.manifest.copy.transactions,
    },
    safetyBackupName: record.request.safetyBackupName,
    keptAs: ok ? record.keptAs : null,
    failure,
  };
}

/**
 * The live set aside, the staged file in. Resumable: run again after a cut, it finishes
 * whatever part had not happened — and does nothing once the staged file has moved in.
 */
function swapIn(directory: string, livePath: string, record: AppliedRecord): void {
  const pending = join(directory, PENDING_DB);
  if (!existsSync(pending)) return;

  const keptDirectory = join(directory, record.keptAs);
  mkdirSync(keptDirectory, { recursive: true });
  moveSet(livePath, join(keptDirectory, basename(livePath)));
  renameSync(pending, livePath);
}

/**
 * Applies a restore the merchant asked for. **Call before anything opens the database.**
 *
 * Returns the applied restore, which the caller confirms once the service is serving
 * (`confirmRestore`) or marks for rollback if boot fails (`requestRollback`). Returns
 * null when there is nothing to apply.
 *
 * A staged file that is missing or changed after it was checked is recorded as a failed
 * restore and boot continues on the untouched data. A rename that fails throws: booting
 * on a half-moved set would be worse than not booting.
 */
export function applyStagedRestore(livePath: string, log: Log): AppliedRestore | null {
  const directory = restoreDirectoryFor(livePath);
  const appliedPath = join(directory, APPLIED);

  // A previous boot began this restore and never confirmed it: it was cut mid-swap,
  // failed on the restored file, or was killed while trying.
  const inFlight = readJson<AppliedRecord>(appliedPath);
  if (inFlight) {
    const applied: AppliedRestore = { directory, livePath, record: inFlight };
    swapIn(directory, livePath, inFlight);

    if (inFlight.rollback) {
      rollbackRestore(applied, inFlight.rollback, log);
      return null;
    }

    const boots = inFlight.boots + 1;
    if (boots > MAX_RESTORED_BOOTS) {
      rollbackRestore(applied, TEXT.repeated, log);
      return null;
    }

    const record: AppliedRecord = { ...inFlight, boots };
    writeJson(appliedPath, record);
    log('restored database not yet confirmed by an earlier start; trying it again', { boots });
    return { directory, livePath, record };
  }

  const request = readJson<ApplyRequest>(join(directory, APPLY));
  if (!request) return null;

  const manifest = readStagedManifest(directory);
  const pending = join(directory, PENDING_DB);
  if (!manifest || !existsSync(pending) || sha256File(pending) !== manifest.sha256) {
    const refused: RestoreResultRecord = {
      ok: false,
      at: new Date().toISOString(),
      requestedByName: request.requestedByName,
      source: manifest
        ? { kind: manifest.source.kind, label: manifest.source.label, name: manifest.source.name }
        : null,
      copyTakenAt: manifest?.copyTakenAt ?? null,
      copy: manifest
        ? { customers: manifest.copy.customers, transactions: manifest.copy.transactions }
        : null,
      safetyBackupName: request.safetyBackupName,
      keptAs: null,
      failure: TEXT.stagedMissing,
    };
    writeJson(join(directory, RESULT), refused);
    clearStaged(directory);
    log('a restore was requested but the staged copy is missing or altered; nothing was replaced');
    return null;
  }

  const record: AppliedRecord = {
    at: new Date().toISOString(),
    manifest,
    request,
    keptAs: `before-${stamp()}`,
    boots: 1,
  };
  // BEFORE the first rename — see the header comment for the gap this closes.
  writeJson(appliedPath, record);
  swapIn(directory, livePath, record);
  rmSync(join(directory, APPLY), { force: true });
  rmSync(join(directory, MANIFEST), { force: true });

  log('restore applied at startup; the previous database is kept aside', {
    keptAs: record.keptAs,
    copy: manifest.source.name,
    copyTakenAt: manifest.copyTakenAt,
  });
  return { directory, livePath, record };
}

/**
 * Boot on the restored file failed: roll it back on the next start.
 *
 * Deferred rather than done here because the failing boot may still hold the file open
 * (Windows will not rename it) — the next start rolls back before anything opens it.
 */
export function requestRollback(applied: AppliedRestore, failure: string, log: Log): void {
  writeJson(join(applied.directory, APPLIED), { ...applied.record, rollback: failure });
  log('startup on the restored database failed; the previous database goes back on the next start');
}

/** Puts the previous set back and records why. Keeps the failed copy for support. */
export function rollbackRestore(applied: AppliedRestore, failure: string, log: Log): void {
  const { directory, livePath, record } = applied;
  const kept = join(directory, record.keptAs, basename(livePath));
  const failedAs = `failed-${stamp()}`;
  const failedDirectory = join(directory, failedAs);

  mkdirSync(failedDirectory, { recursive: true });
  moveSet(livePath, join(failedDirectory, basename(livePath)));
  moveSet(kept, livePath);
  writeJson(join(directory, RESULT), resultOf(record, false, failure));
  rmSync(join(directory, APPLIED), { force: true });

  // Tidy, because this may be the machine whose disk is nearly full: the kept folder is
  // empty now its files are live again, and an older failed copy is superseded by this
  // one. The newest failed copy stays, for support.
  const keptDirectory = join(directory, record.keptAs);
  if (existsSync(keptDirectory) && readdirSync(keptDirectory).length === 0) {
    rmSync(keptDirectory, { recursive: true, force: true });
  }
  for (const name of readdirSync(directory)) {
    if (name.startsWith('failed-') && name !== failedAs) {
      rmSync(join(directory, name), { recursive: true, force: true });
    }
  }

  log('restore rolled back; the previous database is live again', {
    failedAs,
    keptAs: record.keptAs,
  });
}

/**
 * The service is serving on the restored file: record success and tidy up.
 *
 * Only the newest kept set survives. A machine this product already warns about for
 * disk space must not collect a full copy of the database per restore; the replaced
 * state also exists as an ordinary backup (`safetyBackupName`).
 */
export function confirmRestore(applied: AppliedRestore, log: Log): RestoreResultRecord {
  const result = resultOf(applied.record, true, null);
  writeJson(join(applied.directory, RESULT), result);
  rmSync(join(applied.directory, APPLIED), { force: true });

  for (const name of readdirSync(applied.directory)) {
    if ((name.startsWith('before-') || name.startsWith('failed-')) && name !== applied.record.keptAs) {
      rmSync(join(applied.directory, name), { recursive: true, force: true });
    }
  }

  log('restore confirmed: serving on the restored database', {
    copy: applied.record.manifest.source.name,
    keptAs: applied.record.keptAs,
  });
  return result;
}
