import { prisma } from '../../lib/prisma';
import { AUDIT_ACTIONS } from '../audit.service';

/**
 * Recent backup outcomes, read out of the audit trail (CLAUDE_v3.md §7.3, §12.21).
 *
 * No separate history table. Every run already writes an append-only audit row naming
 * what happened and why, and a second store would be a second thing to keep in step with
 * it — with the usual result that the screen and the trail eventually disagree about
 * whether last Tuesday's backup happened.
 *
 * What this exists to make visible is the quiet failure, not the loud one. A backup that
 * errored is a red row a manager can see. A backup that **stopped being attempted**
 * three months ago produces nothing at all, and is the shape this product keeps meeting:
 * §12.15's full disk, §12.19's unrecoverable archives, the agent that captured nothing
 * for days while reporting healthy. So the screen shows dates and gaps, not just errors.
 */

export type BackupOutcome = 'COMPLETED' | 'FAILED' | 'SKIPPED';

export interface BackupHistoryEntry {
  at: string;
  outcome: BackupOutcome;
  /** The archive name, or the tick's timestamp for a skip. */
  name: string;
  /** Null for a scheduled run — there was no human behind it. */
  actorName: string | null;
  archiveBytes: number | null;
  /** Per-destination results, when the run got far enough to have any. */
  destinations: Array<{ kind: string; ok: boolean; error?: string }>;
  error: string | null;
  /** True when the run was refused for want of disk (§12.18). */
  outOfSpace: boolean;
}

export interface VerificationEntry {
  at: string;
  name: string;
  ok: boolean;
  verifiedFrom: string | null;
  actorName: string | null;
  failure: string | null;
  counts: { customers: number; transactions: number } | null;
}

export interface BackupHistory {
  runs: BackupHistoryEntry[];
  /**
   * The last restore test, passed or failed — §7.3 asks for one monthly.
   *
   * Both outcomes, because a failed test is the one result a merchant must not miss; it
   * used to read as «never tested», which is worse than silence.
   */
  lastVerification: VerificationEntry | null;
}

/** `{customers, transactions}` out of an audit payload, or null if it is not that shape. */
function readCounts(value: unknown): VerificationEntry['counts'] {
  if (!value || typeof value !== 'object') return null;
  const { customers, transactions } = value as Record<string, unknown>;
  return typeof customers === 'number' && typeof transactions === 'number'
    ? { customers, transactions }
    : null;
}

const OUTCOME_BY_ACTION: Record<string, BackupOutcome> = {
  [AUDIT_ACTIONS.BACKUP_COMPLETED]: 'COMPLETED',
  [AUDIT_ACTIONS.BACKUP_FAILED]: 'FAILED',
  [AUDIT_ACTIONS.BACKUP_SKIPPED]: 'SKIPPED',
};

/** Parses an audit row's `afterJson` without letting a malformed one break the screen. */
function readPayload(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    // An unreadable payload is not worth failing the request over — the row's action and
    // timestamp still answer the question the manager came here with.
    return {};
  }
}

function verificationEntry(row: {
  createdAt: Date;
  entityId: string;
  action: string;
  afterJson: string | null;
  actor: { name: string } | null;
}): VerificationEntry {
  const payload = readPayload(row.afterJson);
  return {
    at: row.createdAt.toISOString(),
    name: row.entityId,
    ok: row.action === AUDIT_ACTIONS.BACKUP_VERIFIED,
    verifiedFrom: typeof payload.verifiedFrom === 'string' ? payload.verifiedFrom : null,
    actorName: row.actor?.name ?? null,
    failure: typeof payload.failure === 'string' ? payload.failure : null,
    counts: readCounts(payload.counts),
  };
}

export async function recentBackupHistory(
  merchantId: string,
  limit = 20,
): Promise<BackupHistory> {
  const [rows, verification] = await Promise.all([
    prisma.auditLog.findMany({
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
      take: limit,
      include: { actor: { select: { name: true } } },
    }),
    prisma.auditLog.findFirst({
      where: {
        merchantId,
        action: { in: [AUDIT_ACTIONS.BACKUP_VERIFIED, AUDIT_ACTIONS.BACKUP_VERIFY_FAILED] },
      },
      orderBy: { createdAt: 'desc' },
      include: { actor: { select: { name: true } } },
    }),
  ]);

  const runs = rows.map((row): BackupHistoryEntry => {
    const payload = readPayload(row.afterJson);
    const destinations = Array.isArray(payload.destinations)
      ? (payload.destinations as Array<{ kind: string; ok: boolean; error?: string }>)
      : [];

    return {
      at: row.createdAt.toISOString(),
      outcome: OUTCOME_BY_ACTION[row.action] ?? 'FAILED',
      name: row.entityId,
      actorName: row.actor?.name ?? null,
      archiveBytes: typeof payload.archiveBytes === 'number' ? payload.archiveBytes : null,
      destinations,
      error: typeof payload.error === 'string' ? payload.error : null,
      outOfSpace: payload.outOfSpace === true,
    };
  });

  return {
    runs,
    lastVerification: verification ? verificationEntry(verification) : null,
  };
}
