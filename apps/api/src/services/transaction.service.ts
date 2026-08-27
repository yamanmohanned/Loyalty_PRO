import type { Branch, Prisma, Transaction } from '@prisma/client';
import {
  toAmountCapture,
  toInvoiceSource,
  type DuplicateInvoiceDetails,
  type LinkTransactionRequest,
  type LinkTransactionResponse,
  type Role,
} from '@walaa/shared-types';
import { duplicateInvoice, forbidden, notFound } from '../lib/errors';
import { isSerializationFailure, isUniqueViolation, prisma } from '../lib/prisma';
import { AUDIT_ACTIONS, recordAudit } from './audit.service';
import { computeCumulativeAmount, refreshBalanceSnapshot, runThresholdCheck } from './loyalty.service';
import { enqueueNotification, NOTIFICATION_TEMPLATES } from './notification';
import { getPeriodContext, nextThreshold, periodKeyFor, resolveEffectiveRules } from './rules.service';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE CORE LOOP — linking an invoice to a customer
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every rule in CLAUDE.md §0 converges on this file. Three of them are load-bearing:
 *
 *  1. **Identity precedes the invoice.** `customerId` is required by the request
 *     type, so there is no code path here that could link an unattributed invoice.
 *
 *  2. **The same invoice is never linked twice.** Guarded by a database UNIQUE
 *     constraint on (merchant, branch, invoice), caught here and turned into a 409
 *     carrying the existing record — so the assistant sees *who* it was linked to.
 *
 *  3. **The balance is derived.** Recomputed from transaction rows inside the same
 *     serializable transaction that inserted the new row, so the threshold check
 *     runs against a number that cannot be stale.
 */

/**
 * Signals that the unique constraint fired mid-transaction.
 *
 * Postgres aborts a whole transaction when any statement in it fails, so once the
 * insert has raised a unique violation nothing further can be queried on that
 * connection — including the lookup that would tell us whose invoice it already is.
 * This sentinel carries just enough to re-query *after* the transaction unwinds.
 */
class DuplicateInvoiceRace extends Error {
  constructor(
    readonly branchId: string,
    readonly branchCode: string,
    readonly invoiceId: string,
  ) {
    super('duplicate invoice');
    this.name = 'DuplicateInvoiceRace';
  }
}

export interface LinkTransactionContext {
  merchantId: string;
  /** The staff member performing the link. */
  userId: string;
  role: Role;
  /** The branch the user is bound to; null for an OWNER, who may act anywhere. */
  userBranchId: string | null;
}

/**
 * Resolves the branch a sale belongs to and confirms the actor may act there.
 *
 * The branch comes from the Normalized Invoice Schema (a future API-tier source
 * legitimately declares its own), but a declared branch is never trusted on its
 * own: a bound user must match it. Otherwise an assistant at one branch could
 * attribute sales to another, which is both a fraud vector and a reporting mess.
 */
async function resolveBranch(
  context: LinkTransactionContext,
  branchCode: string,
  db: Prisma.TransactionClient,
): Promise<Branch> {
  const branch = await db.branch.findUnique({
    where: { merchantId_code: { merchantId: context.merchantId, code: branchCode } },
  });
  if (!branch) throw notFound(`الفرع غير موجود: ${branchCode}`);
  if (!branch.isActive) throw forbidden('هذا الفرع غير مفعّل');

  if (context.userBranchId && context.userBranchId !== branch.id) {
    throw forbidden('لا يمكنك ربط فاتورة لفرع آخر');
  }
  // An OWNER is unbound and may link anywhere; everyone else must carry a branch.
  if (!context.userBranchId && context.role !== 'OWNER') {
    throw forbidden('المستخدم غير مرتبط بفرع');
  }

  return branch;
}

/** Shapes the 409 payload so the UI can name the customer the invoice already belongs to. */
async function describeDuplicate(
  existing: Transaction,
  db: Prisma.TransactionClient,
): Promise<DuplicateInvoiceDetails> {
  const [customer, branch] = await Promise.all([
    db.customer.findUnique({ where: { id: existing.customerId }, select: { name: true } }),
    db.branch.findUnique({ where: { id: existing.branchId }, select: { code: true } }),
  ]);

  return {
    existingTransaction: serializeTransaction(existing, branch?.code ?? ''),
    customerName: customer?.name ?? 'غير معروف',
    linkedAt: existing.createdAt.toISOString(),
  };
}

export function serializeTransaction(
  transaction: Transaction,
  branchCode: string,
): DuplicateInvoiceDetails['existingTransaction'] {
  return {
    id: transaction.id,
    customerId: transaction.customerId,
    branchId: transaction.branchId,
    branchCode,
    invoiceId: transaction.invoiceId,
    amount: transaction.amount,
    currency: 'IQD',
    occurredAt: transaction.occurredAt.toISOString(),
    source: transaction.source,
    amountCapture: transaction.amountCapture,
    linkedByUserId: transaction.linkedByUserId,
    createdAt: transaction.createdAt.toISOString(),
  };
}

/**
 * Links one invoice to one customer.
 *
 * Runs at SERIALIZABLE isolation. Read Committed would let two concurrent links
 * for the same customer each compute a sum missing the other's uncommitted row —
 * the duplicate coupon is already impossible thanks to the unique constraint, but
 * a *missed* threshold crossing is not, and a customer silently not receiving the
 * discount they earned is the worst failure this system has. Register volume is
 * low enough that the isolation costs nothing real; the retry below absorbs the
 * occasional serialization conflict.
 */
export async function linkTransaction(
  context: LinkTransactionContext,
  request: LinkTransactionRequest,
): Promise<LinkTransactionResponse> {
  try {
    return await withSerializableRetry(() => linkTransactionOnce(context, request));
  } catch (error) {
    if (!(error instanceof DuplicateInvoiceRace)) throw error;

    // The transaction has unwound, so this runs on a clean connection.
    const existing = await prisma.transaction.findUnique({
      where: {
        merchantId_branchId_invoiceId: {
          merchantId: context.merchantId,
          branchId: error.branchId,
          invoiceId: error.invoiceId,
        },
      },
    });
    // Vanishingly unlikely — it would mean the winning transaction rolled back
    // after we saw its constraint. Surface it rather than inventing a result.
    if (!existing) throw duplicateInvoice(null);

    const [customer, branch] = await Promise.all([
      prisma.customer.findUnique({ where: { id: existing.customerId }, select: { name: true } }),
      prisma.branch.findUnique({ where: { id: existing.branchId }, select: { code: true } }),
    ]);

    throw duplicateInvoice({
      existingTransaction: serializeTransaction(existing, branch?.code ?? error.branchCode),
      customerName: customer?.name ?? 'غير معروف',
      linkedAt: existing.createdAt.toISOString(),
    });
  }
}

async function linkTransactionOnce(
  context: LinkTransactionContext,
  request: LinkTransactionRequest,
): Promise<LinkTransactionResponse> {
  const { invoice } = request;
  const occurredAt = new Date(invoice.occurred_at);

  return prisma.$transaction(
    async (db) => {
      const customer = await db.customer.findFirst({
        where: { id: request.customerId, merchantId: context.merchantId },
      });
      if (!customer) throw notFound('الزبون غير موجود');
      if (!customer.isActive) throw forbidden('حساب الزبون غير مفعّل');

      const branch = await resolveBranch(context, invoice.branch_id, db);

      // A retried request that already succeeded returns the original outcome
      // rather than a duplicate error — the network failed, not the operator.
      if (request.idempotencyKey) {
        const replay = await db.transaction.findUnique({
          where: { idempotencyKey: request.idempotencyKey },
        });
        if (replay) return buildResponse(replay, branch.code, context, db);
      }

      const periodContext = await getPeriodContext(context.merchantId, db);
      const periodKey = periodKeyFor(periodContext, occurredAt);

      // Check before inserting. A duplicate found here leaves the transaction
      // healthy, so the lookup naming the existing owner can still run. The insert
      // below still races under concurrency, which the catch handles separately.
      const alreadyLinked = await db.transaction.findUnique({
        where: {
          merchantId_branchId_invoiceId: {
            merchantId: context.merchantId,
            branchId: branch.id,
            invoiceId: invoice.invoice_id,
          },
        },
      });
      if (alreadyLinked) {
        throw duplicateInvoice(await describeDuplicate(alreadyLinked, db));
      }

      let created: Transaction;
      try {
        created = await db.transaction.create({
          data: {
            merchantId: context.merchantId,
            branchId: branch.id,
            customerId: customer.id,
            invoiceId: invoice.invoice_id,
            amount: invoice.amount,
            currency: invoice.currency,
            occurredAt,
            source: toInvoiceSource(invoice.source),
            amountCapture: toAmountCapture(invoice.amount_capture),
            periodKey,
            linkedByUserId: context.userId,
            deviceId: request.deviceId ?? null,
            idempotencyKey: request.idempotencyKey ?? null,
          },
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;

        // ═══ THE IDEMPOTENCY GUARD FIRING (CLAUDE.md §0.2) ═══
        // A concurrent link won the race. The transaction is now aborted, so the
        // details are fetched by the caller once it has unwound.
        throw new DuplicateInvoiceRace(branch.id, branch.code, invoice.invoice_id);
      }

      // A hand-typed amount is the one place a staff member could inflate a
      // balance, so every one of them leaves a trace naming who typed it (§7.10).
      if (created.amountCapture === 'MANUAL') {
        await recordAudit(
          {
            merchantId: context.merchantId,
            actorUserId: context.userId,
            action: AUDIT_ACTIONS.TRANSACTION_LINKED_MANUAL_AMOUNT,
            entityType: 'transaction',
            entityId: created.id,
            after: {
              invoiceId: created.invoiceId,
              amount: created.amount,
              customerId: created.customerId,
              branchCode: branch.code,
            },
          },
          db,
        );
      }

      return buildResponse(created, branch.code, context, db, { periodKey });
    },
    { isolationLevel: 'Serializable', timeout: 15_000 },
  );
}

/**
 * Recomputes the balance, runs the threshold check and assembles the response the
 * assistant renders on its success screen.
 */
async function buildResponse(
  transaction: Transaction,
  branchCode: string,
  context: LinkTransactionContext,
  db: Prisma.TransactionClient,
  options?: { periodKey?: string },
): Promise<LinkTransactionResponse> {
  const periodKey = options?.periodKey ?? transaction.periodKey;

  const totals = await refreshBalanceSnapshot(
    { merchantId: context.merchantId, customerId: transaction.customerId, periodKey },
    db,
  );

  const rules = await resolveEffectiveRules(context.merchantId, transaction.customerId, db);

  const { issuedCoupon, supersededCoupon } = await runThresholdCheck(
    {
      merchantId: context.merchantId,
      customerId: transaction.customerId,
      periodKey,
      cumulativeAmount: totals.cumulativeAmount,
      rules,
      sourceTransactionId: transaction.id,
      actorUserId: context.userId,
    },
    db,
  );

  const gap = nextThreshold(rules, totals.cumulativeAmount);

  // Enqueued inside the same transaction: a committed link can never be missing
  // its notification, and a rolled-back one can never have sent a phantom message.
  const customer = await db.customer.findUniqueOrThrow({
    where: { id: transaction.customerId },
    select: { name: true, phone: true },
  });

  if (issuedCoupon) {
    await enqueueNotification(
      {
        merchantId: context.merchantId,
        customerId: transaction.customerId,
        template: NOTIFICATION_TEMPLATES.COUPON_ISSUED,
        variables: {
          name: customer.name,
          discountPct: issuedCoupon.discountPct,
          expiresAt: issuedCoupon.expiresAt.toISOString(),
          cumulativeAmount: totals.cumulativeAmount,
        },
      },
      db,
    );
  } else {
    await enqueueNotification(
      {
        merchantId: context.merchantId,
        customerId: transaction.customerId,
        template: NOTIFICATION_TEMPLATES.TRANSACTION_LINKED,
        variables: {
          name: customer.name,
          amount: transaction.amount,
          cumulativeAmount: totals.cumulativeAmount,
          amountToNextThreshold: gap.amountToNextThreshold ?? 0,
        },
      },
      db,
    );
  }

  return {
    transaction: serializeTransaction(transaction, branchCode),
    balance: {
      periodKey,
      cumulativeAmount: totals.cumulativeAmount,
      nextThresholdAmount: gap.nextThresholdAmount,
      amountToNextThreshold: gap.amountToNextThreshold,
      nextDiscountPct: gap.nextDiscountPct,
    },
    issuedCoupon: issuedCoupon ? serializeCoupon(issuedCoupon) : null,
    supersededCoupon: supersededCoupon ? serializeCoupon(supersededCoupon) : null,
  };
}

export function serializeCoupon(
  coupon: Prisma.CouponGetPayload<Record<string, never>>,
): NonNullable<LinkTransactionResponse['issuedCoupon']> {
  return {
    id: coupon.id,
    customerId: coupon.customerId,
    discountPct: coupon.discountPct,
    sourceThresholdAmount: coupon.sourceThresholdAmount,
    periodKey: coupon.periodKey,
    issuedAt: coupon.issuedAt.toISOString(),
    expiresAt: coupon.expiresAt.toISOString(),
    status: coupon.status,
    redeemedAt: coupon.redeemedAt ? coupon.redeemedAt.toISOString() : null,
  };
}

/**
 * Serializable transactions can abort with a serialization failure when two
 * conflict. That is not an error the caller did anything to cause, so retry a
 * bounded number of times before surfacing it.
 */
async function withSerializableRetry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isSerializationFailure(error)) throw error;
      lastError = error;
      // Brief jittered backoff so two conflicting writers do not lock-step.
      await new Promise((resolve) => setTimeout(resolve, attempt * 25 + Math.random() * 25));
    }
  }
  throw lastError;
}

/** Recomputes a customer's standing without linking anything — used by detail screens. */
export async function getCustomerBalance(
  merchantId: string,
  customerId: string,
): Promise<LinkTransactionResponse['balance']> {
  const periodContext = await getPeriodContext(merchantId);
  const periodKey = periodKeyFor(periodContext, new Date());
  const totals = await computeCumulativeAmount(customerId, periodKey);
  const rules = await resolveEffectiveRules(merchantId, customerId);
  const gap = nextThreshold(rules, totals.cumulativeAmount);

  return {
    periodKey,
    cumulativeAmount: totals.cumulativeAmount,
    nextThresholdAmount: gap.nextThresholdAmount,
    amountToNextThreshold: gap.amountToNextThreshold,
    nextDiscountPct: gap.nextDiscountPct,
  };
}
