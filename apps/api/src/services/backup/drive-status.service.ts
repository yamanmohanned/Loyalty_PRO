import { tmpdir } from 'node:os';
import type {
  DriveAccount,
  DriveClientUpdate,
  DriveStatus,
  DriveTestResult,
  DriveTestStepName,
} from '@loyalty-pro/shared-types';
import { loadEnv } from '../../config/env';
import { AppError } from '../../lib/errors';
import { AUDIT_ACTIONS, recordAudit } from '../audit.service';
import { asDriveError, driveFailure } from './drive-errors';
import { driveClient, driveCredentials, DRIVE_SCOPE, GoogleDriveDestination } from './drive';
import {
  clearClient,
  readConnection,
  readConnectionSummary,
  updateConnection,
  writeClient,
} from './drive-store';
import { scheduleStatus } from './schedule.service';
import { licensedFeature } from '../license.service';

/**
 * What the Settings panel is told about Google Drive (docs/legacy/CLAUDE_v3.md §7.3).
 *
 * ## The question this answers
 *
 * Not "is Drive configured" — a merchant does not care — but **"is a copy of my shop
 * going off this machine, and if not, what do I do about it?"** Which is why the shape
 * returned here leads with a date (`lastSuccessAt`) and a classified failure carrying
 * its own remedy, rather than with a boolean.
 *
 * A date is the only thing that catches the failure this product keeps meeting: the
 * quiet one. "Connected: yes" stays true for months after the uploads stopped. "آخر رفع
 * ناجح: منذ 43 يوماً" does not.
 *
 * ## Why the status call touches the network
 *
 * It lists the archives actually in Drive rather than reporting what we believe we put
 * there. Those are different claims, and only the second one is worth anything: a
 * retention bug, a folder somebody deleted from their phone, or a grant that lapsed
 * silently all show up as an empty list and a classified failure. The call is bounded by
 * a timeout so a dead uplink costs eight seconds, not a hung screen — and every failure
 * on that path degrades to "no list, here is why", never to an error page.
 */

/** A dead uplink must cost a bounded wait, not a hung Settings screen. */
const PROBE_TIMEOUT_MS = 8000;
/** The connection test moves a small file up and back down: generous, still bounded. */
const TEST_TIMEOUT_MS = 20_000;

/** `fetch` with a deadline. Undici turns the abort into an error `isNetworkError` knows. */
const timed =
  (ms: number): typeof fetch =>
  (input, init) =>
    fetch(input, { ...init, signal: AbortSignal.timeout(ms) });

const TEXT = {
  disconnectFirst:
    'حساب Google مربوط الآن بإعدادات الربط الحالية. اضغط «فصل الحساب» أولاً، ثم احفظ الإعدادات الجديدة وأعد الربط.',
  disconnectBeforeClear:
    'لا يمكن حذف إعدادات الربط وحساب Google مربوط بها. اضغط «فصل الحساب» أولاً.',
};

/**
 * The full Drive picture for one merchant.
 *
 * **Never throws.** It is rendered beside the backup controls, and a Settings screen that
 * fails to load because Google is unreachable would be reporting the wrong problem in
 * the worst possible way — as a broken app rather than as a dropped connection.
 */
export async function driveStatus(
  merchantId: string,
  options: { probe?: boolean } = {},
): Promise<DriveStatus> {
  const env = loadEnv();
  const client = driveClient(env);
  const configured = client !== null;
  const stored = readConnectionSummary();
  // The pre-consent-flow arrangement: a refresh token pasted into the environment file.
  // Honoured outside production only — see `driveCredentials`.
  const legacy =
    env.NODE_ENV !== 'production' && Boolean(env.GOOGLE_DRIVE_REFRESH_TOKEN) && !stored;
  const connected = configured && (Boolean(stored) || legacy);

  const schedule = await scheduleStatus(merchantId).catch(() => null);
  const base: DriveStatus = {
    configured,
    connected,
    enabled: stored?.enabled ?? legacy,
    connectedAt: stored?.connectedAt ?? null,
    lastSuccessAt: stored?.lastSuccessAt ?? null,
    lastAttemptAt: stored?.lastAttemptAt ?? null,
    failure: null,
    keep: stored?.keep ?? env.BACKUP_KEEP,
    folderId: stored?.folderId ?? env.GOOGLE_DRIVE_FOLDER_ID ?? null,
    backups: [],
    schedule: {
      enabled: schedule?.enabled ?? false,
      dailyAt: schedule?.dailyAt ?? env.BACKUP_DAILY_AT,
      timeZone: schedule?.timeZone ?? env.MERCHANT_TIMEZONE,
      everyTransactions: schedule?.everyTransactions ?? env.BACKUP_EVERY_TRANSACTIONS,
      nextRunAt: schedule?.nextRunAt ?? null,
    },
    scope: DRIVE_SCOPE,
    // The id only. The secret never leaves the store, in any response.
    client: client ? { clientId: client.clientId, source: client.source, savedAt: client.savedAt } : null,
    account: stored?.account ?? null,
    licensed: await licensedFeature('drive_backup').catch(() => false),
  };

  if (!configured) return { ...base, failure: driveFailure('NOT_CONFIGURED') };
  if (!connected) return { ...base, failure: driveFailure('NOT_CONNECTED') };

  // Paused by the merchant. Not a failure — the grant is intact and one switch restores
  // it — so no red remedy is shown for a state somebody chose on purpose.
  if (!base.enabled) return base;

  // Connected, but the licence does not include uploads. Said up front rather than at
  // 23:30: the local copy still runs, and restoring from Drive still works.
  if (!base.licensed) return { ...base, failure: driveFailure('NOT_LICENSED') };

  if (options.probe === false) {
    return { ...base, failure: stored?.lastFailure ?? null };
  }

  const credentials = driveCredentials(env, readConnection());
  if (!credentials) return { ...base, failure: driveFailure('NOT_CONNECTED') };

  try {
    const destination = new GoogleDriveDestination(credentials, timed(PROBE_TIMEOUT_MS));
    const backups = await destination.list();

    // A grant made before the account was recorded learns whose it is, once.
    let account = base.account;
    if (!account && stored) {
      account = await destination.account().catch(() => null);
      if (account) updateConnection({ account });
    }

    // A successful list clears a stale failure: the merchant fixed their Wi-Fi and the
    // panel must not keep telling them their internet is down.
    if (stored?.lastFailure) updateConnection({ lastFailure: null });
    return {
      ...base,
      account,
      failure: null,
      backups: backups.map((backup) => ({
        id: backup.id,
        name: backup.name,
        bytes: backup.bytes,
        createdAt: backup.createdAt.toISOString(),
      })),
    };
  } catch (error) {
    const classified = asDriveError(error, 'status probe');
    updateConnection({ lastFailure: classified.toFailure() });
    return { ...base, failure: classified.toFailure() };
  }
}

const TEST_STEPS: readonly DriveTestStepName[] = ['AUTHORISE', 'UPLOAD', 'READ_BACK', 'DELETE'];

/**
 * «اختبار الاتصال»: the whole chain, on demand.
 *
 * Authorise, upload a small file, read it back byte for byte, delete it — each step
 * reporting for itself with the same classified failure a backup would get. It used to
 * be a list call, which passes on a full Drive and on a folder the app can read but not
 * write: exactly the two cases in which the nightly upload fails.
 *
 * Runs even while Drive is paused. Pausing stops the schedule; asking for a test is
 * asking whether the chain works, which is a separate question.
 */
export async function testDriveConnection(): Promise<DriveTestResult> {
  const env = loadEnv();
  const at = new Date();
  const notReady = (code: 'NOT_CONFIGURED' | 'NOT_CONNECTED'): DriveTestResult => ({
    ok: false,
    at: at.toISOString(),
    account: null,
    steps: TEST_STEPS.map((step, index) => ({
      step,
      ok: index === 0 ? false : null,
      failure: index === 0 ? driveFailure(code, at) : null,
    })),
  });

  if (!driveClient(env)) return notReady('NOT_CONFIGURED');

  const connection = readConnection();
  const credentials = driveCredentials(env, connection ? { ...connection, enabled: true } : null);
  if (!credentials) return notReady('NOT_CONNECTED');

  const destination = new GoogleDriveDestination(credentials, timed(TEST_TIMEOUT_MS));
  const steps = await destination.roundTrip(tmpdir(), at);
  const ok = steps.every((step) => step.ok === true);

  let account: DriveAccount | null = connection?.account ?? null;
  if (ok) {
    account = (await destination.account().catch(() => null)) ?? account;
    if (connection) updateConnection({ ...(account ? { account } : {}), lastFailure: null });
  } else {
    const failed = steps.find((step) => step.ok === false);
    if (connection && failed?.failure) updateConnection({ lastFailure: failed.failure });
  }

  return { ok, at: at.toISOString(), account, steps };
}

/**
 * Stores the OAuth client the owner typed into Settings — the secret sealed.
 *
 * Refused while an account is connected under a DIFFERENT client: the stored grant was
 * issued to the old one and would stop working the moment the new one took over,
 * silently, at 23:30. Re-saving the same client id (a rotated secret) is allowed.
 *
 * The audit row carries the id and the fact that a secret was stored — never the secret.
 * Audit rows are readable by every dashboard role and travel inside every backup.
 */
export async function saveDriveClient(
  input: { merchantId: string; actorUserId: string | null },
  update: DriveClientUpdate,
): Promise<DriveStatus> {
  const clientId = update.clientId.trim();
  const clientSecret = update.clientSecret.trim();

  const current = driveClient(loadEnv());
  if (readConnectionSummary() && current && current.clientId !== clientId) {
    throw new AppError('VALIDATION_FAILED', TEXT.disconnectFirst, {
      fields: [{ path: 'clientId', message: TEXT.disconnectFirst }],
    });
  }

  writeClient(clientId, clientSecret);

  await recordAudit({
    merchantId: input.merchantId,
    actorUserId: input.actorUserId,
    action: AUDIT_ACTIONS.BACKUP_DRIVE_CLIENT_SAVED,
    entityType: 'backup_drive',
    entityId: 'client',
    before: current ? { clientId: current.clientId } : undefined,
    after: { clientId, secretStored: true },
  });

  return driveStatus(input.merchantId, { probe: false });
}

/** Forgets the OAuth client. Refused while an account is connected with it. */
export async function clearDriveClient(input: {
  merchantId: string;
  actorUserId: string | null;
}): Promise<DriveStatus> {
  if (readConnectionSummary()) {
    throw new AppError('VALIDATION_FAILED', TEXT.disconnectBeforeClear);
  }
  clearClient();

  await recordAudit({
    merchantId: input.merchantId,
    actorUserId: input.actorUserId,
    action: AUDIT_ACTIONS.BACKUP_DRIVE_CLIENT_CLEARED,
    entityType: 'backup_drive',
    entityId: 'client',
  });

  return driveStatus(input.merchantId, { probe: false });
}

/** Applies a settings change and records it. Returns the refreshed status. */
export async function updateDriveSettings(
  input: {
    merchantId: string;
    actorUserId: string | null;
  },
  change: { enabled?: boolean; keep?: number },
): Promise<DriveStatus> {
  const before = readConnectionSummary();
  if (before) {
    updateConnection({
      ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
      ...(change.keep === undefined ? {} : { keep: change.keep }),
    });

    await recordAudit({
      merchantId: input.merchantId,
      actorUserId: input.actorUserId,
      action: AUDIT_ACTIONS.BACKUP_DRIVE_SETTINGS_UPDATED,
      entityType: 'backup_drive',
      entityId: 'settings',
      before: { enabled: before.enabled, keep: before.keep },
      after: {
        enabled: change.enabled ?? before.enabled,
        keep: change.keep ?? before.keep,
      },
    });
  }

  // No probe: the merchant just moved a slider and wants the panel back, not an
  // eight-second wait on a network call that has nothing to do with what they changed.
  return driveStatus(input.merchantId, { probe: false });
}
