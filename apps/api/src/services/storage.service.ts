import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { StorageLevel, StorageStatus } from '@loyalty-pro/shared-types';
import { loadEnv } from '../config/env';
import { liveDatabasePath, resolveDataDir } from '../config/paths';
import { prisma } from '../lib/prisma';
import { AUDIT_ACTIONS, recordAudit } from './audit.service';
import { publish } from './realtime.service';

/**
 * Free space on the volume that holds the database (docs/legacy/CLAUDE_v3.md §12.15).
 *
 * §12.15 set the thresholds and named the failure: below roughly 2 GB free, Windows
 * itself starts failing in ways that look like application bugs, and SQLite starts
 * refusing writes. The refusal is quiet — reads keep working, so the manager's screens
 * render normally while every scan at the till errors — which is why §12.16 exists.
 *
 * This module is the other half of that answer. §12.16 makes the failure visible *at the
 * moment it happens*; this makes it visible *before* it happens, while clearing a few
 * gigabytes of old installers is still a five-minute job rather than an incident.
 *
 * Four properties shape it.
 *
 * **The verdict is sticky near an edge.** A volume sitting at exactly 5 GB must not
 * oscillate between OK and WARN as Windows writes and deletes temporary files; a banner
 * that appears and disappears every minute is one the merchant learns to ignore, which
 * costs more than showing nothing at all. Hence the re-arm margin below.
 *
 * **Getting worse is immediate; getting better has to be earned.** The margin applies
 * only when the reading improves. A disk that has just fallen below 2 GB is CRITICAL on
 * that sample, not on the one after next — the cost of a late alarm is the outage, and
 * the cost of an early all-clear is only a banner that lingers a little longer.
 *
 * **A volume that cannot be measured is UNKNOWN, never OK.** Reporting an unreadable
 * path as healthy is the exact shape of the bug this project keeps meeting: the agent
 * that reported healthy and captured nothing (§12.15), the archives that looked fine and
 * could not be opened (§12.19).
 *
 * **Events fire on change; readings are pulled on demand.** Broadcasting every sample
 * would be a heartbeat nobody reads. But a dashboard opened five minutes after a change
 * would then never learn of it — so `GET /system/storage` answers for the present and
 * the event announces the transition. Neither alone is sufficient.
 */

const GIB = 1024 ** 3;

/** §12.15: WARN below 5 GB. */
export const WARN_FREE_BYTES = 5 * GIB;

/**
 * §12.15: CRITICAL below 2 GB.
 *
 * Also the absolute floor beneath which no backup is attempted — `backup/snapshot.ts`
 * imports this rather than restating it, so the number governing the install gate, the
 * banner and the backup refusal is one number in one place.
 */
export const CRITICAL_FREE_BYTES = 2 * GIB;

/**
 * How far above an edge a volume must climb before the better verdict is granted.
 *
 * §12.15: "re-arming about 20% above each edge so a volume sitting on a boundary does
 * not flap" — back to WARN at 2.4 GB, back to OK at 6 GB.
 */
const REARM_FACTOR = 1.2;

/** How often the sampler wakes. One syscall, so the cost is the log line it might write. */
const SAMPLE_INTERVAL_MS = 60_000;

/**
 * How stale a cached reading may be before a reader takes its own.
 *
 * The sampler is the *push* mechanism, and a reader must not depend on it being alive:
 * if it ever stops, the manager's own screen still shows the truth rather than the last
 * thing the sampler happened to see before it died.
 */
const MAX_CACHE_AGE_MS = 2 * SAMPLE_INTERVAL_MS;

/** Worst to best. The index is the ladder the hysteresis climbs. */
const LADDER = ['CRITICAL', 'WARN', 'OK'] as const;
type MeasuredLevel = (typeof LADDER)[number];

/** The bar a volume must clear to leave a level upward. */
const REARM_BAR: Record<'CRITICAL' | 'WARN', number> = {
  CRITICAL: CRITICAL_FREE_BYTES * REARM_FACTOR,
  WARN: WARN_FREE_BYTES * REARM_FACTOR,
};

/** The verdict on a reading taken in isolation, ignoring where the volume has been. */
function rawLevel(freeBytes: number): MeasuredLevel {
  if (freeBytes < CRITICAL_FREE_BYTES) return 'CRITICAL';
  if (freeBytes < WARN_FREE_BYTES) return 'WARN';
  return 'OK';
}

/**
 * The verdict on a reading, given the verdict before it.
 *
 * Pure, and exported for its own tests: hysteresis is the part of this module where a
 * mistake is invisible in normal operation and shows up only as a banner that flickers
 * — or worse, one that clears itself while the disk is still nearly full.
 */
export function classify(freeBytes: number, previous: StorageLevel): StorageLevel {
  const raw = rawLevel(freeBytes);

  // No history to be sticky about. A first reading — or the first after a failed one —
  // is taken at face value.
  if (previous === 'UNKNOWN') return raw;

  const from = LADDER.indexOf(previous as MeasuredLevel);
  const to = LADDER.indexOf(raw);

  // Unchanged, or worse. Adopted at once, with no margin to clear.
  if (to <= from) return raw;

  // Improving. Climb one rung at a time and stop at the first bar not cleared, so a
  // volume that jumps from CRITICAL past both edges reaches OK in one sample while one
  // that has merely crept over 2 GB does not.
  let level: MeasuredLevel = LADDER[from]!;
  for (let rung = from; rung < to; rung += 1) {
    const leaving = LADDER[rung] as 'CRITICAL' | 'WARN';
    if (freeBytes < REARM_BAR[leaving]) break;
    level = LADDER[rung + 1]!;
  }
  return level;
}

/**
 * The directory whose volume is measured.
 *
 * The live database, because that is the file whose failure to write is the outage.
 * Backups may target a different volume and are gated separately in `snapshot.ts`; this
 * banner speaks for the one drive that stops the till.
 */
export function monitoredPath(): string {
  const databasePath = liveDatabasePath(loadEnv().DATABASE_URL);
  return databasePath ? dirname(databasePath) : resolveDataDir();
}

/** Free and total bytes on the volume holding `path`. Throws if it cannot be read. */
export function readFreeSpace(path: string): { freeBytes: number; totalBytes: number } {
  const stats = statfsSync(path);
  // `bavail` rather than `bfree`: blocks reserved for root are not space this service can
  // use, and counting them would overstate the headroom on exactly the volume where
  // overstating it is the whole problem.
  return {
    freeBytes: Number(stats.bavail) * Number(stats.bsize),
    totalBytes: Number(stats.blocks) * Number(stats.bsize),
  };
}

let current: StorageStatus | null = null;

/**
 * The last verdict, without taking a new reading. Null before the first sample.
 *
 * Synchronous on purpose: the error handler uses it to tell a full disk from a
 * permissions fault while it is answering a failed write, and must not start disk I/O
 * of its own on a volume that has just refused some.
 */
export function lastStorageLevel(): StorageLevel | null {
  return current?.level ?? null;
}

export interface SampleOptions {
  logger?: FastifyBaseLogger;
  /**
   * Where to measure, and how.
   *
   * Production passes neither: the volume is the one holding the database, measured by
   * `statfsSync`. Tests substitute a reader so the state machine can be walked across
   * thresholds that would otherwise require actually filling a disk — the same seam
   * `takeSnapshot` opens for its Prisma client, and for the same reason.
   */
  path?: string;
  read?: (path: string) => { freeBytes: number; totalBytes: number };
}

/**
 * Takes a reading, announces a transition if the verdict changed, and returns it.
 *
 * Never throws. It is called from an HTTP handler and from a timer, and neither has any
 * use for an exception: a reading that cannot be taken IS the result, reported as
 * UNKNOWN.
 */
export async function sample(options: SampleOptions = {}): Promise<StorageStatus> {
  const { logger, read = readFreeSpace } = options;
  const path = options.path ?? monitoredPath();
  const previous: StorageLevel = current?.level ?? 'UNKNOWN';
  const sampledAt = new Date().toISOString();

  let next: StorageStatus;
  try {
    const { freeBytes, totalBytes } = read(path);
    next = {
      level: classify(freeBytes, previous),
      freeBytes,
      totalBytes,
      path,
      sampledAt,
      error: null,
    };
  } catch (error) {
    next = {
      level: 'UNKNOWN',
      freeBytes: null,
      totalBytes: null,
      path,
      sampledAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  current = next;
  if (isNews(previous, next.level)) await announce(previous, next, logger);
  return next;
}

/**
 * Whether a change of verdict is worth announcing.
 *
 * Every change is, with one exception: **UNKNOWN → OK is not news.** That is the first
 * reading after boot on a healthy machine, and treating it as a transition would put a
 * "storage level changed" row in the audit trail on every single service start — which
 * is how a trail stops being read. Going from "we had not measured" to "it is fine" says
 * nothing that the absence of a warning does not already say.
 *
 * UNKNOWN → WARN and UNKNOWN → CRITICAL still announce, because a machine that boots
 * already in trouble should say so on its first pass rather than sixty seconds later.
 */
function isNews(previous: StorageLevel, next: StorageLevel): boolean {
  if (previous === next) return false;
  return !(previous === 'UNKNOWN' && next === 'OK');
}

/**
 * The present reading.
 *
 * Serves the cached one while it is fresh and takes its own when it is not — see
 * `MAX_CACHE_AGE_MS`. `sampledAt` travels with it either way, so a caller can always see
 * how old the answer is rather than having to trust that something is still ticking.
 */
export async function currentStorageStatus(): Promise<StorageStatus> {
  if (current && Date.now() - Date.parse(current.sampledAt) < MAX_CACHE_AGE_MS) {
    return current;
  }
  return sample();
}

/**
 * Publishes and records a change of verdict.
 *
 * Both halves are best-effort and neither can fail a sample. The audit write is the
 * pointed one: it goes to the database on the volume this function is reporting about,
 * so the case it most wants to record — CRITICAL — is the case where the write may be
 * refused. That is not a reason to skip it. It succeeds for every WARN, it succeeds for
 * the CRITICAL that arrives with a few hundred megabytes still free, and when it does
 * fail the log line is still written.
 *
 * The row exists at all because a disk that filled at 02:00 and was cleared by 08:00
 * otherwise leaves no trace whatsoever, and "this has happened twice this month" is the
 * fact that turns a shrug into a bigger drive.
 */
async function announce(
  previous: StorageLevel,
  status: StorageStatus,
  logger?: FastifyBaseLogger,
): Promise<void> {
  const detail = {
    previousLevel: previous,
    level: status.level,
    freeBytes: status.freeBytes,
    path: status.path,
    ...(status.error ? { err: status.error } : {}),
  };

  if (status.level === 'CRITICAL') logger?.error(detail, 'free disk space is critical');
  else if (status.level === 'WARN') logger?.warn(detail, 'free disk space is low');
  else if (status.level === 'UNKNOWN') logger?.warn(detail, 'free disk space could not be read');
  else logger?.info(detail, 'free disk space recovered');

  let merchants: Array<{ id: string }>;
  try {
    merchants = await prisma.merchant.findMany({ select: { id: true } });
  } catch (error) {
    logger?.error({ err: error }, 'could not announce the storage level');
    return;
  }

  // A machine-wide fact on a per-merchant channel: every merchant on this installation
  // shares the one volume, so every one of them hears about it. `publish` never throws.
  for (const { id } of merchants) {
    publish(id, {
      type: 'STORAGE_LEVEL_CHANGED',
      level: status.level,
      previousLevel: previous,
      freeBytes: status.freeBytes,
      path: status.path,
      at: status.sampledAt,
    });
  }

  for (const { id } of merchants) {
    try {
      await recordAudit({
        merchantId: id,
        actorUserId: null,
        action: AUDIT_ACTIONS.STORAGE_LEVEL_CHANGED,
        entityType: 'storage',
        entityId: status.path,
        before: { level: previous },
        after: { level: status.level, freeBytes: status.freeBytes },
      });
    } catch (error) {
      logger?.error({ err: error, merchantId: id }, 'could not record the storage level change');
    }
  }
}

/**
 * Starts the sampler. Returns a function that stops it.
 *
 * The first reading is taken immediately rather than after a delay: a machine that boots
 * with a full disk should say so at once. Nothing is subscribed to the socket that early,
 * so that first transition reaches no client — which is precisely why the endpoint exists
 * and why a client reads it once on connect instead of relying on the push alone.
 */
export function startStorageSampler(logger: FastifyBaseLogger): () => void {
  let stopped = false;

  const pass = (): void => {
    if (stopped) return;
    // `sample` does not throw, but a rejected promise here would be unhandled and take
    // the process down under Node's default policy. The guard costs nothing.
    void sample({ logger }).catch((error: unknown) => {
      logger.error({ err: error }, 'storage sample failed');
    });
  };

  // Announced before the first pass, so a log being read after an incident shows the
  // sampler starting and then what it found, rather than a verdict from a sampler that
  // appears not to have started yet.
  logger.info({ path: monitoredPath(), intervalMs: SAMPLE_INTERVAL_MS }, 'free space sampler started');

  pass();
  const interval = setInterval(pass, SAMPLE_INTERVAL_MS);

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

/** Clears the remembered verdict, so hysteresis cannot leak from one test into the next. */
export function resetStorageState(): void {
  current = null;
}
