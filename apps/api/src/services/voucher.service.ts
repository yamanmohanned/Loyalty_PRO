import { formatIqd, type VoucherReconciliation } from '@walaa/shared-types';
import { AppError, notFound } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { AUDIT_ACTIONS, recordAudit } from './audit.service';
import { getSettlementStrategy } from './settlement';

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
 * Marks a voucher redeemed — one atomic conditional UPDATE.
 *
 * Every precondition sits in the WHERE clause, so the statement either claims
 * exactly one ISSUED row or claims nothing. A read-then-write would let two
 * cashiers both settle the same slip, which is precisely a cash discrepancy.
 */
export async function redeemVoucher(params: {
  merchantId: string;
  voucherId: string;
  actorUserId: string;
}) {
  const now = new Date();

  const claimed = await prisma.voucher.updateMany({
    where: { id: params.voucherId, merchantId: params.merchantId, status: 'ISSUED' },
    data: { status: 'REDEEMED', redeemedAt: now, redeemedByUserId: params.actorUserId },
  });

  if (claimed.count === 0) {
    const existing = await prisma.voucher.findFirst({
      where: { id: params.voucherId, merchantId: params.merchantId },
    });
    if (!existing) throw notFound('القسيمة غير موجودة');
    if (existing.status === 'REDEEMED') {
      throw new AppError('COUPON_NOT_REDEEMABLE', 'تم استخدام هذه القسيمة مسبقاً');
    }
    throw new AppError('COUPON_NOT_REDEEMABLE', 'هذه القسيمة ملغاة');
  }

  const voucher = await prisma.voucher.findUniqueOrThrow({ where: { id: params.voucherId } });

  await recordAudit({
    merchantId: params.merchantId,
    actorUserId: params.actorUserId,
    action: AUDIT_ACTIONS.VOUCHER_REDEEMED,
    entityType: 'voucher',
    entityId: voucher.id,
    before: { status: 'ISSUED' },
    after: { status: 'REDEEMED', value: voucher.value, redeemedAt: now.toISOString() },
  });

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

/** Voids a voucher — e.g. the customer walked away without completing the sale. */
export async function voidVoucher(params: {
  merchantId: string;
  voucherId: string;
  actorUserId: string;
  reason: string;
}) {
  const claimed = await prisma.voucher.updateMany({
    where: { id: params.voucherId, merchantId: params.merchantId, status: 'ISSUED' },
    data: { status: 'VOID' },
  });
  if (claimed.count === 0) throw new AppError('COUPON_NOT_REDEEMABLE', 'لا يمكن إلغاء هذه القسيمة');

  await recordAudit({
    merchantId: params.merchantId,
    actorUserId: params.actorUserId,
    action: AUDIT_ACTIONS.VOUCHER_VOIDED,
    entityType: 'voucher',
    entityId: params.voucherId,
    after: { status: 'VOID', reason: params.reason },
  });
}

/**
 * End-of-day reconciliation (§5.2, §8 `voucher_reconciliation`).
 *
 * `outstanding` is the number that matters to a manager: slips issued to customers
 * that were never collected. A persistent gap means either the cashier is not
 * taking them or the customers are not handing them over, and either way the
 * drawer will not match what the system believes was discounted.
 */
export async function reconcileDay(
  merchantId: string,
  day: Date = new Date(),
): Promise<VoucherReconciliation> {
  const start = new Date(day);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

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
    date: start.toISOString().slice(0, 10),
    issuedCount: issued.length,
    issuedValue: sum(issued),
    redeemedCount: redeemed.length,
    redeemedValue: sum(redeemed),
    voidCount: voided.length,
    outstandingCount: outstanding.length,
    outstandingValue: sum(outstanding),
    settlementStrategy: (settings?.settlementStrategy ?? 'VOUCHER_AS_PAYMENT') as VoucherReconciliation['settlementStrategy'],
  };
}
