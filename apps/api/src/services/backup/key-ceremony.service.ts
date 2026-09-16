import { timingSafeEqual } from 'node:crypto';
import type { KeyStatus } from '@walaa/shared-types';
import { loadEnv, resetEnvCache } from '../../config/env';
import { setEnvValue } from '../../config/env-file';
import { backupBlocked, validationFailed } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { AUDIT_ACTIONS, recordAudit } from '../audit.service';
import { KEY_BYTES } from './archive';
import { generateBackupKey, keyFingerprint, parseBackupKey } from './key';

/**
 * The backup key ceremony (CLAUDE_v3.md §7.3, §12.19).
 *
 * ## The failure this exists to prevent
 *
 * A key that lives only on the machine being backed up is not a backup. Fire, theft,
 * ransomware, a dead disk — every failure backup exists to survive takes the key with
 * the data, and what is left is a folder of intact, encrypted, **permanently
 * unrecoverable** archives sitting safely in Drive.
 *
 * That is worse than having no backup at all, and the reason is not technical: a
 * merchant with no backup knows they have no backup. A merchant with unopenable archives
 * believes they are covered, does not arrange anything else, and finds out on the single
 * worst day their business has.
 *
 * ## Why it is a ceremony and not a setting
 *
 * Anything optional here gets deferred, and a deferral has no deadline. So:
 *
 *  - backups do not run at all until the key is confirmed — `backupsEnabled` is false
 *    and `runBackup` refuses;
 *  - confirmation requires the manager to **type the key back**, because "I have written
 *    it down" is a claim and re-entry is evidence;
 *  - the confirmation is an audit row naming who and when, so it is answerable later;
 *  - and it is bound to the key's fingerprint, so a replaced key reopens the ceremony
 *    instead of inheriting the old confirmation.
 *
 * ## What must never happen in this file
 *
 * The key must never reach a log line, an error message, an audit payload, or Drive
 * metadata. Fingerprints are safe to record — a hash of 256 random bits — and are what
 * every diagnostic here uses instead.
 */

// `KeyStatus` is the shared contract (`@walaa/shared-types`). It decides whether a
// shop's backups are openable at all, and a client that disagreed with this shape
// would tell a manager the ceremony is done when it is not (§12.27).
export type { KeyStatus };

/** Reads the configured key, or null when the ceremony has not been started. */
function currentKey(): Buffer | null {
  return parseBackupKey(loadEnv().BACKUP_KEY);
}

export async function keyStatus(merchantId: string): Promise<KeyStatus> {
  // An existence check, not a count. The question is "has any key ever been confirmed",
  // and `count` has to visit every matching row to answer a question that is settled by
  // the first one. This runs on every dashboard focus and on every scheduler tick.
  const everConfirmed =
    (await prisma.auditLog.findFirst({
      where: { merchantId, action: AUDIT_ACTIONS.BACKUP_KEY_CONFIRMED },
      select: { id: true },
    })) !== null;

  const key = currentKey();
  if (!key) {
    return {
      configured: false,
      fingerprint: null,
      confirmed: false,
      confirmedAt: null,
      confirmedBy: null,
      backupsEnabled: false,
      everConfirmed,
    };
  }

  const fingerprint = keyFingerprint(key);

  // Bound to THIS key. A different key has a different fingerprint and therefore no
  // confirming row, which is the whole mechanism — see AUDIT_ACTIONS.
  const confirmation = await prisma.auditLog.findFirst({
    where: {
      merchantId,
      action: AUDIT_ACTIONS.BACKUP_KEY_CONFIRMED,
      entityId: fingerprint,
    },
    orderBy: { createdAt: 'asc' },
    include: { actor: { select: { name: true } } },
  });

  return {
    configured: true,
    fingerprint,
    confirmed: Boolean(confirmation),
    confirmedAt: confirmation?.createdAt.toISOString() ?? null,
    confirmedBy: confirmation?.actor?.name ?? null,
    backupsEnabled: Boolean(confirmation),
    everConfirmed,
  };
}

/**
 * Generates a key if none exists, and writes it to the environment file.
 *
 * **Never replaces an existing key.** Doing so would orphan every archive already taken
 * — they are decryptable only by the key that made them — so a rotation is a separate,
 * deliberate act with its own warnings, and deliberately not something this function can
 * be talked into. `setEnvValue` refuses the overwrite as a second line of defence.
 */
export async function ensureKeyGenerated(
  merchantId: string,
  actorUserId: string | null,
): Promise<KeyStatus> {
  if (currentKey()) return keyStatus(merchantId);

  const generated = generateBackupKey();
  setEnvValue('BACKUP_KEY', generated);

  // The running process read its configuration at boot; without this it would keep
  // reporting "not configured" to the manager who just generated the key.
  process.env.BACKUP_KEY = generated;
  resetEnvCache();

  const key = parseBackupKey(generated);
  if (!key || key.byteLength !== KEY_BYTES) {
    throw new Error('فشل توليد مفتاح التشفير');
  }

  await recordAudit({
    merchantId,
    actorUserId,
    action: AUDIT_ACTIONS.BACKUP_KEY_GENERATED,
    entityType: 'backup_key',
    // The fingerprint, never the key. This row is readable by anyone who can read the
    // audit trail, which is a wider set than the people who may hold the key.
    entityId: keyFingerprint(key),
  });

  return keyStatus(merchantId);
}

/**
 * Returns the key itself, for the one moment it must be shown to a human.
 *
 * Audited on every call. A secret displayed has left the vault, and "who has seen this"
 * is a question worth being able to answer — the more so because the honest answer to
 * "can this be un-shown" is no.
 */
/**
 * Throws unless a key exists to reveal or confirm. The routes run it before their rate
 * limit counts, so pressing a button too early never uses up an attempt.
 */
export function assertKeyExists(): void {
  if (!currentKey()) throw backupBlocked('لم يتم توليد مفتاح التشفير بعد');
}

export async function revealKey(merchantId: string, actorUserId: string | null): Promise<string> {
  const key = currentKey();
  if (!key) throw backupBlocked('لم يتم توليد مفتاح التشفير بعد');

  await recordAudit({
    merchantId,
    actorUserId,
    action: AUDIT_ACTIONS.BACKUP_KEY_REVEALED,
    entityType: 'backup_key',
    entityId: keyFingerprint(key),
  });

  return key.toString('base64');
}

/**
 * Confirms the manager holds the key, by requiring them to type it back.
 *
 * Compared in constant time, and a mismatch says only that it did not match. Reporting
 * *how* it differed — length, first wrong character — would turn the confirmation box
 * into an oracle for anyone who can reach the dashboard.
 */
export async function confirmKey(
  merchantId: string,
  actorUserId: string | null,
  submitted: string,
): Promise<KeyStatus> {
  const key = currentKey();
  if (!key) throw backupBlocked('لم يتم توليد مفتاح التشفير بعد');

  const offered = Buffer.from(submitted.trim(), 'base64');
  const matches =
    offered.byteLength === key.byteLength && timingSafeEqual(offered, key);

  if (!matches) {
    throw validationFailed('المفتاح المُدخل لا يطابق المفتاح الحالي');
  }

  const fingerprint = keyFingerprint(key);
  const already = await prisma.auditLog.count({
    where: { merchantId, action: AUDIT_ACTIONS.BACKUP_KEY_CONFIRMED, entityId: fingerprint },
  });

  // Append-only: confirming twice records once. The trail should answer "when was this
  // key confirmed", not "how many times did someone click the button".
  if (already === 0) {
    await recordAudit({
      merchantId,
      actorUserId,
      action: AUDIT_ACTIONS.BACKUP_KEY_CONFIRMED,
      entityType: 'backup_key',
      entityId: fingerprint,
    });
  }

  return keyStatus(merchantId);
}

/**
 * Throws unless backups are permitted to run.
 *
 * Called by every path that would produce an archive. An archive encrypted with a key
 * nobody has recorded is not a backup; producing one anyway and reporting success is the
 * exact deception §12.19 exists to prevent.
 */
export async function assertBackupsEnabled(merchantId: string): Promise<void> {
  const status = await keyStatus(merchantId);
  if (status.backupsEnabled) return;

  throw backupBlocked(
    status.configured
      ? 'النسخ الاحتياطي متوقف: لم يتم تأكيد حفظ مفتاح التشفير خارج هذا الجهاز'
      : 'النسخ الاحتياطي متوقف: لم يتم إعداد مفتاح التشفير بعد',
  );
}
