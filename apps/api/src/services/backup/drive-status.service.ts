import type { DriveStatus } from '@walaa/shared-types';
import { loadEnv } from '../../config/env';
import { AUDIT_ACTIONS, recordAudit } from '../audit.service';
import { asDriveError, driveFailure } from './drive-errors';
import { driveCredentials, DRIVE_SCOPE, GoogleDriveDestination } from './drive';
import { readConnection, readConnectionSummary, updateConnection } from './drive-store';
import { scheduleStatus } from './schedule.service';

/**
 * What the Settings panel is told about Google Drive (CLAUDE_v3.md §7.3).
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

/** `fetch` with a deadline. Undici turns the abort into an error `isNetworkError` knows. */
const timedFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });

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
  const configured = Boolean(env.GOOGLE_DRIVE_CLIENT_ID && env.GOOGLE_DRIVE_CLIENT_SECRET);
  const stored = readConnectionSummary();
  // The pre-consent-flow arrangement: a refresh token pasted into the environment file.
  // Still honoured so an installation set up that way keeps its off-machine copy.
  const legacy = Boolean(env.GOOGLE_DRIVE_REFRESH_TOKEN) && !stored;
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
  };

  if (!configured) return { ...base, failure: driveFailure('NOT_CONFIGURED') };
  if (!connected) return { ...base, failure: driveFailure('NOT_CONNECTED') };

  // Paused by the merchant. Not a failure — the grant is intact and one switch restores
  // it — so no red remedy is shown for a state somebody chose on purpose.
  if (!base.enabled) return base;

  if (options.probe === false) {
    return { ...base, failure: stored?.lastFailure ?? null };
  }

  const credentials = driveCredentials(env, readConnection());
  if (!credentials) return { ...base, failure: driveFailure('NOT_CONNECTED') };

  try {
    const destination = new GoogleDriveDestination(credentials, timedFetch);
    const backups = await destination.list();
    // A successful list clears a stale failure: the merchant fixed their Wi-Fi and the
    // panel must not keep telling them their internet is down.
    if (stored?.lastFailure) updateConnection({ lastFailure: null });
    return {
      ...base,
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
