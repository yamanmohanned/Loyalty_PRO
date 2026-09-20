import type { FastifyBaseLogger } from 'fastify';
import { loadEnv } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { AUDIT_ACTIONS, recordAudit } from '../audit.service';
import { isBackupRunning, runBackup } from './backup.service';
import { keyStatus } from './key-ceremony.service';

/**
 * Scheduled backups (docs/legacy/CLAUDE_v3.md §7.3, §12.21).
 *
 * §7.3: "daily after close + every 500 transactions". Four properties shape everything
 * below, and each one is a failure this project has already met in another guise.
 *
 * **A missed run happens late, it does not disappear.** A till switched off overnight is
 * normal, not exceptional, and a scheduler that only fires while the machine is awake
 * silently backs up nothing for a shop that closes at nine. So nothing here is a timer
 * that fires once; every tick asks "is the most recent daily slot still uncovered", and
 * a machine started at nine in the morning backs up immediately for last night's slot.
 *
 * **It lives in the service, not the manager app.** The app is a window somebody closes.
 * The Windows Service is the thing that survives a closed window, a logout and a reboot
 * (§12.3), and it is where the API already runs.
 *
 * **It cannot collide with a manual run.** Both go through the same in-process lock in
 * `backup.service`; the scheduler yields rather than queues, and tries again next tick.
 *
 * **Every outcome is recorded.** Success, failure, refusal for want of disk, and skip.
 * The shape this product keeps designing against is the quiet one — a backup that
 * stopped running months ago and told nobody — so "nothing happened" is never allowed to
 * be indistinguishable from "nothing was written down".
 */

/** How often the scheduler wakes to ask whether anything is due. */
const TICK_MS = 5 * 60 * 1000;

/**
 * How long after a failed attempt before another is made.
 *
 * Without it a full disk would be retried every tick, filling the log with the same
 * failure and doing a `VACUUM INTO` each time on a volume that has no room for it.
 */
const RETRY_AFTER_MS = 30 * 60 * 1000;

export type DueReason = 'DAILY' | 'TRANSACTIONS';

export interface ScheduleDecision {
  run: boolean;
  reason: DueReason | null;
  /** Why not, when not — reported on the Backup screen rather than left implicit. */
  skip: 'NOT_ENABLED' | 'ALREADY_RUNNING' | 'BACKING_OFF' | 'NOT_DUE' | null;
}

export interface ScheduleStatus {
  enabled: boolean;
  /** Local wall-clock time, in the merchant's timezone. */
  dailyAt: string;
  timeZone: string;
  everyTransactions: number;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastOutcome: 'COMPLETED' | 'FAILED' | 'SKIPPED' | null;
  /** The next daily slot after now. */
  nextRunAt: string | null;
  transactionsSinceLastBackup: number;
  running: boolean;
  decision: ScheduleDecision;
}

/* ── Local-time arithmetic ────────────────────────────────────────────────── */

/**
 * The zone's UTC offset at a given instant, in milliseconds.
 *
 * Formats the instant in the zone, reads the result back as though it were UTC, and
 * takes the difference. Three integers and no date library, matching how
 * `shared-types/period.ts` handles the same problem — and correct across a DST boundary,
 * which Asia/Baghdad does not have but a future merchant's timezone might.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const read = (type: string): number => {
    const found = parts.find((p) => p.type === type);
    if (!found) throw new Error(`تعذر حساب الوقت للمنطقة الزمنية ${timeZone}`);
    // `hour12: false` can render midnight as 24; Date.UTC handles the rollover.
    return Number.parseInt(found.value, 10);
  };

  const asIfUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour'),
    read('minute'),
    read('second'),
  );

  return asIfUtc - instant.getTime();
}

/** The instant at which a local wall-clock time occurs on a given local date. */
function localTimeToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  // The offset is evaluated at roughly the right instant, then applied. One correction
  // is enough for every zone whose offset changes by less than a day.
  const offset = zoneOffsetMs(new Date(naive), timeZone);
  return new Date(naive - offset);
}

/** The calendar date `instant` falls on, as seen in `timeZone`. */
function localDate(instant: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const read = (type: string) => Number.parseInt(parts.find((p) => p.type === type)!.value, 10);
  return { year: read('year'), month: read('month'), day: read('day') };
}

/** `HH:MM` into hours and minutes, rejecting anything that is not a time. */
export function parseDailyAt(value: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) {
    throw new Error(`BACKUP_DAILY_AT يجب أن يكون بصيغة HH:MM (الحالي "${value}")`);
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * The most recent occurrence of the daily time at or before `now`.
 *
 * This is what makes a missed run catch up rather than vanish: it names a slot in the
 * past, and the decision below asks whether that slot has been covered — not whether a
 * timer happened to fire while the machine was awake.
 */
export function mostRecentSlot(now: Date, dailyAt: string, timeZone: string): Date {
  const { hour, minute } = parseDailyAt(dailyAt);
  const today = localDate(now, timeZone);

  const todaySlot = localTimeToInstant(today.year, today.month, today.day, hour, minute, timeZone);
  if (todaySlot.getTime() <= now.getTime()) return todaySlot;

  // Before today's slot, so the most recent one was yesterday. Built by stepping the
  // local calendar date back a day rather than subtracting 24 hours, which would be
  // wrong on the day a zone changes offset.
  const yesterday = localDate(new Date(now.getTime() - 24 * 60 * 60 * 1000), timeZone);
  return localTimeToInstant(
    yesterday.year,
    yesterday.month,
    yesterday.day,
    hour,
    minute,
    timeZone,
  );
}

/** The first occurrence of the daily time strictly after `now`. */
export function nextSlot(now: Date, dailyAt: string, timeZone: string): Date {
  const previous = mostRecentSlot(now, dailyAt, timeZone);
  const { hour, minute } = parseDailyAt(dailyAt);
  const nextDay = localDate(new Date(previous.getTime() + 24 * 60 * 60 * 1000), timeZone);
  return localTimeToInstant(nextDay.year, nextDay.month, nextDay.day, hour, minute, timeZone);
}

/* ── The decision ─────────────────────────────────────────────────────────── */

interface History {
  lastSuccessAt: Date | null;
  lastAttemptAt: Date | null;
  lastOutcome: ScheduleStatus['lastOutcome'];
}

async function readHistory(merchantId: string): Promise<History> {
  const [lastSuccess, lastAttempt] = await Promise.all([
    prisma.auditLog.findFirst({
      where: { merchantId, action: AUDIT_ACTIONS.BACKUP_COMPLETED },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
    prisma.auditLog.findFirst({
      where: {
        merchantId,
        action: {
          in: [
            AUDIT_ACTIONS.BACKUP_COMPLETED,
            AUDIT_ACTIONS.BACKUP_FAILED,
            AUDIT_ACTIONS.BACKUP_SKIPPED,
          ],
        },
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, action: true },
    }),
  ]);

  const outcome =
    lastAttempt?.action === AUDIT_ACTIONS.BACKUP_COMPLETED
      ? 'COMPLETED'
      : lastAttempt?.action === AUDIT_ACTIONS.BACKUP_FAILED
        ? 'FAILED'
        : lastAttempt?.action === AUDIT_ACTIONS.BACKUP_SKIPPED
          ? 'SKIPPED'
          : null;

  return {
    lastSuccessAt: lastSuccess?.createdAt ?? null,
    lastAttemptAt: lastAttempt?.createdAt ?? null,
    lastOutcome: outcome,
  };
}

/** Transactions recorded since the last successful backup — the §7.3 counter trigger. */
async function transactionsSince(merchantId: string, since: Date | null): Promise<number> {
  return prisma.transaction.count({
    where: { merchantId, ...(since ? { createdAt: { gt: since } } : {}) },
  });
}

export async function scheduleStatus(
  merchantId: string,
  now: Date = new Date(),
): Promise<ScheduleStatus> {
  const env = loadEnv();
  const merchant = await prisma.merchant.findUniqueOrThrow({
    where: { id: merchantId },
    select: { timezone: true },
  });

  const timeZone = merchant.timezone;
  const dailyAt = env.BACKUP_DAILY_AT;
  const history = await readHistory(merchantId);
  const sinceCount = await transactionsSince(merchantId, history.lastSuccessAt);
  const key = await keyStatus(merchantId);

  const decision = decide({
    now,
    enabled: env.BACKUP_SCHEDULE_ENABLED && key.backupsEnabled,
    dailyAt,
    timeZone,
    everyTransactions: env.BACKUP_EVERY_TRANSACTIONS,
    history,
    sinceCount,
    running: isBackupRunning(),
  });

  return {
    enabled: env.BACKUP_SCHEDULE_ENABLED && key.backupsEnabled,
    dailyAt,
    timeZone,
    everyTransactions: env.BACKUP_EVERY_TRANSACTIONS,
    lastSuccessAt: history.lastSuccessAt?.toISOString() ?? null,
    lastAttemptAt: history.lastAttemptAt?.toISOString() ?? null,
    lastOutcome: history.lastOutcome,
    nextRunAt: nextSlot(now, dailyAt, timeZone).toISOString(),
    transactionsSinceLastBackup: sinceCount,
    running: isBackupRunning(),
    decision,
  };
}

export function decide(input: {
  now: Date;
  enabled: boolean;
  dailyAt: string;
  timeZone: string;
  everyTransactions: number;
  history: History;
  sinceCount: number;
  running: boolean;
}): ScheduleDecision {
  if (!input.enabled) return { run: false, reason: null, skip: 'NOT_ENABLED' };

  // Yields rather than queues. The manual run in progress is doing the same work, so a
  // queued scheduled run behind it would be a second backup of the same minute.
  if (input.running) return { run: false, reason: null, skip: 'ALREADY_RUNNING' };

  const slot = mostRecentSlot(input.now, input.dailyAt, input.timeZone);
  const dailyDue = !input.history.lastSuccessAt || input.history.lastSuccessAt < slot;
  const countDue = input.sinceCount >= input.everyTransactions;

  if (!dailyDue && !countDue) return { run: false, reason: null, skip: 'NOT_DUE' };

  // Backoff is measured from the last ATTEMPT and dueness from the last SUCCESS, which
  // is the combination that retries a failure without hammering it.
  if (
    input.history.lastAttemptAt &&
    input.now.getTime() - input.history.lastAttemptAt.getTime() < RETRY_AFTER_MS &&
    input.history.lastOutcome !== 'COMPLETED'
  ) {
    return { run: false, reason: null, skip: 'BACKING_OFF' };
  }

  return { run: true, reason: dailyDue ? 'DAILY' : 'TRANSACTIONS', skip: null };
}

/* ── The loop ─────────────────────────────────────────────────────────────── */

/**
 * Runs one scheduler pass. Exported so a test can drive it without waiting for a tick.
 */
export async function tick(logger: FastifyBaseLogger, now: Date = new Date()): Promise<void> {
  const merchants = await prisma.merchant.findMany({ select: { id: true } });

  for (const { id: merchantId } of merchants) {
    try {
      const status = await scheduleStatus(merchantId, now);
      if (!status.decision.run) {
        // A collision is worth a trace; "not due" is the answer 287 times out of 288
        // in a day and would drown the log.
        if (status.decision.skip === 'ALREADY_RUNNING') {
          await recordAudit({
            merchantId,
            actorUserId: null,
            action: AUDIT_ACTIONS.BACKUP_SKIPPED,
            entityType: 'backup',
            entityId: now.toISOString(),
            after: { skip: status.decision.skip },
          });
          logger.info({ merchantId }, 'scheduled backup skipped: one already running');
        }
        continue;
      }

      logger.info({ merchantId, reason: status.decision.reason }, 'scheduled backup starting');
      const run = await runBackup({ merchantId, actorUserId: null });
      logger.info(
        { merchantId, ok: run.ok, archiveBytes: run.archiveBytes },
        'scheduled backup finished',
      );
    } catch (error) {
      // `runBackup` has already written the audit row for a refusal or a failure; this
      // keeps one merchant's problem from stopping the loop for the others, and keeps
      // the scheduler itself alive. A scheduler that dies quietly is the failure shape
      // this whole feature exists to prevent.
      logger.error({ err: error, merchantId }, 'scheduled backup failed');
    }
  }
}

/**
 * Starts the scheduler. Returns a function that stops it.
 *
 * The first pass runs shortly after boot rather than on the first tick, which is what
 * makes a missed overnight slot get covered when the shop opens instead of five minutes
 * later — and, more to the point, covered at all on a machine that is switched off every
 * night at the same time the backup was meant to run.
 */
export function startBackupScheduler(logger: FastifyBaseLogger): () => void {
  const env = loadEnv();
  if (!env.BACKUP_SCHEDULE_ENABLED) {
    logger.info('backup scheduler disabled by configuration');
    return () => {};
  }

  let stopped = false;

  const pass = () => {
    if (stopped) return;
    void tick(logger).catch((error) => logger.error({ err: error }, 'backup scheduler pass failed'));
  };

  // Late enough that migrations and the first connections are done; early enough that a
  // shop opening in the morning is covered before the first customer.
  const initial = setTimeout(pass, 30_000);
  const interval = setInterval(pass, TICK_MS);

  logger.info(
    { dailyAt: env.BACKUP_DAILY_AT, everyTransactions: env.BACKUP_EVERY_TRANSACTIONS },
    'backup scheduler started',
  );

  return () => {
    stopped = true;
    clearTimeout(initial);
    clearInterval(interval);
  };
}
