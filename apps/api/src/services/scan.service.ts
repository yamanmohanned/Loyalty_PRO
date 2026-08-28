import {
  computeDiscount,
  formatIqd,
  type ScanCardRequest,
  type ScanCardResponse,
  type Voucher as VoucherDto,
} from '@walaa/shared-types';
import { loadEnv } from '../config/env';
import {
  canonicalizeBarcodeToken,
  looksLikeBarcodeToken,
  verifyBarcodeToken,
} from '../lib/barcode-token';
import { forbidden } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { AUDIT_ACTIONS, recordAudit } from './audit.service';
import { computeCumulativeAmount, getActiveRules, getPeriodContext, nextThreshold, periodKeyFor } from './balance.service';
import { findPendingInvoice } from './ingestion.service';
import { publish } from './realtime.service';
import { getSettlementStrategy } from './settlement';

const env = loadEnv();

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  CARD SCAN — attribution and instant discount (CLAUDE_v3.md §2.4, §6.2)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The customer scans at the Loyalty Station and one of three things happens
 * (§6.2 #3): they qualify and a slip prints, they do not yet and see how far away
 * they are, or the card is unknown and registration is offered.
 *
 * ── The rules that constrain every line below ──────────────────────────────
 *
 * 1. **The system never computes a price.** It reads `amountGross` exactly as the
 *    POS recorded it and derives a discount from it. There is one set of books —
 *    the POS's — and this mirrors it (§0 rule 4).
 *
 * 2. **No flow may create a cash-vs-POS discrepancy** (§0 rule 3). A discount is
 *    only ever recorded together with the voucher that explains it, in one
 *    transaction. If the voucher cannot be written, the discount is not written
 *    either — a drawer short by an unexplained amount reads as theft.
 *
 * 3. **"Not qualified" is framed as progress, never rejection.** A paying customer
 *    at a till is not failing a test; they are being told what the next visit
 *    earns. That is a sales prompt, and the wording matters.
 */

export interface ScanContext {
  merchantId: string;
  userId: string;
  /** The branch this station serves. Required — a station belongs to one till area. */
  branchId: string | null;
  stationId?: string;
}

function serializeVoucher(voucher: {
  id: string;
  transactionId: string;
  customerId: string;
  code: string;
  value: number;
  settlementStrategy: string;
  status: string;
  issuedAt: Date;
  redeemedAt: Date | null;
}): VoucherDto {
  return {
    id: voucher.id,
    transactionId: voucher.transactionId,
    customerId: voucher.customerId,
    code: voucher.code,
    value: voucher.value,
    settlementStrategy: voucher.settlementStrategy as VoucherDto['settlementStrategy'],
    status: voucher.status as VoucherDto['status'],
    issuedAt: voucher.issuedAt.toISOString(),
    redeemedAt: voucher.redeemedAt ? voucher.redeemedAt.toISOString() : null,
  };
}

export async function scanCard(
  context: ScanContext,
  request: ScanCardRequest,
): Promise<ScanCardResponse> {
  const branchId = context.branchId;
  if (!branchId) throw forbidden('هذه المحطة غير مرتبطة بفرع');

  const token = request.barcodeToken.trim();

  /* ── 1. Who is this? ────────────────────────────────────────────────────── */

  // Signature check before any database work: a mis-scan or a forged code is
  // rejected without a query, which keeps the station fast under a queue.
  const plausible = looksLikeBarcodeToken(token) && verifyBarcodeToken(token, env.QR_TOKEN_SECRET);

  const customer = plausible
    ? await prisma.customer.findFirst({
        where: {
          // Bare digits are the storage form, so a number typed back with the
          // grouping printed on the card finds the same row the scanner does.
          barcodeToken: canonicalizeBarcodeToken(token),
          merchantId: context.merchantId,
          isActive: true,
        },
      })
    : null;

  if (!customer) {
    // Not an error — an unknown card is an enrolment opportunity, and the station
    // offers registration rather than showing a failure (§6.2 #3).
    return {
      outcome: 'UNKNOWN_CARD',
      customer: null,
      transaction: null,
      balance: null,
      voucher: null,
      progressMessage: null,
    };
  }

  /* ── 2. Which invoice? ──────────────────────────────────────────────────── */

  const pending = await findPendingInvoice(context.merchantId, branchId, {
    invoiceId: request.invoiceId,
  });

  if (!pending) {
    // A retried scan is the common cause: the station lost the response and sent
    // again, but the invoice is already attributed. Return that original outcome
    // rather than a confusing "nothing pending".
    const alreadyAttributed = request.invoiceId
      ? await prisma.transaction.findFirst({
          where: {
            merchantId: context.merchantId,
            branchId,
            invoiceId: request.invoiceId,
            customerId: customer.id,
          },
          include: { vouchers: true, branch: { select: { code: true } } },
        })
      : null;

    if (alreadyAttributed) {
      const balance = await buildBalance(context.merchantId, customer.id);
      const voucher = alreadyAttributed.vouchers[0];
      return {
        outcome: alreadyAttributed.discountValue > 0 ? 'QUALIFIED' : 'NOT_QUALIFIED',
        customer: {
          id: customer.id,
          name: customer.name,
          phone: customer.phone,
          category: customer.category,
        },
        transaction: serializeTransaction(alreadyAttributed, alreadyAttributed.branch.code),
        balance,
        voucher: voucher ? serializeVoucher(voucher) : null,
        progressMessage:
          alreadyAttributed.discountValue > 0 ? null : progressMessage(balance),
      };
    }

    const balance = await buildBalance(context.merchantId, customer.id);
    return {
      outcome: 'NO_PENDING_INVOICE',
      customer: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        category: customer.category,
      },
      transaction: null,
      balance,
      voucher: null,
      progressMessage: null,
    };
  }

  /* ── 3. Attribute, evaluate, and settle — atomically ────────────────────── */

  const settings = await prisma.discountSettings.findUniqueOrThrow({
    where: { merchantId: context.merchantId },
  });
  const rules = await getActiveRules(context.merchantId);

  // Cumulative spend INCLUDING this invoice. The customer's standing is what they
  // have spent by the time they reach the till, this basket included — otherwise
  // the basket that crosses a threshold would not itself be discounted.
  const priorTotals = await computeCumulativeAmount(customer.id, pending.periodKey);
  const cumulativeWithThis = priorTotals.cumulativeAmount + pending.amountGross;

  const computation = computeDiscount({
    amountGross: pending.amountGross,
    cumulativeAmount: cumulativeWithThis,
    rules,
    absoluteMaxDiscountValue: settings.absoluteMaxDiscountValue,
    discountTypeSetting: settings.discountType as 'PERCENTAGE' | 'FIXED_AMOUNT' | 'NONE',
  });

  const now = new Date();
  const discountLabel =
    computation.discountType === 'PERCENTAGE'
      ? `${computation.discountRate}٪`
      : formatIqd(computation.discountRate);

  const result = await prisma.$transaction(async (db) => {
    // Claim the invoice conditionally: `customerId: null` in the WHERE means two
    // simultaneous scans cannot both attribute the same capture. The loser sees
    // count 0 and is handled below.
    const claimed = await db.transaction.updateMany({
      where: { id: pending.id, customerId: null },
      data: {
        customerId: customer.id,
        linkedAt: now,
        linkedByUserId: context.userId,
        stationId: context.stationId ?? null,
        discountType: computation.discountValue > 0 ? computation.discountType : 'NONE',
        discountRate: computation.discountValue > 0 ? computation.discountRate : 0,
        discountValue: computation.discountValue,
        amountNet: computation.amountNet,
      },
    });

    if (claimed.count === 0) return null;

    let voucherRow = null;

    if (computation.discountValue > 0) {
      const strategy = getSettlementStrategy(settings.settlementStrategy);
      const outcome = strategy.settle({
        merchantId: context.merchantId,
        transactionId: pending.id,
        customerId: customer.id,
        customerName: customer.name,
        invoiceId: pending.invoiceId,
        amountGross: pending.amountGross,
        discountValue: computation.discountValue,
        amountNet: computation.amountNet,
        discountLabel,
        issuedAt: now,
      });

      // Written in the SAME transaction as the discount above. If this fails, the
      // discount rolls back with it — there is no state where a customer paid less
      // than the POS recorded with nothing in the books to explain it (§0 rule 3).
      voucherRow = await db.voucher.create({
        data: {
          merchantId: context.merchantId,
          transactionId: pending.id,
          customerId: customer.id,
          code: outcome.code,
          value: outcome.value,
          settlementStrategy: outcome.strategy,
          status: 'ISSUED',
          issuedAt: now,
        },
      });

      await recordAudit(
        {
          merchantId: context.merchantId,
          actorUserId: context.userId,
          action: AUDIT_ACTIONS.VOUCHER_ISSUED,
          entityType: 'voucher',
          entityId: voucherRow.id,
          after: {
            code: outcome.code,
            value: outcome.value,
            strategy: outcome.strategy,
            invoiceId: pending.invoiceId,
            amountGross: pending.amountGross,
            amountNet: computation.amountNet,
            cumulativeAmount: cumulativeWithThis,
            wasCapped: computation.wasCapped,
          },
        },
        db,
      );
    }

    await recordAudit(
      {
        merchantId: context.merchantId,
        actorUserId: context.userId,
        action: AUDIT_ACTIONS.INVOICE_ATTRIBUTED,
        entityType: 'transaction',
        entityId: pending.id,
        before: { customerId: null },
        after: {
          customerId: customer.id,
          discountValue: computation.discountValue,
          amountNet: computation.amountNet,
        },
      },
      db,
    );

    const updated = await db.transaction.findUniqueOrThrow({
      where: { id: pending.id },
      include: { branch: { select: { code: true } } },
    });

    return { transaction: updated, voucher: voucherRow };
  });

  // Another station claimed the invoice first. Report it as nothing pending
  // rather than inventing a second discount on one sale.
  if (!result) {
    const balance = await buildBalance(context.merchantId, customer.id);
    return {
      outcome: 'NO_PENDING_INVOICE',
      customer: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        category: customer.category,
      },
      transaction: null,
      balance,
      voucher: null,
      progressMessage: null,
    };
  }

  const balance = await buildBalance(context.merchantId, customer.id);

  publish(context.merchantId, {
    type: 'CARD_SCANNED',
    transactionId: result.transaction.id,
    customerId: customer.id,
    qualified: computation.discountValue > 0,
    at: now.toISOString(),
  });

  if (result.voucher) {
    publish(context.merchantId, {
      type: 'VOUCHER_ISSUED',
      voucherId: result.voucher.id,
      value: result.voucher.value,
      at: now.toISOString(),
    });
  }

  return {
    outcome: computation.discountValue > 0 ? 'QUALIFIED' : 'NOT_QUALIFIED',
    customer: {
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      category: customer.category,
    },
    transaction: serializeTransaction(result.transaction, result.transaction.branch.code),
    balance,
    voucher: result.voucher ? serializeVoucher(result.voucher) : null,
    progressMessage: computation.discountValue > 0 ? null : progressMessage(balance),
  };
}

/**
 * The sentence shown when a customer has not yet qualified.
 *
 * Deliberately forward-looking: it names what is coming, not what was missed.
 * "You are 12,000 away from a 3% discount" invites another basket; "you do not
 * qualify" ends the conversation.
 */
function progressMessage(balance: {
  amountToNextThreshold: number | null;
  nextDiscountLabel: string | null;
}): string {
  if (balance.amountToNextThreshold === null || balance.nextDiscountLabel === null) {
    return 'لقد بلغت أعلى مستوى — شكراً لولائك!';
  }
  return `تبقّى ${formatIqd(balance.amountToNextThreshold)} للحصول على خصم ${balance.nextDiscountLabel}`;
}

async function buildBalance(merchantId: string, customerId: string) {
  const context = await getPeriodContext(merchantId);
  const periodKey = periodKeyFor(context, new Date());
  const [totals, rules] = await Promise.all([
    computeCumulativeAmount(customerId, periodKey),
    getActiveRules(merchantId),
  ]);
  const gap = nextThreshold(rules, totals.cumulativeAmount);

  return {
    periodKey,
    cumulativeAmount: totals.cumulativeAmount,
    transactionCount: totals.transactionCount,
    nextThresholdAmount: gap.nextThresholdAmount,
    amountToNextThreshold: gap.amountToNextThreshold,
    nextDiscountLabel: gap.nextDiscountLabel,
  };
}

export function serializeTransaction(
  t: {
    id: string;
    customerId: string | null;
    branchId: string;
    invoiceId: string;
    amountGross: number;
    discountType: string;
    discountRate: number;
    discountValue: number;
    amountNet: number;
    captureMode: string;
    periodKey: string;
    occurredAt: Date;
    capturedAt: Date;
    linkedAt: Date | null;
    createdAt: Date;
  },
  branchCode: string,
) {
  return {
    id: t.id,
    customerId: t.customerId,
    branchId: t.branchId,
    branchCode,
    invoiceId: t.invoiceId,
    amountGross: t.amountGross,
    discountType: t.discountType as 'PERCENTAGE' | 'FIXED_AMOUNT' | 'NONE',
    discountRate: t.discountRate,
    discountValue: t.discountValue,
    amountNet: t.amountNet,
    currency: 'IQD' as const,
    captureMode: t.captureMode as 'SPOOL_WATCH' | 'VIRTUAL_PRINTER' | 'SERIAL_BRIDGE' | 'NETWORK_PROXY' | 'MANUAL',
    periodKey: t.periodKey,
    occurredAt: t.occurredAt.toISOString(),
    capturedAt: t.capturedAt.toISOString(),
    linkedAt: t.linkedAt ? t.linkedAt.toISOString() : null,
    createdAt: t.createdAt.toISOString(),
  };
}

/** Everything the station needs to print the discount slip (§6.3). */
export function buildDiscountSlip(params: {
  voucherCode: string;
  invoiceId: string;
  customerName: string;
  amountGross: number;
  discountLabel: string;
  discountValue: number;
  amountNet: number;
  issuedAt: Date;
  cashierInstruction: string;
}) {
  return {
    voucherCode: params.voucherCode,
    invoiceId: params.invoiceId,
    customerName: params.customerName,
    amountBefore: params.amountGross,
    discountLabel: params.discountLabel,
    discountValue: params.discountValue,
    amountAfter: params.amountNet,
    issuedAt: params.issuedAt.toISOString(),
    cashierInstruction: params.cashierInstruction,
  };
}
