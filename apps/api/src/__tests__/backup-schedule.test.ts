import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../config/env';
import { AUDIT_ACTIONS, recordAudit } from '../services/audit.service';
import { runBackup } from '../services/backup/backup.service';
import { LocalDirectoryDestination } from '../services/backup/destinations';
import { confirmKey } from '../services/backup/key-ceremony.service';
import { recentBackupHistory } from '../services/backup/history.service';
import {
  decide,
  mostRecentSlot,
  nextSlot,
  parseDailyAt,
  scheduleStatus,
} from '../services/backup/schedule.service';
import { resetDatabase } from './helpers/db';
import { createWorld, type World } from './helpers/fixtures';

/**
 * Scheduled backups (docs/legacy/CLAUDE_v3.md §7.3, §12.21).
 *
 * The requirement that shapes this suite is not "fires at 23:30". It is **a missed run
 * happens late rather than disappearing** — a till switched off overnight is normal, and
 * a scheduler that only fires while the machine is awake would back up nothing at all
 * for a shop that closes before its own backup time. So most of what is tested here is
 * the decision, at instants chosen to be awkward.
 */

const prisma = new PrismaClient();
const scratch: string[] = [];
let world: World;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

const BAGHDAD = 'Asia/Baghdad';

beforeEach(async () => {
  await resetDatabase(prisma);
  world = await createWorld(prisma);
  await confirmKey(world.merchantId, world.ownerId, loadEnv().BACKUP_KEY!);
});

afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
  await prisma.$disconnect();
});

const history = (over: Partial<Parameters<typeof decide>[0]['history']> = {}) => ({
  lastSuccessAt: null,
  lastAttemptAt: null,
  lastOutcome: null,
  ...over,
});

const input = (over: Partial<Parameters<typeof decide>[0]> = {}) => ({
  now: new Date('2026-08-30T21:00:00Z'),
  enabled: true,
  dailyAt: '23:30',
  timeZone: BAGHDAD,
  everyTransactions: 500,
  history: history(),
  sinceCount: 0,
  running: false,
  ...over,
});

/* ── Local time ───────────────────────────────────────────────────────────── */

describe('the daily slot', () => {
  it('is computed in the merchant’s timezone, not UTC', () => {
    // 23:30 in Baghdad (UTC+3) is 20:30 UTC. A UTC-based schedule would fire at 02:30
    // local — the middle of the night on the wrong day, which is the same class of
    // mistake CLAUDE.md §13.1 corrected for period bucketing.
    const slot = mostRecentSlot(new Date('2026-08-30T22:00:00Z'), '23:30', BAGHDAD);
    expect(slot.toISOString()).toBe('2026-08-30T20:30:00.000Z');
  });

  it('reaches back to yesterday when today’s slot has not arrived', () => {
    // 09:00 Baghdad on the 31st is before that evening's 23:30, so the most recent slot
    // is the 30th's — which is exactly the slot a shop that closed at nine missed.
    const slot = mostRecentSlot(new Date('2026-08-31T06:00:00Z'), '23:30', BAGHDAD);
    expect(slot.toISOString()).toBe('2026-08-30T20:30:00.000Z');
  });

  it('reports the next slot as the following day’s', () => {
    const next = nextSlot(new Date('2026-08-30T22:00:00Z'), '23:30', BAGHDAD);
    expect(next.toISOString()).toBe('2026-08-31T20:30:00.000Z');
  });

  it('rejects a time that is not one', () => {
    expect(() => parseDailyAt('25:00')).toThrow();
    expect(() => parseDailyAt('7:5')).toThrow();
    expect(parseDailyAt('00:00')).toEqual({ hour: 0, minute: 0 });
  });
});

/* ── The decision ─────────────────────────────────────────────────────────── */

describe('deciding whether to run', () => {
  it('runs when no backup has ever been taken', () => {
    expect(decide(input())).toMatchObject({ run: true, reason: 'DAILY' });
  });

  it('does not run again once the slot is covered', () => {
    const covered = decide(
      input({
        now: new Date('2026-08-30T22:00:00Z'),
        history: history({
          lastSuccessAt: new Date('2026-08-30T20:35:00Z'),
          lastAttemptAt: new Date('2026-08-30T20:35:00Z'),
          lastOutcome: 'COMPLETED',
        }),
      }),
    );
    expect(covered).toMatchObject({ run: false, skip: 'NOT_DUE' });
  });

  it('CATCHES UP a slot missed while the machine was off', () => {
    // The shop closes at 21:00 and the PC goes off with it; the 23:30 backup never
    // happens. At 09:00 the next morning the machine comes back on.
    //
    // This is the requirement in one assertion: the run is late, not lost.
    const morningAfter = decide(
      input({
        now: new Date('2026-08-31T06:00:00Z'),
        history: history({
          lastSuccessAt: new Date('2026-08-29T20:35:00Z'),
          lastAttemptAt: new Date('2026-08-29T20:35:00Z'),
          lastOutcome: 'COMPLETED',
        }),
      }),
    );
    expect(morningAfter).toMatchObject({ run: true, reason: 'DAILY' });
  });

  it('runs on the transaction counter even when the daily slot is covered', () => {
    const busy = decide(
      input({
        now: new Date('2026-08-30T22:00:00Z'),
        history: history({
          lastSuccessAt: new Date('2026-08-30T20:35:00Z'),
          lastAttemptAt: new Date('2026-08-30T20:35:00Z'),
          lastOutcome: 'COMPLETED',
        }),
        sinceCount: 500,
      }),
    );
    expect(busy).toMatchObject({ run: true, reason: 'TRANSACTIONS' });
  });

  it('yields to a run already in progress rather than queueing behind it', () => {
    expect(decide(input({ running: true }))).toMatchObject({
      run: false,
      skip: 'ALREADY_RUNNING',
    });
  });

  it('backs off after a failure instead of retrying every tick', () => {
    // A full disk would otherwise be retried every five minutes, each attempt doing a
    // VACUUM INTO on a volume with no room for it (§12.18).
    const justFailed = decide(
      input({
        now: new Date('2026-08-30T21:00:00Z'),
        history: history({
          lastSuccessAt: null,
          lastAttemptAt: new Date('2026-08-30T20:50:00Z'),
          lastOutcome: 'FAILED',
        }),
      }),
    );
    expect(justFailed).toMatchObject({ run: false, skip: 'BACKING_OFF' });
  });

  it('retries once the backoff has passed', () => {
    const later = decide(
      input({
        now: new Date('2026-08-30T21:40:00Z'),
        history: history({
          lastSuccessAt: null,
          lastAttemptAt: new Date('2026-08-30T20:50:00Z'),
          lastOutcome: 'FAILED',
        }),
      }),
    );
    expect(later).toMatchObject({ run: true });
  });

  it('does not run while the key ceremony is outstanding', () => {
    expect(decide(input({ enabled: false }))).toMatchObject({
      run: false,
      skip: 'NOT_ENABLED',
    });
  });
});

/* ── Against the database ─────────────────────────────────────────────────── */

describe('schedule status', () => {
  it('reports the schedule, the counter and what it would do', async () => {
    const status = await scheduleStatus(world.merchantId, new Date('2026-08-30T22:00:00Z'));

    expect(status.enabled).toBe(true);
    expect(status.timeZone).toBe(BAGHDAD);
    expect(status.dailyAt).toBe(loadEnv().BACKUP_DAILY_AT);
    expect(status.lastSuccessAt).toBeNull();
    expect(status.nextRunAt).toBe('2026-08-31T20:30:00.000Z');
    // Never backed up, so the most recent slot is uncovered.
    expect(status.decision.run).toBe(true);
  });

  it('is disabled while the key is unconfirmed, whatever the clock says', async () => {
    await prisma.auditLog.deleteMany({ where: { action: AUDIT_ACTIONS.BACKUP_KEY_CONFIRMED } });

    const status = await scheduleStatus(world.merchantId);
    expect(status.enabled).toBe(false);
    expect(status.decision.skip).toBe('NOT_ENABLED');
  });

  it('counts transactions since the last successful backup, not since forever', async () => {
    const destination = new LocalDirectoryDestination('local', tempDir('walaa-sch-'), 'محلي');
    await runBackup({ merchantId: world.merchantId, actorUserId: world.ownerId }, [destination]);

    const after = await scheduleStatus(world.merchantId);
    expect(after.lastSuccessAt).toBeTruthy();
    // The fixture's transactions predate the backup, so the counter starts clean.
    expect(after.transactionsSinceLastBackup).toBe(0);
  });
});

/* ── What the manager sees ────────────────────────────────────────────────── */

describe('the history the Backup screen reads', () => {
  it('records a successful run with its destinations', async () => {
    const destination = new LocalDirectoryDestination('local', tempDir('walaa-hist-'), 'محلي');
    const run = await runBackup(
      { merchantId: world.merchantId, actorUserId: world.ownerId },
      [destination],
    );

    const { runs } = await recentBackupHistory(world.merchantId);
    expect(runs[0]).toMatchObject({
      outcome: 'COMPLETED',
      name: run.name,
      actorName: expect.any(String),
    });
    expect(runs[0]?.destinations[0]).toMatchObject({ kind: 'local', ok: true });
  });

  it('distinguishes a scheduled run from a manual one by the absence of an actor', async () => {
    const destination = new LocalDirectoryDestination('local', tempDir('walaa-hist-'), 'محلي');
    await runBackup({ merchantId: world.merchantId, actorUserId: null }, [destination]);

    const { runs } = await recentBackupHistory(world.merchantId);
    // Null means nobody pressed anything — which is how the screen can show "scheduled"
    // rather than attributing a nightly run to whoever last logged in.
    expect(runs[0]?.actorName).toBeNull();
  });

  it('surfaces a skip, so a gap is never explained only by absence', async () => {
    await recordAudit({
      merchantId: world.merchantId,
      actorUserId: null,
      action: AUDIT_ACTIONS.BACKUP_SKIPPED,
      entityType: 'backup',
      entityId: new Date().toISOString(),
      after: { skip: 'ALREADY_RUNNING' },
    });

    const { runs } = await recentBackupHistory(world.merchantId);
    expect(runs[0]?.outcome).toBe('SKIPPED');
  });

  it('reports the last proven restore, which is what §7.3 asks for monthly', async () => {
    const before = await recentBackupHistory(world.merchantId);
    expect(before.lastVerification).toBeNull();

    await recordAudit({
      merchantId: world.merchantId,
      actorUserId: world.ownerId,
      action: AUDIT_ACTIONS.BACKUP_VERIFIED,
      entityType: 'backup',
      entityId: 'walaa-test.walaabk',
      after: { verifiedFrom: 'local' },
    });

    const after = await recentBackupHistory(world.merchantId);
    expect(after.lastVerification).toMatchObject({ verifiedFrom: 'local' });
  });

  it('survives an unreadable payload rather than failing the screen', async () => {
    await prisma.auditLog.create({
      data: {
        merchantId: world.merchantId,
        actorUserId: null,
        action: AUDIT_ACTIONS.BACKUP_FAILED,
        entityType: 'backup',
        entityId: 'broken',
        afterJson: '{not json',
      },
    });

    const { runs } = await recentBackupHistory(world.merchantId);
    // The action and the timestamp still answer the question the manager arrived with.
    expect(runs[0]).toMatchObject({ outcome: 'FAILED', name: 'broken' });
  });
});

/* ── The lock ─────────────────────────────────────────────────────────────── */

describe('two backups at once', () => {
  it('refuses the second rather than letting them share a staging directory', async () => {
    const a = new LocalDirectoryDestination('local', tempDir('walaa-lock-a-'), 'أ');
    const b = new LocalDirectoryDestination('local', tempDir('walaa-lock-b-'), 'ب');

    const context = { merchantId: world.merchantId, actorUserId: world.ownerId };
    const [first, second] = await Promise.allSettled([
      runBackup(context, [a]),
      runBackup(context, [b]),
    ]);

    // They share a snapshot filename and a VACUUM INTO destination; running together,
    // the second would delete the first's snapshot out from under it.
    const outcomes = [first.status, second.status].sort();
    expect(outcomes).toEqual(['fulfilled', 'rejected']);
  });
});
