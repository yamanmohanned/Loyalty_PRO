/**
 * Google Drive backup contracts (CLAUDE.md §7 / CLAUDE_v3.md §7.3).
 *
 * Drive is a **destination**, not a second backup path. The bytes it receives are the
 * same AES-256-GCM archive the local copy already holds, produced by the same
 * `archive.ts` and openable only with the same ceremony key. Nothing in this contract
 * describes a plaintext route off the machine, and nothing ever should.
 *
 * ## Why the failure has a code and not just a sentence
 *
 * Five different things go wrong with a cloud destination — the shop's internet is
 * down, the owner revoked the grant from their Google account page, the Drive is
 * full, the refresh token lapsed, somebody pressed "disconnect" — and each one has a
 * different remedy. A single «فشل الرفع إلى Google Drive» sends a merchant to reboot
 * the router when the real answer is "your Drive is full", and he learns to ignore
 * the message. So the server classifies, and the screen renders the sentence and the
 * remedy that belong to that classification.
 */

/**
 * Why Drive is not currently working.
 *
 * `NOT_CONFIGURED` and `NOT_CONNECTED` are states, not errors: a shop that has never
 * set Drive up is in an ordinary, correct condition and the screen says so calmly.
 */
export type DriveFailureCode =
  /** No OAuth client in the configuration — Drive was never set up on this machine. */
  | 'NOT_CONFIGURED'
  /** Configured, but no account has granted access yet, or somebody disconnected it. */
  | 'NOT_CONNECTED'
  /** The machine could not reach Google at all: DNS, refused connection, timeout, TLS. */
  | 'NETWORK'
  /** The grant was withdrawn — from the Google account's permissions page, usually. */
  | 'REVOKED'
  /** The refresh token lapsed. A test-mode OAuth client expires them after seven days. */
  | 'EXPIRED'
  /** The OAuth client id/secret is wrong or was deleted in the Google Cloud console. */
  | 'AUTH_CLIENT'
  /** The Drive account is out of space, or Google is rate-limiting this client. */
  | 'QUOTA'
  /** Authenticated, but not allowed to touch that file — `drive.file` sees only its own. */
  | 'PERMISSION'
  /** Google answered with something this code does not recognise. Detail is in the log. */
  | 'UNKNOWN';

/**
 * A classified failure, ready to render.
 *
 * `message` says what happened and `remedy` says what to do — both merchant-facing
 * Arabic. There is deliberately no field here for an HTTP status, a Google error code
 * or a stack: those go to the service log (§7.6), never to the screen.
 */
export interface DriveFailure {
  code: DriveFailureCode;
  message: string;
  remedy: string;
  /** When this was last observed. */
  at: string;
}

/** What the Settings panel needs, in one call. */
export interface DriveStatus {
  /** An OAuth client id and secret exist in the configuration. */
  configured: boolean;
  /** A refresh token is stored (encrypted) and Drive is registered as a destination. */
  connected: boolean;
  /** The merchant can switch Drive off without discarding the grant. */
  enabled: boolean;
  /** When the grant was completed. */
  connectedAt: string | null;
  /** The last upload that actually landed in Drive — the number that answers "is this working". */
  lastSuccessAt: string | null;
  /** The last time an upload was attempted, successful or not. */
  lastAttemptAt: string | null;
  /** Why it is not working, when it is not. Null when Drive is healthy. */
  failure: DriveFailure | null;
  /** How many archives Drive keeps before the oldest is deleted. */
  keep: number;
  /** A folder this app created, or null for the account root. */
  folderId: string | null;
  /** Archives currently in Drive, newest first. Empty when Drive is unreachable. */
  backups: Array<{ id: string; name: string; bytes: number; createdAt: string }>;
  /** The schedule that drives Drive uploads — the same one the local copy runs on. */
  schedule: {
    enabled: boolean;
    dailyAt: string;
    timeZone: string;
    everyTransactions: number;
    nextRunAt: string | null;
  };
  /** The exact scope this build asks Google for, shown so it can be checked against consent. */
  scope: string;
}

/** The authorisation URL a person must open, and how long it stays valid. */
export interface DriveConnectStart {
  authUrl: string;
  redirectUri: string;
  expiresAt: string;
}

/** Where the pending consent has got to. Polled while the browser tab is open. */
export interface DriveConnectProgress {
  state: 'IDLE' | 'WAITING' | 'CONNECTED' | 'FAILED';
  failure: DriveFailure | null;
}

/** What the merchant may change without reconnecting. */
export interface DriveSettingsUpdate {
  enabled?: boolean;
  keep?: number;
}
