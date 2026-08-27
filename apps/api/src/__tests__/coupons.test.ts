import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { expireLapsedCoupons, redeemCoupon } from '../services/coupon.service';
import { linkTransaction, type LinkTransactionContext } from '../services/transaction.service';
import { resetDatabase } from './helpers/db';
import { createWorld, invoice, type World } from './helpers/fixtures';

/**
 * Threshold → coupon issuance, and single-use redemption (CLAUDE.md §10).
 *
 * The rules under test come from §13.2: a tier fires at most once per customer per
 * period, and crossing a higher tier supersedes the coupon from a lower one.
 */

const prisma = new PrismaClient();
let world: World;
let assistant: LinkTransactionContext;

const link = (invoiceId: string, amount: number) =>
  linkTransaction(assistant, {
    customerId: world.customerId,
    invoice: invoice({ invoice_id: invoiceId, amount }),
  });

beforeEach(async () => {
  await resetDatabase(prisma);
  world = await createWorld(prisma);
  assistant = {
    merchantId: world.merchantId,
    userId: world.assistantId,
    role: 'ASSISTANT',
    userBranchId: world.branchId,
  };
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('threshold crossing issues a coupon', () => {
  it('issues nothing below the first tier', async () => {
    const result = await link('INV-1', 99_999);
    expect(result.issuedCoupon).toBeNull();
    expect(await prisma.coupon.count()).toBe(0);
  });

  it('issues exactly at the threshold', async () => {
    const result = await link('INV-1', 100_000);
    expect(result.issuedCoupon).not.toBeNull();
    expect(result.issuedCoupon?.discountPct).toBe(5);
    expect(result.issuedCoupon?.sourceThresholdAmount).toBe(100_000);
  });

  it('issues on the transaction that crosses, not the one before', async () => {
    const before = await link('INV-1', 60_000);
    expect(before.issuedCoupon).toBeNull();

    const crossing = await link('INV-2', 45_000); // cumulative 105,000
    expect(crossing.issuedCoupon?.discountPct).toBe(5);
  });

  it('sets expiry from the tier validity', async () => {
    const result = await link('INV-1', 100_000);
    const issuedAt = new Date(result.issuedCoupon?.issuedAt ?? 0).getTime();
    const expiresAt = new Date(result.issuedCoupon?.expiresAt ?? 0).getTime();
    const days = Math.round((expiresAt - issuedAt) / 86_400_000);
    expect(days).toBe(30);
  });

  it('does not re-issue the same tier on further spending', async () => {
    await link('INV-1', 120_000);
    const more = await link('INV-2', 20_000); // still tier 1, nothing new crossed

    expect(more.issuedCoupon).toBeNull();
    expect(await prisma.coupon.count()).toBe(1);
  });

  it('issues only the HIGHEST tier when several are crossed at once', async () => {
    // 300,000 clears both 100k and 250k. Only one coupon should exist, for the
    // better tier — a customer must never end up holding a stack (§13.2).
    const result = await link('INV-BIG', 300_000);

    expect(result.issuedCoupon?.discountPct).toBe(10);
    expect(result.issuedCoupon?.sourceThresholdAmount).toBe(250_000);
    expect(await prisma.coupon.count()).toBe(1);
  });

  it('supersedes a lower coupon when a higher tier is reached later', async () => {
    const first = await link('INV-1', 120_000);
    expect(first.issuedCoupon?.discountPct).toBe(5);

    const second = await link('INV-2', 140_000); // cumulative 260,000 → tier 2

    expect(second.issuedCoupon?.discountPct).toBe(10);
    expect(second.supersededCoupon?.id).toBe(first.issuedCoupon?.id);

    // The old one is retired, not deleted — the audit trail must survive.
    const old = await prisma.coupon.findUnique({ where: { id: first.issuedCoupon?.id ?? '' } });
    expect(old?.status).toBe('SUPERSEDED');

    const active = await prisma.coupon.count({
      where: { customerId: world.customerId, status: 'ACTIVE' },
    });
    expect(active).toBe(1);
  });

  it('records why a coupon was superseded', async () => {
    await link('INV-1', 120_000);
    await link('INV-2', 140_000);

    const audit = await prisma.auditLog.findFirst({ where: { action: 'coupon.superseded' } });
    expect(audit).not.toBeNull();
  });

  it('never supersedes a coupon that was already USED', async () => {
    // That discount has already been applied at the register; the row is history.
    const first = await link('INV-1', 120_000);
    await redeemCoupon({
      merchantId: world.merchantId,
      couponId: first.issuedCoupon?.id ?? '',
      actorUserId: world.assistantId,
    });

    await link('INV-2', 140_000);

    const used = await prisma.coupon.findUnique({ where: { id: first.issuedCoupon?.id ?? '' } });
    expect(used?.status).toBe('USED');
  });

  it('starts a fresh ladder in a new period', async () => {
    await linkTransaction(assistant, {
      customerId: world.customerId,
      invoice: invoice({
        invoice_id: 'INV-JULY',
        amount: 150_000,
        occurred_at: '2026-07-10T09:00:00Z',
      }),
    });

    const august = await linkTransaction(assistant, {
      customerId: world.customerId,
      invoice: invoice({
        invoice_id: 'INV-AUG',
        amount: 150_000,
        occurred_at: '2026-08-10T09:00:00Z',
      }),
    });

    // Same tier, different period — a second coupon is correct here, and the
    // unique constraint permits it because periodKey differs.
    expect(august.issuedCoupon?.sourceThresholdAmount).toBe(100_000);
    expect(await prisma.coupon.count()).toBe(2);
  });

  it('cannot mint two coupons for one tier under concurrency', async () => {
    // Both links cross 100k. The unique constraint on
    // (customerId, periodKey, sourceThresholdAmount) must refuse the second coupon.
    await Promise.allSettled([
      link('INV-A', 100_000),
      link('INV-B', 100_000),
    ]);

    const tierOne = await prisma.coupon.count({ where: { sourceThresholdAmount: 100_000 } });
    expect(tierOne).toBeLessThanOrEqual(1);
  });
});

describe('coupon single-use (CLAUDE.md §4.1)', () => {
  async function issueCoupon(): Promise<string> {
    const result = await link('INV-1', 100_000);
    const id = result.issuedCoupon?.id;
    if (!id) throw new Error('fixture failed to issue a coupon');
    return id;
  }

  it('redeems an active coupon and returns the cashier instruction', async () => {
    const couponId = await issueCoupon();

    const result = await redeemCoupon({
      merchantId: world.merchantId,
      couponId,
      actorUserId: world.assistantId,
    });

    expect(result.coupon.status).toBe('USED');
    expect(result.coupon.redeemedAt).not.toBeNull();
    // Discounts are applied by hand on the main register (§6.7 #5).
    expect(result.cashierInstruction).toBe('أبلغ الكاشير بتطبيق خصم 5٪');
  });

  it('refuses a second redemption', async () => {
    const couponId = await issueCoupon();
    await redeemCoupon({
      merchantId: world.merchantId,
      couponId,
      actorUserId: world.assistantId,
    });

    await expect(
      redeemCoupon({ merchantId: world.merchantId, couponId, actorUserId: world.assistantId }),
    ).rejects.toMatchObject({ code: 'COUPON_NOT_REDEEMABLE', statusCode: 409 });
  });

  it('lets exactly one of many concurrent redemptions win', async () => {
    // The atomic conditional update is what makes this safe — a read-then-write
    // would let two cashiers both apply the discount.
    const couponId = await issueCoupon();

    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        redeemCoupon({ merchantId: world.merchantId, couponId, actorUserId: world.assistantId }),
      ),
    );

    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);

    const coupon = await prisma.coupon.findUnique({ where: { id: couponId } });
    expect(coupon?.status).toBe('USED');
  });

  it('refuses an expired coupon even before the expiry job has run', async () => {
    const couponId = await issueCoupon();
    await prisma.coupon.update({
      where: { id: couponId },
      data: { expiresAt: new Date(Date.now() - 1000) }, // still ACTIVE on paper
    });

    await expect(
      redeemCoupon({ merchantId: world.merchantId, couponId, actorUserId: world.assistantId }),
    ).rejects.toMatchObject({ code: 'COUPON_NOT_REDEEMABLE' });

    // And the attempt corrects the stale status on its way out.
    const coupon = await prisma.coupon.findUnique({ where: { id: couponId } });
    expect(coupon?.status).toBe('EXPIRED');
  });

  it('refuses a superseded coupon', async () => {
    const first = await link('INV-1', 120_000);
    await link('INV-2', 140_000);

    await expect(
      redeemCoupon({
        merchantId: world.merchantId,
        couponId: first.issuedCoupon?.id ?? '',
        actorUserId: world.assistantId,
      }),
    ).rejects.toMatchObject({ code: 'COUPON_NOT_REDEEMABLE' });
  });

  it('refuses a coupon belonging to another merchant', async () => {
    const couponId = await issueCoupon();
    const otherWorld = await createWorld(prisma);

    await expect(
      redeemCoupon({
        merchantId: otherWorld.merchantId,
        couponId,
        actorUserId: otherWorld.assistantId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('audits every redemption', async () => {
    const couponId = await issueCoupon();
    await redeemCoupon({
      merchantId: world.merchantId,
      couponId,
      actorUserId: world.assistantId,
    });

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'coupon.redeemed', entityId: couponId },
    });
    expect(audit?.actorUserId).toBe(world.assistantId);
  });
});

describe('expiry sweep', () => {
  it('transitions lapsed coupons and leaves live ones alone', async () => {
    const live = await link('INV-1', 100_000);

    const lapsed = await prisma.coupon.create({
      data: {
        merchantId: world.merchantId,
        customerId: world.customerId,
        discountPct: 5,
        sourceThresholdAmount: 999_999,
        periodKey: '2026-07',
        expiresAt: new Date(Date.now() - 86_400_000),
        status: 'ACTIVE',
      },
    });

    const count = await expireLapsedCoupons();
    expect(count).toBe(1);

    expect((await prisma.coupon.findUnique({ where: { id: lapsed.id } }))?.status).toBe('EXPIRED');
    expect(
      (await prisma.coupon.findUnique({ where: { id: live.issuedCoupon?.id ?? '' } }))?.status,
    ).toBe('ACTIVE');
  });
});
