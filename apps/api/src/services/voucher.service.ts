import {
  DEFAULT_MERCHANT_TIMEZONE,
  formatIqd,
  localDateKey,
  localDayBounds,
  type VoucherReconciliation,
} from '@walaa/shared-types';
import { AppError, notFound } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { writeTransaction } from '../lib/write-transaction';
import { AUDIT_ACTIONS, recordAudit } from './audit.service';
import { DEFAULT_SETTLEMENT_STRATEGY, getSettlementStrategy } from './settlement';

/**
 * Voucher lifecycle and end-of-day reconciliation.
 *
 * A voucher is the paper record that keeps the books honest (§9). Redemption is a
 * state transition, never a delete, because the whole point is that the row can
 * still be matched against a slip in the drawer weeks later.
 */

export async function listCustomerVouchers(merchantId: string, customerId: string) {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, merchantId },
    select: { id: true },
  });
  if (!customer) throw notFound('الزبون غير موجود');

  return prisma.voucher.findMany({
    where: { merchantId, customerId },
    orderBy: { issuedAt: 'desc' },
  });
}

/**
 * Marks a voucher redeemed — one atomic conditional UPDATE, and its audit row
 * committed with it.
 *
 * Every precondition sits in the WHERE clause, so the statement either claims
 * exactly one ISSUED row or claims nothing. A read-then-write would let two
 * cashiers both settle the same slip, which is precisely a cash discrepancy.
 *
 * ── Why the audit row is inside the same transaction ─────────────────────────
 *
 * It was not, and the gap was reproduced rather than theorised. With a delay
 * inserted between the UPDATE and `recordAudit`, `Stop-Process -Force` on the API
 * left voucher `UJQY-7JA7` at `status = REDEEMED, redeemedAt = 02:21:52` with no
 * `voucher.redeemed` row anywhere in `audit_log` — and no way to recover it, because
 * a second attempt at the same slip is correctly refused as "already used" and writes
 * nothing either.
 *
 * That is money out of the drawer with nothing in the append-only trail to explain
 * it, which is the exact shape of the discrepancy §0 rule 3 and §7.10 exist to
 * prevent, and it is what `recordAudit`'s own doc comment already warned about:
 * *a redemption that commits without its audit row is worse than one that fails
 * outright*. `scanCard` had it right and this did not.
 *
 * Two statements in one transaction cost nothing here — this is a single-writer
 * SQLite database and the redemption is already the write.
 */
export async function redeemVoucher(params: {
  merchantId: string;
  voucherId: string;
  actorUserId: string;
}) {
  const now = new Date();

  const voucher = await writeTransaction(async (db) => {
    const claimed = await db.voucher.updateMany({
      where: { id: params.voucherId, merchantId: params.merchantId, status: 'ISSUED' },
      data: { status: 'REDEEMED', redeemedAt: now, redeemedByUserId: params.actorUserId },
    });

    // Nothing was claimed: leave the transaction without having written, and let the
    // caller below explain why from a fresh read. Diagnosing inside the transaction
    // would hold a write lock open to answer a question with no write in it.
    if (claimed.count === 0) return null;

    const row = await db.voucher.findUniqueOrThrow({ where: { id: params.voucherId } });

    await recordAudit(
      {
        merchantId: params.merchantId,
        actorUserId: params.actorUserId,
        action: AUDIT_ACTIONS.VOUCHER_REDEEMED,
        entityType: 'voucher',
        entityId: row.id,
        before: { status: 'ISSUED' },
        after: { status: 'REDEEMED', value: row.value, redeemedAt: now.toISOString() },
      },
      db,
    );

    return row;
  });

  if (!voucher) {
    const existing = await prisma.voucher.findFirst({
      where: { id: params.voucherId, merchantId: params.merchantId },
    });
    if (!existing) throw notFound('القسيمة غير موجودة');
    if (existing.status === 'REDEEMED') {
      throw new AppError('COUPON_NOT_REDEEMABLE', 'تم استخدام هذه القسيمة مسبقاً');
    }
    throw new AppError('COUPON_NOT_REDEEMABLE', 'هذه القسيمة ملغاة');
  }

  const strategy = getSettlementStrategy(voucher.settlementStrategy);

  return {
    voucher,
    accountingNote: strategy.settle({
      merchantId: params.merchantId,
      transactionId: voucher.transactionId,
      customerId: voucher.customerId,
      customerName: '',
      invoiceId: '',
      amountGross: 0,
      discountValue: voucher.value,
      amountNet: 0,
      discountLabel: formatIqd(voucher.value),
      issuedAt: voucher.issuedAt,
    }).accountingNote,
  };
}

/**
 * Voids a voucher — e.g. the customer walked away without completing the sale.
 *
 * Transactional for the same reason as `redeemVoucher` above, and it is the worse of
 * the two to leave un-audited: voiding writes off a discount that was already granted
 * and printed, so the row that says *who* cancelled it and *why* is the only record
 * distinguishing a walked-away customer from a cashier quietly erasing a slip.
 */
export async function voidVoucher(params: {
  merchantId: string;
  voucherId: string;
  actorUserId: string;
  reason: string;
}) {
  const voided = await writeTransaction(async (db) => {
    const claimed = await db.voucher.updateMany({
      where: { id: params.voucherId, merchantId: params.merchantId, status: 'ISSUED' },
      data: { status: 'VOID' },
    });
    if (claimed.count === 0) return false;

    await recordAudit(
      {
        merchantId: params.merchantId,
        actorUserId: params.actorUserId,
        action: AUDIT_ACTIONS.VOUCHER_VOIDED,
        entityType: 'voucher',
        entityId: params.voucherId,
        after: { status: 'VOID', reason: params.reason },
      },
      db,
    );

    return true;
  });

  if (!voided) throw new AppError('COUPON_NOT_REDEEMABLE', 'لا يمكن إلغاء هذه القسيمة');
}

/**
 * End-of-day reconciliation (§5.2, §8 `voucher_reconciliation`).
 *
 * `outstanding` is the number that matters to a manager: slips issued to customers
 * that were never collected. A persistent gap means either the cashier is not
 * taking them or the customers are not handing them over, and either way the
 * drawer will not match what the system believes was discounted.
 *
 * **The day is the merchant's local day, not the UTC one.** This bucketed by
 * `setUTCHours(0,0,0,0)` until the V3-6 review, which in Baghdad (UTC+3) files anything
 * issued before 03:00 local under the previous day — the same class of error §13.1
 * settled for loyalty periods. It was invisible only because the shop is shut at that
 * hour, which is a coincidence of opening times rather than a property of the code, and
 * it stops holding for a merchant who trades late or sits in another zone. A
 * reconciliation report that disagrees with the drawer by one day's vouchers is worse
 * than no report: it sends someone looking for a theft that did not happen.
 */
export async function reconcileDay(
  merchantId: string,
  /** An instant to take the local day of, or a local `YYYY-MM-DD` to report on. */
  day: Date | string = new Date(),
): Promise<VoucherReconciliation> {
  const merchant = await prisma.merchant.findUnique({
    where: { id: merchantId },
    select: { timezone: true },
  });
  const timeZone = merchant?.timezone ?? DEFAULT_MERCHANT_TIMEZONE;
  const { start, end } = localDayBounds(day, timeZone);

  const vouchers = await prisma.voucher.findMany({
    where: { merchantId, issuedAt: { gte: start, lt: end } },
  });

  const settings = await prisma.discountSettings.findUnique({ where: { merchantId } });

  const sum = (list: typeof vouchers) => list.reduce((total, v) => total + v.value, 0);
  const issued = vouchers;
  const redeemed = vouchers.filter((v) => v.status === 'REDEEMED');
  const voided = vouchers.filter((v) => v.status === 'VOID');
  const outstanding = vouchers.filter((v) => v.status === 'ISSUED');

  return {
    // The local calendar date the window belongs to — `start` in UTC is the previous
    // day's evening for any zone east of Greenwich.
    date: localDateKey(start, timeZone),
    issuedCount: issued.length,
    issuedValue: sum(issued),
    redeemedCount: redeemed.length,
    redeemedValue: sum(redeemed),
    voidCount: voided.length,
    outstandingCount: outstanding.length,
    outstandingValue: sum(outstanding),
    settlementStrategy: (settings?.settlementStrategy ??
      DEFAULT_SETTLEMENT_STRATEGY) as VoucherReconciliation['settlementStrategy'],
  };
}
