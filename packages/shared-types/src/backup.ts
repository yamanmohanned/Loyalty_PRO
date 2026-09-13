/**
 * Backup and key-ceremony contracts (CLAUDE_v3.md §12.27).
 *
 * The manager app carried its own copy of every shape in this file, including
 * `KeyStatus` — the one that decides whether a shop's backups are openable at all.
 * A client and a server disagreeing about that shape is not a rendering bug; it is
 * a manager being told the ceremony is done when it is not.
 */

/** One archive sitting in one destination. */
export interface StoredBackup {
  id: string;
  name: string;
  bytes: number;
  createdAt: string;
}

/**
 * A destination and what it currently holds.
 *
 * `available: false` is normal, not a failure: 3-2-1 means the USB stick is out of
 * the machine most of the day and the internet drops for an hour (§12.18).
 */
export interface DestinationListing {
  kind: string;
  label: string;
  available: boolean;
  backups: StoredBackup[];
}

export type BackupOutcome = 'COMPLETED' | 'FAILED' | 'SKIPPED';

export interface ScheduleStatus {
  enabled: boolean;
  dailyAt: string;
  timeZone: string;
  everyTransactions: number;
  lastSuccessAt: string | null;
  lastOutcome: BackupOutcome | null;
  nextRunAt: string | null;
  transactionsSinceLastBackup: number;
  running: boolean;
}

/**
 * One row of backup history, including the ones where nothing happened.
 *
 * Skips are recorded too. The failure shape this product keeps meeting is the quiet
 * one, and every instance of it was invisible because absence and "working fine"
 * looked identical (§12.21).
 */
export interface HistoryEntry {
  at: string;
  outcome: BackupOutcome;
  name: string;
  actorName: string | null;
  archiveBytes: number | null;
  destinations: Array<{ kind: string; ok: boolean; error?: string }>;
  error: string | null;
  outOfSpace: boolean;
}

/**
 * Where the encryption key stands (§12.19).
 *
 * `confirmed` is bound to one specific key's fingerprint, never a boolean flag:
 * replace the key and the new fingerprint has no confirming row, so the ceremony
 * reopens and backups stop. A flag would go on vouching for a key nobody had ever
 * written down.
 */
export interface KeyStatus {
  /** A key exists in the configuration. */
  configured: boolean;
  /** Safe to display and log; identifies the key without disclosing it. */
  fingerprint: string | null;
  confirmed: boolean;
  confirmedAt: string | null;
  /** The manager who confirmed, for the audit answer "who has it". */
  confirmedBy: string | null;
  /**
   * Whether backups may run. False until a human has proved they hold the key
   * somewhere other than this machine.
   */
  backupsEnabled: boolean;
  /** True once ANY key has been confirmed — a first run and a replaced key differ. */
  everConfirmed: boolean;
}

export interface BackupOverview {
  key: KeyStatus;
  destinations: DestinationListing[];
  schedule: ScheduleStatus;
  history: {
    runs: HistoryEntry[];
    /**
     * The most recent restore test, passed OR failed. Null only when none has ever run.
     *
     * It used to record passes only, so a failed test left the screen reading «لم يُجرَ
     * اختبار استعادة بعد» — hiding exactly the result a merchant most needed to see.
     */
    lastVerification: {
      at: string;
      /** The archive the test took and restored. */
      name: string;
      ok: boolean;
      /** Which destination the copy was fetched back from; null if none received it. */
      verifiedFrom: string | null;
      actorName: string | null;
      /** Why it failed, in Arabic, naming the remedy. Null on a pass. */
      failure: string | null;
      /** What the restored copy held — the merchant's check that it is his shop. */
      counts: { customers: number; transactions: number } | null;
    } | null;
  };
}

/**
 * The result of a restore test.
 *
 * `recencyProven` is the §12.17 sentinel check: an audit row is written BEFORE the
 * backup it verifies and searched for in the restored copy, so a backup that
 * silently restores an older day fails instead of passing.
 */
export interface VerificationResult {
  ok: boolean;
  recencyProven: boolean;
  /** Null when the test failed before any destination received the copy. */
  verifiedFrom: string | null;
  failure?: string;
  /** Null when the test failed before the copy could be opened. */
  restore: {
    integrity: string;
    counts: { customers: number; transactions: number };
  } | null;
}
