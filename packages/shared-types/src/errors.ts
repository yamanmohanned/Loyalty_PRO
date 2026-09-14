import { z } from 'zod';

/**
 * One error envelope for the whole API (CLAUDE.md §9). Every non-2xx response is
 * this shape — clients branch on `code`, never on a parsed message string.
 */

export const ApiErrorCodeSchema = z.enum([
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'TOKEN_EXPIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  /** The idempotency guard fired: this invoice is already linked (CLAUDE.md §0.2). */
  'DUPLICATE_INVOICE',
  /** A coupon was redeemed twice, or redeemed while EXPIRED/USED/SUPERSEDED. */
  'COUPON_NOT_REDEEMABLE',
  /** An invoice arrived without a resolved customer — the loop order was violated. */
  'CUSTOMER_REQUIRED',
  'CUSTOMER_ALREADY_EXISTS',
  'RATE_LIMITED',
  /**
   * The write reached the server and the server could not store it — a full disk
   * being the case this was added for (CLAUDE_v3.md §12.15).
   *
   * Distinct from INTERNAL_ERROR because the two demand different things of the
   * operator. A bug is ours to fix and the till can carry on; a datastore that
   * cannot accept writes means every sale from now until someone frees space is
   * unrecorded, and the person standing at the till is the only one who can raise
   * the alarm. Clients must fault the visible action, never show this as generic.
   */
  'STORAGE_UNAVAILABLE',
  /**
   * Backups are switched off because the encryption key has not been confirmed as
   * recorded off the machine (CLAUDE_v3.md §12.19).
   *
   * Its own code because the dashboard must react to it specifically — by reopening the
   * key ceremony, not by showing a failure the manager cannot act on.
   */
  'BACKUP_BLOCKED',
  /**
   * A card cannot be issued or used in the state it is in (§12.25). `details`
   * carries the `CardRejection` so the caller can say WHICH state rather than
   * showing a generic failure to somebody standing at a counter.
   */
  'CARD_NOT_ISSUABLE',
  /**
   * SQLite found the database file itself damaged — «database disk image is malformed»,
   * «file is not a database». Not a bug of ours and not a full disk: the remedy is a
   * restore, and a screen that called it «حدث خطأ» sent the merchant to retry a read
   * that will fail the same way every time.
   */
  'DATABASE_DAMAGED',
  /**
   * A restore was refused before anything changed — a copy made with another key, a
   * copy from a newer build, too little disk, a damaged copy. `details.reason` says
   * which (`RestoreRefusalReason`), so the screen can ask for the key written on paper
   * instead of only showing the sentence.
   */
  'RESTORE_REFUSED',
  /**
   * The installation is read-only — unlicensed, expired, or its clock set back — so a
   * new sale, a new customer or a voucher redemption was not recorded. `details.status`
   * names which. Reports, backups and everything already recorded keep working.
   */
  'LICENSE_READ_ONLY',
  /** An activation code was refused. `details.reason` is a LicenseRefusalReason. */
  'LICENSE_INVALID',
  'INTERNAL_ERROR',
]);

export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

/**
 * Why a STORAGE_UNAVAILABLE write failed, carried as `details.cause`.
 *
 * The code alone was one sentence for three situations with three different remedies:
 * free some space, get the file's permissions fixed, or get the disk looked at. The
 * Station keeps one message for all three — a cashier's move is the same — but the
 * manager's screen must say which, because the manager is the one who acts on it.
 */
export const StorageFailureCauseSchema = z.enum(['DISK_FULL', 'READ_ONLY', 'IO_ERROR']);
export type StorageFailureCause = z.infer<typeof StorageFailureCauseSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    /** Arabic, safe to show a user. Never contains secrets, tokens or SQL. */
    message: z.string(),
    /** Field-level detail for VALIDATION_FAILED. */
    fields: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
    /** Correlates a client report with a server log line. */
    requestId: z.string().optional(),
    /**
     * For DUPLICATE_INVOICE: the transaction that already owns this invoice, so the
     * assistant can show *who* it was linked to instead of a bare failure.
     */
    // Shape depends on `code` — e.g. DuplicateInvoiceDetails for DUPLICATE_INVOICE.
    // Callers narrow it with the matching DTO schema rather than trusting it raw.
    details: z.unknown().optional(),
  }),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;

/** Maps an error code to the HTTP status the API returns for it. */
export const ERROR_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  DUPLICATE_INVOICE: 409,
  COUPON_NOT_REDEEMABLE: 409,
  CUSTOMER_REQUIRED: 422,
  CUSTOMER_ALREADY_EXISTS: 409,
  RATE_LIMITED: 429,
  // 507 Insufficient Storage. Specific enough that a proxy or a log filter can tell
  // it from a generic 500, and no client in this system special-cases it otherwise.
  STORAGE_UNAVAILABLE: 507,
  BACKUP_BLOCKED: 409,
  CARD_NOT_ISSUABLE: 409,
  DATABASE_DAMAGED: 500,
  RESTORE_REFUSED: 409,
  // 423 Locked: the request was understood and the resource is, for now, not writable.
  // Distinct from 403 so neither the Station nor a log reads it as a role refusal.
  LICENSE_READ_ONLY: 423,
  LICENSE_INVALID: 422,
  INTERNAL_ERROR: 500,
};
