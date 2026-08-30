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
  CUSTOMER_CREATED: 'customer.created',
  CUSTOMER_UPDATED: 'customer.updated',
  CARD_REPRINTED: 'customer.card_reprinted',
  INVOICE_CAPTURED: 'transaction.captured',
  INVOICE_ATTRIBUTED: 'transaction.attributed',
  MANUAL_AMOUNT_ENTERED: 'transaction.manual_amount',
  VOUCHER_ISSUED: 'voucher.issued',
  VOUCHER_REDEEMED: 'voucher.redeemed',
  VOUCHER_VOIDED: 'voucher.voided',
  DISCOUNT_RULES_UPDATED: 'discount.rules_updated',
  DISCOUNT_SETTINGS_UPDATED: 'discount.settings_updated',
  FEATURE_FLAG_TOGGLED: 'feature_flag.toggled',
  BACKUP_COMPLETED: 'backup.completed',
  BACKUP_FAILED: 'backup.failed',
  BACKUP_RESTORED: 'backup.restored',
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
