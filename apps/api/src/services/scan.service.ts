import {
  computeDiscount,
  formatIqd,
  type IdentifyCardRequest,
  type IdentifyCardResponse,
  type ScanCardRequest,
  type ScanCardResponse,
  type ScanCustomer,
  type Voucher as VoucherDto,
} from '@walaa/shared-types';
import { forbidden } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { writeTransaction } from '../lib/write-transaction';
import { AUDIT_ACTIONS, recordAudit } from './audit.service';
import { ensureDiscountSettings } from './discount-settings.service';
import { lookupCard } from './card.service';
import {
  bracketMessage,
  getActiveRules,
  getCustomerLifetime,
  invoiceOutcome,
} from './lifetime.service';
import { findPendingInvoice } from './ingestion.service';
import { publish } from './realtime.service';
import { getSettlementStrategy } from './settlement';

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

export interface ScanOptions {
  /**
   * Whether this scan may issue a discount and a voucher. Default true.
   *
   * The offline queue sets it false, and the reason is an accounting one. A scan
   * queued while the station was unreachable replays *after* the customer has paid
   * and left. Issuing a discount then would create a voucher the books expect to
   * find in the drawer and a slip that was never printed — precisely the cash-vs-POS
   * discrepancy §0 rule 3 forbids, arriving hours later with nobody able to explain
   * it.
   *
   * The spend is still credited to the customer, because they did buy the goods and
   * the shop's network is not their fault. They lose the discount on that one
   * basket, not their progress toward the next.
   */
  issueDiscount?: boolean;
}

function toScanCustomer(customer: {
  id: string;
  name: string;
  phone: string;
  category: string;
}): ScanCustomer {
  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    category: customer.category,
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  IDENTIFY — step 1 of the guided flow: who is this, and nothing else
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * CLAUDE.md §0 rule 1 and §1.2: **customer identity is always captured before the
 * invoice.** The station asks for the card first, and until it knows who is standing
 * there it must not touch a sale.
 *
 * So this reads and returns. It claims no invoice, computes no discount, issues no
 * voucher, and writes no row. Everything that commits lives in `scanCard` below,
 * and the separation is the point: a lookup that could commit is a lookup that
 * eventually will.
 *
 * The pending capture travels back with the answer so the operator can check the
 * invoice number and total against the paper in their hand before attributing it —
 * a read of what the POS already recorded, never a computation (§0 rule 4).
 */
export async function identifyCard(
  context: ScanContext,
  request: IdentifyCardRequest,
): Promise<IdentifyCardResponse> {
  const branchId = context.branchId;
  if (!branchId) throw forbidden('هذه المحطة غير مرتبطة بفرع');

  const lookup = await lookupCard(context.merchantId, request.barcodeToken.trim());

  if (!lookup.ok) {
    // The same two doors as `scanCard`, for the same reason (§12.25): an unknown or
    // blank card is an enrolment opportunity, a dead one is a conversation.
    const enrolment = lookup.rejection === 'UNKNOWN' || lookup.rejection === 'UNASSIGNED';
    return {
      outcome: enrolment ? 'UNKNOWN_CARD' : 'CARD_REJECTED',
      cardRejection: lookup.rejection,
      scannedCard: lookup.card,
      customer: null,
      lifetime: null,
      pendingInvoice: null,
    };
  }

  const customer = await prisma.customer.findFirst({
    where: { id: lookup.customerId, merchantId: context.merchantId, isActive: true },
  });

  if (!customer) {
    return {
      outcome: 'CARD_REJECTED',
      cardRejection: 'INACTIVE_CUSTOMER',
      scannedCard: null,
      customer: null,
      lifetime: null,
      pendingInvoice: null,
    };
  }

  const [lifetime, pending] = await Promise.all([
    getCustomerLifetime(customer.id),
    findPendingInvoice(context.merchantId, branchId),
  ]);

  return {
    outcome: 'IDENTIFIED',
    cardRejection: null,
    scannedCard: null,
    customer: toScanCustomer(customer),
    lifetime,
    pendingInvoice: pending
      ? {
          invoiceId: pending.invoiceId,
          amountGross: pending.amountGross,
          capturedAt: pending.capturedAt.toISOString(),
        }
      : null,
  };
}

export async function scanCard(
  context: ScanContext,
  request: ScanCardRequest,
  options: ScanOptions = {},
): Promise<ScanCardResponse> {
  const issueDiscount = options.issueDiscount ?? true;
  const branchId = context.branchId;
  if (!branchId) throw forbidden('هذه المحطة غير مرتبطة بفرع');

  const token = request.barcodeToken.trim();

  /* ── 1. Who is this? ────────────────────────────────────────────────────── */

  // The check code is verified inside `lookupCard` before any database work, so a
  // mis-scan or a forged number is rejected without a query — fast under a queue,
  // and no enumeration oracle for an attacker.
  const lookup = await lookupCard(context.merchantId, token);

  if (!lookup.ok) {
    // Two different situations, and they lead to different doors (§12.25).
    //
    // An unknown number or a blank card is an enrolment opportunity: the station
    // offers registration, and on a blank it registers onto the card in the
    // operator's hand rather than minting a fresh one and wasting it (§6.2 #3).
    //
    // A card that was reported lost, superseded or voided is not an enrolment
    // opportunity — the person almost certainly has an account already — so it is
    // refused with the honest reason, and the station says which.
    const enrolment = lookup.rejection === 'UNKNOWN' || lookup.rejection === 'UNASSIGNED';
    return {
      outcome: enrolment ? 'UNKNOWN_CARD' : 'CARD_REJECTED',
      cardRejection: lookup.rejection,
      scannedCard: lookup.card,
      customer: null,
      transaction: null,
      lifetime: null,
      invoiceOutcome: null,
      voucher: null,
      slip: null,
      progressMessage: null,
    };
  }

  const customer = await prisma.customer.findFirst({
    where: { id: lookup.customerId, merchantId: context.merchantId, isActive: true },
  });

  if (!customer) {
    // The card points at a customer this scan cannot use. `lookupCard` already
    // screens deactivated accounts, so reaching here means the row vanished between
    // the two queries — vanishingly rare, and still not a reason to guess.
    return {
      outcome: 'CARD_REJECTED',
      cardRejection: 'INACTIVE_CUSTOMER',
      scannedCard: null,
      customer: null,
      transaction: null,
      lifetime: null,
      invoiceOutcome: null,
      voucher: null,
      slip: null,
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
      const [lifetime, rules] = await Promise.all([
        getCustomerLifetime(customer.id),
        getActiveRules(context.merchantId),
      ]);
      const outcome = invoiceOutcome(rules, alreadyAttributed.amountGross);
      const voucher = alreadyAttributed.vouchers[0];
      return {
        outcome: alreadyAttributed.discountValue > 0 ? 'QUALIFIED' : 'NOT_QUALIFIED',
        cardRejection: null,
        scannedCard: null,
        customer: toScanCustomer(customer),
        transaction: serializeTransaction(alreadyAttributed, alreadyAttributed.branch.code),
        lifetime,
        invoiceOutcome: outcome,
        voucher: voucher ? serializeVoucher(voucher) : null,
        // The slip is rebuilt so a station that lost the first response can still
        // print the paper the customer is waiting for. The words come from the
        // strategy recorded ON THE VOUCHER, not from today's setting: a merchant who
        // switches strategy must not retroactively reword slips already in the
        // drawer (§5.2).
        slip: voucher
          ? buildDiscountSlip({
              voucherCode: voucher.code,
              invoiceId: alreadyAttributed.invoiceId,
              customerName: customer.name,
              amountGross: alreadyAttributed.amountGross,
              discountLabel: formatDiscountLabel(
                alreadyAttributed.discountType,
                alreadyAttributed.discountRate,
                alreadyAttributed.discountValue,
              ),
              discountValue: alreadyAttributed.discountValue,
              amountNet: alreadyAttributed.amountNet,
              issuedAt: voucher.issuedAt,
              cashierInstruction: getSettlementStrategy(voucher.settlementStrategy).describe({
                merchantId: context.merchantId,
                transactionId: alreadyAttributed.id,
                customerId: customer.id,
                customerName: customer.name,
                invoiceId: alreadyAttributed.invoiceId,
                amountGross: alreadyAttributed.amountGross,
                discountValue: alreadyAttributed.discountValue,
                amountNet: alreadyAttributed.amountNet,
                discountLabel: formatDiscountLabel(
                  alreadyAttributed.discountType,
                  alreadyAttributed.discountRate,
                  alreadyAttributed.discountValue,
                ),
                issuedAt: voucher.issuedAt,
              }).cashierInstruction,
            })
          : null,
        progressMessage: alreadyAttributed.discountValue > 0 ? null : bracketMessage(outcome),
      };
    }

    const lifetime = await getCustomerLifetime(customer.id);
    return {
      outcome: 'NO_PENDING_INVOICE',
      cardRejection: null,
      scannedCard: null,
      customer: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        category: customer.category,
      },
      transaction: null,
      lifetime,
      // No invoice was named, so there is nothing to place on the ladder. Absent
      // rather than half-null — that is the whole reason it is its own shape (§10.4).
      invoiceOutcome: null,
      voucher: null,
      slip: null,
      progressMessage: null,
    };
  }

  /* ── 3. Attribute, evaluate, and settle — atomically ────────────────────── */

  /*
    `ensureDiscountSettings`, not `findUniqueOrThrow`.

    The throw was a 500 at the till — «لم تُحفظ العملية … أبلغ الإدارة فوراً» — for a
    missing configuration row with defined defaults, and it fired on the FIRST SALE of
    every installation because nothing outside the development seed ever created one.
    See `discount-settings.service.ts`.
  */
  const settings = await ensureDiscountSettings(context.merchantId);
  const rules = await getActiveRules(context.merchantId);

  // ═══ THE v4 CHANGE (§1.1) ═══
  // The discount comes from this invoice's amount and nothing else. There is no
  // history lookup here, and there cannot be one: `computeDiscount` no longer has a
  // parameter to receive it (§12.27's removal corollary).
  //
  // The card still decides *whether* a discount is possible — an unattributed capture
  // never reaches this line — which is what §1.2 means by the card being the entitlement
  // rather than the calculation.
  const computed = computeDiscount({
    amountGross: pending.amountGross,
    rules,
    absoluteMaxDiscountValue: settings.absoluteMaxDiscountValue,
    discountTypeSetting: settings.discountType as 'PERCENTAGE' | 'FIXED_AMOUNT' | 'NONE',
  });

  // A deferred scan records what the customer actually paid: full price. Anything
  // else would put a discount in the ledger that never reached the till.
  const computation = issueDiscount
    ? computed
    : {
        ...computed,
        discountType: 'NONE' as const,
        discountRate: 0,
        discountValue: 0,
        amountNet: pending.amountGross,
        wasCapped: false,
      };

  const now = new Date();
  const discountLabel = formatDiscountLabel(
    computation.discountType,
    computation.discountRate,
    computation.discountValue,
  );

  const result = await writeTransaction(async (db) => {
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
        // What the ladder called for before §2.3's cap, a tier's own ceiling, or a
        // basket smaller than the discount trimmed it. Equal to `discountValue`
        // when nothing bound, so the pair is self-describing: `uncapped > value`
        // means the cap bit, and the difference is what it saved (§12.37).
        discountUncappedValue: computation.discountValue > 0 ? computation.uncappedValue : 0,
        amountNet: computation.amountNet,
      },
    });

    if (claimed.count === 0) return null;

    let voucherRow = null;
    let settlementNarrative: { cashierInstruction: string } | null = null;

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
      settlementNarrative = { cashierInstruction: outcome.cashierInstruction };

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

    return { transaction: updated, voucher: voucherRow, narrative: settlementNarrative };
  });

  // Another station claimed the invoice first. Report it as nothing pending
  // rather than inventing a second discount on one sale.
  if (!result) {
    const lifetime = await getCustomerLifetime(customer.id);
    return {
      outcome: 'NO_PENDING_INVOICE',
      cardRejection: null,
      scannedCard: null,
      customer: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        category: customer.category,
      },
      transaction: null,
      lifetime,
      // No invoice was named, so there is nothing to place on the ladder. Absent
      // rather than half-null — that is the whole reason it is its own shape (§10.4).
      invoiceOutcome: null,
      voucher: null,
      slip: null,
      progressMessage: null,
    };
  }

  const lifetime = await getCustomerLifetime(customer.id);
  const outcome = invoiceOutcome(rules, result.transaction.amountGross);

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
    outcome: !issueDiscount
      ? 'LINKED_WITHOUT_DISCOUNT'
      : computation.discountValue > 0
        ? 'QUALIFIED'
        : 'NOT_QUALIFIED',
    cardRejection: null,
    scannedCard: null,
    customer: toScanCustomer(customer),
    transaction: serializeTransaction(result.transaction, result.transaction.branch.code),
    lifetime,
    invoiceOutcome: outcome,
    voucher: result.voucher ? serializeVoucher(result.voucher) : null,
    slip:
      result.voucher && result.narrative
        ? buildDiscountSlip({
            voucherCode: result.voucher.code,
            invoiceId: result.transaction.invoiceId,
            customerName: customer.name,
            amountGross: result.transaction.amountGross,
            discountLabel,
            discountValue: computation.discountValue,
            amountNet: computation.amountNet,
            issuedAt: result.voucher.issuedAt,
            cashierInstruction: result.narrative.cashierInstruction,
          })
        : null,
    progressMessage: computation.discountValue > 0 ? null : bracketMessage(outcome),
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
    captureMode: t.captureMode as
      'SPOOL_WATCH' | 'VIRTUAL_PRINTER' | 'SERIAL_BRIDGE' | 'NETWORK_PROXY' | 'MANUAL',
    occurredAt: t.occurredAt.toISOString(),
    capturedAt: t.capturedAt.toISOString(),
    linkedAt: t.linkedAt ? t.linkedAt.toISOString() : null,
    createdAt: t.createdAt.toISOString(),
  };
}

/**
 * `3٪` or `5,000 د.ع` — how the discount reads on the slip and on screen.
 *
 * **A fixed-amount label states the value that was APPLIED, not the rate that was
 * configured.** The two differ whenever a cap bit: §2.3's absolute ceiling, a tier's
 * own `maxDiscountValue`, or a basket smaller than the discount. Labelling the
 * configured 7,500 beside an applied 5,000 puts two different sums of money on one
 * line of a slip a cashier acts on, and the cashier has no way to know which one to
 * take off the till. Found by looking at the printed slip rendered on screen — a unit
 * test on the formatter could not see it, which is §12.27 exactly.
 *
 * A percentage keeps its rate, because a rate and a sum are in different units and
 * cannot be confused for one another: `3٪` beside `− 5,000 د.ع` reads correctly even
 * when the cap has bitten.
 */
function formatDiscountLabel(
  discountType: string,
  discountRate: number,
  discountValue: number,
): string {
  return discountType === 'PERCENTAGE' ? `${discountRate}٪` : formatIqd(discountValue);
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
