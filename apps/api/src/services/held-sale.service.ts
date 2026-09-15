import type { LicenseState } from '@walaa/shared-types';
import { AppError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { AUDIT_ACTIONS, recordAudit, type AuditAction } from './audit.service';
import { licenseState } from './license.service';
import { scanCard } from './scan.service';

/**
 * Sales held for activation, applied on the manager PC (packaging/LICENSING.md §10).
 *
 * A sale refused because the licence is read-only is written down where it was refused
 * (`holdForActivation` in scan.service.ts). This applies those holds the moment
 * recording is allowed again — after a licence is activated or a phone code entered, at
 * start-up, and every ten minutes — through the same `scanCard` a till would call, so a
 * held sale meets exactly the rules a live one does. It is credited at the price the
 * customer paid, with no discount: a discount settles at the payment of its invoice, and
 * that payment is long over. The amount forgone was recorded with the hold.
 *
 * Nothing here depends on the till. A till that was restarted, rebooted or wiped holds
 * nothing any more and loses nothing; a till that still has its copy replays it, and
 * `scanCard` answers that replay with the transaction already made.
 */

interface Hold {
  entityId: string;
  merchantId: string;
  barcodeToken: string;
  invoiceId: string;
  branchId: string;
  stationId: string | null;
  userId: string;
  occurredAt: Date;
  forgoneDiscount: number | null;
}

async function waitingHolds(): Promise<Hold[]> {
  const [holds, outcomes] = await Promise.all([
    prisma.auditLog.findMany({ where: { action: AUDIT_ACTIONS.SALE_HELD }, orderBy: { createdAt: 'asc' } }),
    prisma.auditLog.findMany({
      where: { action: { in: [AUDIT_ACTIONS.SALE_HELD_APPLIED, AUDIT_ACTIONS.SALE_HELD_CLOSED] } },
      select: { entityId: true },
    }),
  ]);
  const settled = new Set(outcomes.map((row) => row.entityId));
  return holds.flatMap((row): Hold[] => {
    if (settled.has(row.entityId)) return [];
    let details: Record<string, unknown>;
    try {
      details = JSON.parse(row.afterJson ?? '{}') as Record<string, unknown>;
    } catch {
      return [];
    }
    const text = (key: string): string | null => (typeof details[key] === 'string' ? (details[key] as string) : null);
    const barcodeToken = text('barcodeToken');
    const invoiceId = text('invoiceId');
    const branchId = text('branchId');
    const userId = text('userId');
    if (!barcodeToken || !invoiceId || !branchId || !userId) return [];
    const occurredAt = new Date(text('occurredAt') ?? row.createdAt.toISOString());
    return [
      {
        entityId: row.entityId,
        merchantId: row.merchantId,
        barcodeToken,
        invoiceId,
        branchId,
        stationId: text('stationId'),
        userId,
        occurredAt: Number.isNaN(occurredAt.getTime()) ? row.createdAt : occurredAt,
        forgoneDiscount: typeof details.forgoneDiscount === 'number' ? details.forgoneDiscount : null,
      },
    ];
  });
}

/** How many sales wait, from how many tills, since when, and the discount they did not get. */
export async function heldSummary(): Promise<LicenseState['heldAtStations']> {
  const holds = await waitingHolds();
  if (holds.length === 0) return null;
  return {
    count: holds.length,
    stations: new Set(holds.map((hold) => hold.stationId ?? hold.branchId)).size,
    oldest: new Date(Math.min(...holds.map((hold) => hold.occurredAt.getTime()))).toISOString(),
    forgoneDiscount: holds.reduce((sum, hold) => sum + (hold.forgoneDiscount ?? 0), 0),
  };
}

/** The licence state as the screens read it: the gate's verdict, and what waits because of it. */
export async function withHeldSummary(state: LicenseState): Promise<LicenseState> {
  return { ...state, heldAtStations: await heldSummary().catch(() => null) };
}

export interface HeldSalesResult {
  applied: number;
  closed: number;
  waiting: number;
}

async function settle(hold: Hold, action: AuditAction, after: Record<string, unknown>): Promise<void> {
  await recordAudit({
    merchantId: hold.merchantId,
    actorUserId: null,
    action,
    entityType: 'held_sale',
    entityId: hold.entityId,
    after: { invoiceId: hold.invoiceId, forgoneDiscount: hold.forgoneDiscount, ...after },
  });
}

async function applyAll(): Promise<HeldSalesResult> {
  const holds = await waitingHolds();
  const result: HeldSalesResult = { applied: 0, closed: 0, waiting: holds.length };
  if (holds.length === 0 || (await licenseState()).readOnly) return result;

  for (const hold of holds) {
    try {
      const response = await scanCard(
        {
          merchantId: hold.merchantId,
          userId: hold.userId,
          branchId: hold.branchId,
          ...(hold.stationId ? { stationId: hold.stationId } : {}),
        },
        { barcodeToken: hold.barcodeToken, invoiceId: hold.invoiceId },
        { issueDiscount: false, occurredAt: hold.occurredAt },
      );
      if (response.transaction && response.customer) {
        await settle(hold, AUDIT_ACTIONS.SALE_HELD_APPLIED, { transactionId: response.transaction.id });
        result.applied += 1;
      } else if (response.outcome === 'UNKNOWN_CARD' || response.outcome === 'CARD_REJECTED') {
        await settle(hold, AUDIT_ACTIONS.SALE_HELD_CLOSED, { reason: 'CARD_REFUSED', cardRejection: response.cardRejection });
        result.closed += 1;
      } else {
        // Nothing pending under that number: another customer's card claimed it, or the
        // register has not delivered the capture yet. Only the first is final.
        const claimed = await prisma.transaction.findFirst({
          where: { merchantId: hold.merchantId, branchId: hold.branchId, invoiceId: hold.invoiceId, customerId: { not: null } },
          select: { id: true },
        });
        if (claimed) {
          await settle(hold, AUDIT_ACTIONS.SALE_HELD_CLOSED, { reason: 'LINKED_ELSEWHERE', transactionId: claimed.id });
          result.closed += 1;
        }
      }
    } catch (error) {
      // Read-only again: stop, everything left waits. Anything else waits for the next pass.
      if (error instanceof AppError && error.code === 'LICENSE_READ_ONLY') break;
    }
  }
  result.waiting = holds.length - result.applied - result.closed;
  return result;
}

let running: Promise<HeldSalesResult> | null = null;

/** Applies every held sale that can be applied now. One pass at a time; callers share it. */
export function applyHeldSales(): Promise<HeldSalesResult> {
  if (!running) {
    running = applyAll().finally(() => {
      running = null;
    });
  }
  return running;
}
