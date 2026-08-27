import type { Coupon as CouponDto, RedeemCouponResponse } from '@walaa/shared-types';
import { couponNotRedeemable, notFound } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { AUDIT_ACTIONS, recordAudit } from './audit.service';
import { serializeCoupon } from './transaction.service';

/**
 * Coupon lifecycle.
 *
 * Redemption is a **state transition, never a delete** — a redeemed coupon stays
 * in the table as history, which is what makes the audit trail meaningful.
 */

export async function listCustomerCoupons(
  merchantId: string,
  customerId: string,
): Promise<CouponDto[]> {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, merchantId },
    select: { id: true },
  });
  if (!customer) throw notFound('الزبون غير موجود');

  const coupons = await prisma.coupon.findMany({
    where: { customerId, merchantId },
    orderBy: { issuedAt: 'desc' },
  });
  return coupons.map(serializeCoupon);
}

/** The sentence the assistant reads to the cashier (CLAUDE.md §6.7 #5). */
export const cashierInstruction = (discountPct: number): string =>
  `أبلغ الكاشير بتطبيق خصم ${discountPct}٪`;

/**
 * Redeems a coupon exactly once.
 *
 * The single-use guarantee is **one atomic conditional UPDATE**, not a
 * read-then-write. The WHERE clause carries every precondition — the coupon is
 * ACTIVE and not yet past its expiry — so the statement either matches exactly one
 * row and claims it, or matches nothing. Two simultaneous redemptions therefore
 * cannot both succeed; the loser sees `count === 0`.
 *
 * Folding expiry into the same WHERE matters: the scheduled expiry sweep may not
 * have run yet, and a lapsed coupon must not be redeemable in that window. Checking
 * expiry separately would reintroduce exactly the race the atomic update removes.
 *
 * Discounts are applied by hand on the main register, so this records that a
 * redemption happened; it does not itself discount anything.
 */
export async function redeemCoupon(params: {
  merchantId: string;
  couponId: string;
  actorUserId: string;
}): Promise<RedeemCouponResponse> {
  const now = new Date();

  const claimed = await prisma.coupon.updateMany({
    where: {
      id: params.couponId,
      merchantId: params.merchantId,
      status: 'ACTIVE',
      expiresAt: { gt: now },
    },
    data: { status: 'USED', redeemedAt: now, redeemedByUserId: params.actorUserId },
  });

  if (claimed.count === 0) {
    // Nothing was claimed. Work out why, so the assistant gets a message they can
    // act on rather than a generic refusal.
    await explainFailedRedemption(params.merchantId, params.couponId, now);
  }

  const coupon = await prisma.coupon.findUniqueOrThrow({ where: { id: params.couponId } });

  await recordAudit({
    merchantId: params.merchantId,
    actorUserId: params.actorUserId,
    action: AUDIT_ACTIONS.COUPON_REDEEMED,
    entityType: 'coupon',
    entityId: coupon.id,
    before: { status: 'ACTIVE' },
    after: {
      status: 'USED',
      discountPct: coupon.discountPct,
      redeemedAt: now.toISOString(),
    },
  });

  return {
    coupon: serializeCoupon(coupon),
    cashierInstruction: cashierInstruction(coupon.discountPct),
  };
}

/**
 * Always throws. Diagnoses why the conditional update matched nothing.
 *
 * Runs outside any transaction on purpose: it corrects a stale ACTIVE status on a
 * lapsed coupon, and that correction must survive the error being thrown. Doing it
 * inside a transaction would roll the fix back along with everything else.
 */
async function explainFailedRedemption(
  merchantId: string,
  couponId: string,
  now: Date,
): Promise<never> {
  const coupon = await prisma.coupon.findFirst({ where: { id: couponId, merchantId } });
  if (!coupon) throw notFound('الكوبون غير موجود');

  switch (coupon.status) {
    case 'USED':
      throw couponNotRedeemable('تم استخدام هذا الكوبون مسبقاً');
    case 'SUPERSEDED':
      throw couponNotRedeemable('تم استبدال هذا الكوبون بكوبون أعلى');
    case 'EXPIRED':
      throw couponNotRedeemable('انتهت صلاحية هذا الكوبون');
    case 'ACTIVE':
      // Still ACTIVE but the update did not match, so it lapsed and the sweep has
      // not caught up. Correct the record on the way out.
      if (coupon.expiresAt.getTime() <= now.getTime()) {
        await prisma.coupon.update({ where: { id: coupon.id }, data: { status: 'EXPIRED' } });
        throw couponNotRedeemable('انتهت صلاحية هذا الكوبون');
      }
      // ACTIVE, unexpired, yet unclaimed: another redemption won the race between
      // the update and this read.
      throw couponNotRedeemable('تم استخدام هذا الكوبون مسبقاً');
  }
}

/**
 * Transitions coupons past their expiry to EXPIRED.
 *
 * Idempotent and safe to run on any schedule. Phase 4 wires it to a timer; it
 * exists now so the table stays tidy and reporting reflects reality.
 */
export async function expireLapsedCoupons(now = new Date()): Promise<number> {
  const result = await prisma.coupon.updateMany({
    where: { status: 'ACTIVE', expiresAt: { lte: now } },
    data: { status: 'EXPIRED' },
  });
  return result.count;
}
