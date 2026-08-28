import type { Prisma } from '@prisma/client';
import {
  toCaptureModeOrDefault,
  type CapturedInvoice,
  type IngestInvoiceResponse,
} from '@walaa/shared-types';
import { forbidden, notFound } from '../lib/errors';
import { isUniqueViolation, prisma } from '../lib/prisma';
import { getPeriodContext, periodKeyFor } from './balance.service';
import { publish } from './realtime.service';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INGESTION — the Print Capture Agent's entry point (CLAUDE_v3.md §4)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Records an invoice the moment it printed. The customer is **not known here** and
 * usually never will be: most shoppers are not enrolled. An unattributed capture is
 * the normal outcome, not a failure — attribution happens later, if a card is
 * scanned at the station.
 *
 * **Idempotency is the whole contract** (§4.8). An agent that loses its network
 * connection mid-send will retry, and a retry must never become a second recorded
 * sale. Guarded twice: a pre-check, and a database UNIQUE constraint behind it.
 *
 * A duplicate is answered with **200 and `duplicate: true`**, not an error. From the
 * agent's point of view a retry that finds the invoice already recorded has
 * succeeded — its job was to make sure the capture landed, and it did. Answering
 * 409 would push a normal, expected event onto the agent's error path and risk it
 * queueing the capture forever.
 */

export interface IngestionContext {
  merchantId: string;
  /** The agent's authenticated user, for the audit trail. */
  userId: string;
  /** Null for an unbound account; otherwise the agent may only report its own branch. */
  userBranchId: string | null;
  agentId?: string;
}

export async function ingestInvoice(
  context: IngestionContext,
  invoice: CapturedInvoice,
): Promise<IngestInvoiceResponse> {
  const occurredAt = new Date(invoice.occurred_at);
  const capturedAt = new Date(invoice.captured_at);

  const branch = await prisma.branch.findUnique({
    where: { merchantId_code: { merchantId: context.merchantId, code: invoice.branch_id } },
  });
  if (!branch) throw notFound(`الفرع غير موجود: ${invoice.branch_id}`);
  if (!branch.isActive) throw forbidden('هذا الفرع غير مفعّل');

  // A declared branch is never trusted on its own. An agent bound to one branch
  // must not be able to attribute sales to another — that is both a fraud vector
  // and a reporting mess.
  if (context.userBranchId && context.userBranchId !== branch.id) {
    throw forbidden('لا يمكن تسجيل فاتورة لفرع آخر');
  }

  const periodContext = await getPeriodContext(context.merchantId);
  const periodKey = periodKeyFor(periodContext, occurredAt);

  // Pre-check. The common duplicate is a retry, and answering it from here avoids
  // provoking a constraint violation on the happy-ish path.
  const existing = await prisma.transaction.findUnique({
    where: {
      merchantId_branchId_invoiceId: {
        merchantId: context.merchantId,
        branchId: branch.id,
        invoiceId: invoice.invoice_id,
      },
    },
  });

  if (existing) {
    return {
      transactionId: existing.id,
      invoiceId: existing.invoiceId,
      duplicate: true,
      capturedAt: existing.capturedAt.toISOString(),
    };
  }

  let created: Prisma.TransactionGetPayload<Record<string, never>>;
  try {
    created = await prisma.transaction.create({
      data: {
        merchantId: context.merchantId,
        branchId: branch.id,
        // Unknown at capture time. This is the point of the whole v3 design.
        customerId: null,
        invoiceId: invoice.invoice_id,
        amountGross: invoice.amount_gross,
        // No discount until a card is scanned. amountNet equals gross for now.
        discountType: 'NONE',
        discountRate: 0,
        discountValue: 0,
        amountNet: invoice.amount_gross,
        currency: invoice.currency,
        captureMode: toCaptureModeOrDefault(invoice.capture_mode),
        periodKey,
        occurredAt,
        capturedAt,
        linkedAt: null,
        idempotencyKey: invoice.idempotency_key ?? null,
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    // A concurrent send won the race between the pre-check and this insert. The
    // constraint did its job; re-read and report the winner.
    const winner = await prisma.transaction.findUnique({
      where: {
        merchantId_branchId_invoiceId: {
          merchantId: context.merchantId,
          branchId: branch.id,
          invoiceId: invoice.invoice_id,
        },
      },
    });
    if (!winner) throw error;

    return {
      transactionId: winner.id,
      invoiceId: winner.invoiceId,
      duplicate: true,
      capturedAt: winner.capturedAt.toISOString(),
    };
  }

  // Real-time push so the manager dashboard reflects the sale within a second,
  // with no polling (§7.2).
  publish(context.merchantId, {
    type: 'INVOICE_CAPTURED',
    transactionId: created.id,
    invoiceId: created.invoiceId,
    amountGross: created.amountGross,
    at: new Date().toISOString(),
  });

  return {
    transactionId: created.id,
    invoiceId: created.invoiceId,
    duplicate: false,
    capturedAt: created.capturedAt.toISOString(),
  };
}

/**
 * The capture waiting to be claimed at a branch.
 *
 * Returns the most recent unattributed invoice, because the person standing at the
 * station is holding the receipt that just printed. Bounded by a time window so a
 * stale capture from hours ago is never handed to whoever scans next — that would
 * attribute a stranger's basket to them, and grant a discount on spending they
 * never did.
 */
export async function findPendingInvoice(
  merchantId: string,
  branchId: string,
  options: { invoiceId?: string; withinMinutes?: number } = {},
) {
  if (options.invoiceId) {
    return prisma.transaction.findFirst({
      where: { merchantId, branchId, invoiceId: options.invoiceId, customerId: null },
    });
  }

  const cutoff = new Date(Date.now() - (options.withinMinutes ?? 30) * 60_000);

  return prisma.transaction.findFirst({
    where: { merchantId, branchId, customerId: null, capturedAt: { gte: cutoff } },
    orderBy: { capturedAt: 'desc' },
  });
}
