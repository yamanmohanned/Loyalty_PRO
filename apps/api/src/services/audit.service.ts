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
  TRANSACTION_LINKED_MANUAL_AMOUNT: 'transaction.linked.manual_amount',
  COUPON_ISSUED: 'coupon.issued',
  COUPON_REDEEMED: 'coupon.redeemed',
  COUPON_SUPERSEDED: 'coupon.superseded',
  RULES_UPDATED: 'rules.updated',
  OVERRIDE_CREATED: 'rules.override.created',
  OVERRIDE_UPDATED: 'rules.override.updated',
  OVERRIDE_DELETED: 'rules.override.deleted',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export interface AuditEntry {
  merchantId: string;
  /** Null for system actions such as scheduled coupon expiry. */
  actorUserId: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string;
  before?: Prisma.InputJsonValue | null;
  after?: Prisma.InputJsonValue | null;
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
      beforeJson: entry.before ?? undefined,
      afterJson: entry.after ?? undefined,
    },
  });
}
