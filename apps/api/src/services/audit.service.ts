import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma';

/**
 * Append-only audit trail (CLAUDE.md §7.10).
 *
 * Rows are written and never updated or deleted. There is deliberately no update
 * or delete function in this module — the absence is the enforcement.
 *
 * What must be audited: rule changes, coupon redemptions, manual amount entries,
 * and customer edits. Manual amounts matter most: a hand-typed figure is the one
 * point in the core loop where a staff member could inflate a balance, so every
 * one of them leaves a trace naming who typed it.
 */

export const AUDIT_ACTIONS = {
  /**
   * The demo dataset was rebuilt from scratch.
   *
   * Audited even though it only ever happens in a demo build, and precisely because
   * of what it does: it deletes every transaction, voucher, card and customer the
   * merchant has clicked into existence, and restores the shipped discount ladder over
   * whatever he had configured. That is the most destructive single action in the
   * product, and an append-only trail that omitted it would be a trail with a hole
   * exactly where somebody asks "where did my data go".
   */
  DEMO_RESET: 'demo.reset',
  /**
   * The installation created its own shop and owner on first run.
   *
   * The first row in an append-only trail, and the only one written by an actor who did
   * not exist a moment earlier. It records when this installation came into being and
   * from which address — which is the question somebody asks if an owner account ever
   * appears that the merchant did not create.
   */
  INSTALLATION_BOOTSTRAPPED: 'installation.bootstrapped',
  /**
   * A staff account — a till, a second manager — was created or changed.
   *
   * Audited for the reason every credential act is: the answer to "who could sign in as
   * the till last Tuesday" has to exist, and it has to exist even when the account
   * itself has since been deactivated. Neither entry ever carries a password or a hash:
   * a password change is recorded as the FACT that one happened.
   */
  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
  CUSTOMER_CREATED: 'customer.created',
  CUSTOMER_UPDATED: 'customer.updated',
  CARD_REPRINTED: 'customer.card_reprinted',
  /**
   * The customer list left the machine as a file. Every phone number in the shop is
   * in it, and §7.11 calls the phone the one identifier worth protecting here — so
   * "who exported it, when" is a question somebody will eventually need answered.
   */
  CUSTOMER_LIST_EXPORTED: 'customer.list_exported',
  INVOICE_CAPTURED: 'transaction.captured',
  INVOICE_ATTRIBUTED: 'transaction.attributed',
  MANUAL_AMOUNT_ENTERED: 'transaction.manual_amount',
  VOUCHER_ISSUED: 'voucher.issued',
  VOUCHER_REDEEMED: 'voucher.redeemed',
  VOUCHER_VOIDED: 'voucher.voided',
  /* ── Physical card stock (§12.25) ───────────────────────────────── */

  CARD_BATCH_GENERATED: 'card_batch.generated',
  /**
   * The export file was produced — and with it, every card number in the batch
   * left this machine. Recorded with an actor because that file is the one artefact
   * of this feature worth stealing, and "who exported it, when" is the first
   * question after a leak.
   */
  CARD_BATCH_EXPORTED: 'card_batch.exported',
  CARD_BATCH_VOIDED: 'card_batch.voided',
  CARD_ASSIGNED: 'card.assigned',
  CARD_REPORTED_LOST: 'card.reported_lost',
  /**
   * A lost card came back. Audited with an actor and a stated reason, because it
   * re-arms a credential that was deliberately disarmed.
   */
  CARD_RESTORED: 'card.restored',
  CARD_REPLACED: 'card.replaced',
  CARD_VOIDED: 'card.voided',

  DISCOUNT_RULES_UPDATED: 'discount.rules_updated',
  DISCOUNT_SETTINGS_UPDATED: 'discount.settings_updated',
  /** The station's thermal roll width changed — it alters what comes out of a printer. */
  PAPER_WIDTH_UPDATED: 'printing.paper_width_updated',
  FEATURE_FLAG_TOGGLED: 'feature_flag.toggled',
  BACKUP_COMPLETED: 'backup.completed',
  BACKUP_FAILED: 'backup.failed',
  /**
   * A scheduled run stood down because one was already in progress.
   *
   * Recorded rather than merely logged: "the nightly backup did not happen" must never
   * be answerable only by absence. The Backup screen reads these rows, so a manager can
   * see the difference between a skip and a scheduler that stopped running months ago.
   */
  BACKUP_SKIPPED: 'backup.skipped',
  BACKUP_RESTORED: 'backup.restored',

  /* ── Licensing (packaging/LICENSING.md) ─────────────────────────────── */
  /** A code activated — or the same code pasted again (`after.repeat`). */
  LICENSE_ACTIVATED: 'license.activated',
  /** Every refused activation, with the reason. */
  LICENSE_ACTIVATION_FAILED: 'license.activation_failed',
  /** The device ID was computed and stored for the first time. */
  LICENSE_DEVICE_IDENTIFIED: 'license.device_identified',
  /** MachineGuid or the volume serial changed. A warning: the licence keeps working. */
  LICENSE_DEVICE_SOURCES_CHANGED: 'license.device_sources_changed',
  /** The clock was found more than two hours behind the latest recorded time. */
  LICENSE_CLOCK_ROLLBACK: 'license.clock_rollback',
  /** The three recorded times disagreed; the latest was used. */
  LICENSE_CLOCK_ANCHOR_CONFLICT: 'license.clock_anchor_conflict',
  /** A freshly issued code showed the recorded time was in the future; it was reset. */
  LICENSE_CLOCK_ANCHOR_RESET: 'license.clock_anchor_reset',
  /** A stored code failed its own signature check — the database was edited. */
  LICENSE_STORED_CODE_INVALID: 'license.stored_code_invalid',
  /** A code from the mirror file was put back into the database (after a restore). */
  LICENSE_RESTORED_FROM_MIRROR: 'license.restored_from_mirror',
  /** An emergency code read over the phone was entered. */
  LICENSE_UNLOCK_ENTERED: 'license.unlock_entered',
  LICENSE_UNLOCK_FAILED: 'license.unlock_failed',
  /** The installation had a licence and now has no licence rows at all — damage or deletion. */
  LICENSE_LOST: 'license.lost',
  /** The clock came back into line; closes a `license.clock_rollback`. */
  LICENSE_CLOCK_RESTORED: 'license.clock_restored',
  /** The licence check itself failed; the gate used the last recorded status. */
  LICENSE_CHECK_FAILED: 'license.check_failed',
  /** A queued sale arrived while read-only and was accepted because it happened while licensed. */
  LICENSE_ACCEPTED_BY_OCCURRENCE: 'license.accepted_by_occurrence',
  /**
   * A sale refused because the licence is read-only, kept on this PC to be applied on
   * activation, with the discount it would have earned (scan.service.ts,
   * `holdForActivation`). It waits while no `sale.held_applied` or `sale.held_closed`
   * with the same entity id follows it.
   */
  SALE_HELD: 'sale.held_for_activation',
  SALE_HELD_APPLIED: 'sale.held_applied',
  /** A held sale that cannot be applied — its invoice went to another customer, or the card was refused. */
  SALE_HELD_CLOSED: 'sale.held_closed',
  /** A copy fetched, decrypted and checked beside the live database — nothing replaced. */
  BACKUP_RESTORE_STAGED: 'backup.restore_staged',
  /** The owner confirmed a staged restore; applied at the next start. */
  BACKUP_RESTORE_REQUESTED: 'backup.restore_requested',
  /**
   * The sentinel of the §12.17 recency check.
   *
   * Written BEFORE the backup it verifies, which is the whole mechanism: the restored
   * copy is searched for this exact row, so a backup that silently restores to an older
   * day fails the check instead of passing it. Named for what it is — an attempt — so
   * the trail stays truthful when the verification fails.
   */
  BACKUP_VERIFICATION_STARTED: 'backup.verification_started',
  BACKUP_VERIFIED: 'backup.verified',
  /**
   * A restore test that ran and did not pass — with the reason, in the merchant's words.
   *
   * Only passes used to be recorded, so a test that failed left the Backup screen saying
   * «لم يُجرَ اختبار استعادة بعد»: the one outcome a merchant most needs to see was the
   * one the screen could not show.
   */
  BACKUP_VERIFY_FAILED: 'backup.verify_failed',

  /* ── The off-machine copy: Google Drive (§7.3) ────────────────────────── */

  /**
   * A Google account granted this installation the right to write backups into it.
   *
   * §7.10 audits changes that alter what the system can do, and this is the largest of
   * them in the other direction: it creates a standing credential that lets the shop's
   * data leave the machine, on purpose, until somebody withdraws it. "Who connected
   * which account, and when" is the first question after a disputed upload, and there is
   * no other record of it — the credential itself is encrypted and unreadable by design.
   */
  BACKUP_DRIVE_CONNECTED: 'backup.drive_connected',
  /** The grant was withdrawn from this end. Recorded so a silent gap has an author. */
  BACKUP_DRIVE_DISCONNECTED: 'backup.drive_disconnected',
  /** Drive was paused/resumed, or its retention changed — how many copies survive. */
  BACKUP_DRIVE_SETTINGS_UPDATED: 'backup.drive_settings_updated',
  /** The OAuth client entered in Settings. Carries the id, never the secret. */
  BACKUP_DRIVE_CLIENT_SAVED: 'backup.drive_client_saved',
  BACKUP_DRIVE_CLIENT_CLEARED: 'backup.drive_client_cleared',

  /* ── The key ceremony (§12.19) ────────────────────────────────────────── */

  BACKUP_KEY_GENERATED: 'backup.key_generated',
  /**
   * The manager typed the key back and it matched — the record that a human actually
   * has it somewhere other than this machine.
   *
   * `entityId` is the key's FINGERPRINT, not a constant. That is what makes the
   * confirmation belong to one specific key: replace the key and the new fingerprint
   * has no confirming row, so the ceremony reopens by itself rather than a stale
   * "confirmed" flag vouching for a key nobody has written down.
   */
  BACKUP_KEY_CONFIRMED: 'backup.key_confirmed',
  /** Every time the key is displayed. A secret shown is a secret that left the vault. */
  BACKUP_KEY_REVEALED: 'backup.key_revealed',

  /**
   * Free space on the database volume crossed a threshold (§12.15).
   *
   * A system action with no actor, written on the CHANGE only. It exists because a disk
   * that filled overnight and was cleared before anyone arrived otherwise leaves no
   * trace at all — the banner is gone, the log has rotated, and the outage that nearly
   * happened is unanswerable. "Twice this month" is what buys a bigger drive.
   */
  STORAGE_LEVEL_CHANGED: 'storage.level_changed',

  /**
   * An account locked itself after consecutive failed logins (FND-01).
   *
   * A system action with no actor, written on the TRANSITION only — one row per lock,
   * not one per wrong password. The question the trail is asked is «why could the till
   * not sign in on Thursday evening», and one row answers it; a row per attempt would
   * bury it under the attempts that led to it.
   */
  STAFF_LOCKED: 'staff.locked',
  /**
   * A manager lifted a lock before it expired.
   *
   * Audited with its actor because clearing a lock is an act on somebody else's
   * credentials — and because the remedy for «the till is locked and there is a queue»
   * should leave a trace naming who applied it.
   */
  STAFF_UNLOCKED: 'staff.unlocked',

  /**
   * A settings layer was published (PRD §4).
   *
   * The draft is deliberately NOT audited. It is a working copy nothing reads, and a
   * trail that recorded every keystroke of a manager changing his mind would bury the
   * one row that matters — the moment a value started governing the shop — under
   * twenty that never governed anything.
   *
   * before/after carry the whole layer rather than the changed keys, because the
   * question asked later is «what was it set to», not «what did he touch».
   */
  SETTINGS_PUBLISHED: 'settings.published',
  /**
   * An earlier settings version was restored.
   *
   * A distinct action from a publish although the mechanism is identical, for the same
   * reason §13.2 gave SUPERSEDED its own status: the trail should say WHY the values
   * changed. «Rolled back to version 3» and «published version 7» are different events
   * to whoever is reading the history after an incident.
   */
  SETTINGS_ROLLED_BACK: 'settings.rolled_back',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export interface AuditEntry {
  merchantId: string;
  /** Null for system actions such as scheduled coupon expiry. */
  actorUserId: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string;
  /** Serialized to JSON on write — SQLite has no Json column type. */
  before?: unknown;
  after?: unknown;
}

/** Anything resembling a client — the real one, or a `$transaction` handle. */
type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Writes one audit row. Pass the transaction client when auditing something that
 * must be atomic with the change it records — a redemption that commits without
 * its audit row is worse than one that fails outright.
 */
export async function recordAudit(entry: AuditEntry, db: Db = prisma): Promise<void> {
  await db.auditLog.create({
    data: {
      merchantId: entry.merchantId,
      actorUserId: entry.actorUserId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      beforeJson: entry.before === undefined ? null : JSON.stringify(entry.before),
      afterJson: entry.after === undefined ? null : JSON.stringify(entry.after),
    },
  });
}
