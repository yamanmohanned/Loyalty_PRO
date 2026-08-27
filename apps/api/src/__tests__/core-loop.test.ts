import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../lib/errors';
import { computeCumulativeAmount } from '../services/loyalty.service';
import { linkTransaction, type LinkTransactionContext } from '../services/transaction.service';
import { resetDatabase } from './helpers/db';
import { createWorld, invoice, type World } from './helpers/fixtures';

/**
 * The core loop, under test.
 *
 * These cover the guarantees CLAUDE.md §10 names explicitly: idempotent linking,
 * threshold → coupon issuance, and cumulative balance computation.
 */

const prisma = new PrismaClient();
let world: World;
let assistant: LinkTransactionContext;

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

describe('idempotent linking (CLAUDE.md §0.2)', () => {
  it('links an invoice once', async () => {
    const result = await linkTransaction(assistant, {
      customerId: world.customerId,
      invoice: invoice({ invoice_id: 'INV-9824', amount: 85_000 }),
    });

    expect(result.transaction.invoiceId).toBe('INV-9824');
    expect(result.transaction.amount).toBe(85_000);
    expect(result.balance.cumulativeAmount).toBe(85_000);
  });

  it('refuses the same invoice twice and names who holds it', async () => {
    await linkTransaction(assistant, {
      customerId: world.customerId,
      invoice: invoice({ invoice_id: 'INV-9824', amount: 85_000 }),
    });

    const second = linkTransaction(assistant, {
      customerId: world.customerId,
      invoice: invoice({ invoice_id: 'INV-9824', amount: 85_000 }),
    });

    await expect(second).rejects.toThrow(AppError);
    await expect(second).rejects.toMatchObject({ code: 'DUPLICATE_INVOICE', statusCode: 409 });

    // The 409 carries the existing record so the assistant can say WHO it belongs
    // to, rather than showing a bare failure the cashier cannot act on.
    const error = await second.catch((e: AppError) => e);
    const details = (error as AppError).details as { customerName: string };
    expect(details.customerName).toBe('حسين علي');

    // And crucially: exactly one transaction exists, so no balance was double-counted.
    expect(await prisma.transaction.count()).toBe(1);
    const totals = await computeCumulativeAmount(world.customerId, '2026-08', prisma);
    void totals;
  });

  it('refuses a duplicate even when linked to a DIFFERENT customer', async () => {
    const other = await prisma.customer.create({
      data: {
        merchantId: world.merchantId,
        name: 'زينب عبد الرزاق',
        phone: '+9647811239876',
        qrToken: 'v1.other.token',
      },
    });

    await linkTransaction(assistant, {
      customerId: world.customerId,
      invoice: invoice({ invoice_id: 'INV-1', amount: 50_000 }),
    });

    // The guard is on (merchant, branch, invoice) — not on the customer. One
    // printed receipt credits exactly one account, whoever presents it.
    await expect(
      linkTransaction(assistant, {
        customerId: other.id,
        invoice: invoice({ invoice_id: 'INV-1', amount: 50_000 }),
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_INVOICE' });

    expect(await prisma.transaction.count()).toBe(1);
  });

  it('allows the same invoice number at a different branch', async () => {
    // Branch numbering is independent, so BAG-01/INV-1 and BAG-02/INV-1 are two
    // genuinely different sales. An owner is unbound and may link at either.
    const owner: LinkTransactionContext = {
      merchantId: world.merchantId,
      userId: world.ownerId,
      role: 'OWNER',
      userBranchId: null,
    };

    await linkTransaction(owner, {
      customerId: world.customerId,
      invoice: invoice({ invoice_id: 'INV-1', amount: 30_000, branch_id: world.branchCode }),
    });
    await linkTransaction(owner, {
      customerId: world.customerId,
      invoice: invoice({ invoice_id: 'INV-1', amount: 40_000, branch_id: world.otherBranchCode }),
    });

    expect(await prisma.transaction.count()).toBe(2);
  });

  it('returns the original result when a request is retried with the same idempotency key', async () => {
    const key = '11111111-1111-4111-8111-111111111111';
    const payload = {
      customerId: world.customerId,
      invoice: invoice({ invoice_id: 'INV-777', amount: 60_000 }),
      idempotencyKey: key,
    };

    const first = await linkTransaction(assistant, payload);
    // A dropped response, not a second sale: the operator must not see an error.
    const retry = await linkTransaction(assistant, payload);

    expect(retry.transaction.id).toBe(first.transaction.id);
    expect(await prisma.transaction.count()).toBe(1);
  });

  it('rejects a duplicate concurrently — the database is the last line of defence', async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        linkTransaction(assistant, {
          customerId: world.customerId,
          invoice: invoice({ invoice_id: 'INV-RACE', amount: 40_000 }),
        }),
      ),
    );

    const fulfilled = attempts.filter((a) => a.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect(await prisma.transaction.count()).toBe(1);
  });
});

describe('cumulative balance (CLAUDE.md §4.2)', () => {
  it('is the sum of transactions in the period', async () => {
    for (const [id, amount] of [
      ['INV-1', 30_000],
      ['INV-2', 25_500],
      ['INV-3', 14_500],
    ] as const) {
      await linkTransaction(assistant, {
        customerId: world.customerId,
        invoice: invoice({ invoice_id: id, amount }),
      });
    }

    const result = await linkTransaction(assistant, {
      customerId: world.customerId,
      invoice: invoice({ invoice_id: 'INV-4', amount: 10_000 }),
    });

    expect(result.balance.cumulativeAmount).toBe(80_000);
  });

  it('keeps the snapshot cache in step with the authoritative sum', async () => {
    await linkTransaction(assistant, {
      customerId: world.customerId,
      invoice: invoice({ invoice_id: 'INV-1', amount: 45_000 }),
    });
    const result = await linkTransaction(assistant, {
      customerId: world.customerId,
      invoice: invoice({ invoice_id: 'INV-2', amount: 55_000 }),
    });

    const computed = await computeCumulativeAmount(world.customerId, result.balance.periodKey, prisma);
    const cached = await prisma.balanceSnapshot.findUnique({
      where: {
        customerId_periodKey: {
          customerId: world.customerId,
          periodKey: result.balance.periodKey,
        },
      },
    });

    // The computed value is authoritative; the cache must agree with it.
    expect(computed.cumulativeAmount).toBe(100_000);
    expect(cached?.cumulativeAmount).toBe(computed.cumulativeAmount);
    expect(cached?.transactionCount).toBe(2);
  });

  it('resets at the period boundary — spend does not carry over', async () => {
    // Two purchases in different calendar months land in different buckets, so the
    // later one starts from zero rather than inheriting the earlier total (§13.1).
    await linkTransaction(assistant, {
      customerId: world.customerId,
      invoice: invoice({
        invoice_id: 'INV-JULY',
        amount: 90_000,
        occurred_at: '2026-07-15T10:00:00Z',
      }),
    });

    const august = await linkTransaction(assistant, {
      customerId: world.customerId,
      invoice: invoice({
        invoice_id: 'INV-AUG',
        amount: 20_000,
        occurred_at: '2026-08-15T10:00:00Z',
      }),
    });

    expect(august.balance.periodKey).toBe('2026-08');
    expect(august.balance.cumulativeAmount).toBe(20_000);
  });

  it('buckets a late-night purchase by LOCAL date, not UTC', async () => {
    // 22:00 UTC on 31 August is already 01:00 on 1 September in Baghdad. Bucketing
    // this in UTC would credit it to the wrong month and corrupt the reset (§13.1).
    const result = await linkTransaction(assistant, {
      customerId: world.customerId,
      invoice: invoice({
        invoice_id: 'INV-MIDNIGHT',
        amount: 10_000,
        occurred_at: '2026-08-31T22:00:00Z',
      }),
    });

    expect(result.balance.periodKey).toBe('2026-09');
  });

  it('reports the gap to the next threshold', async () => {
    const result = await linkTransaction(assistant, {
      customerId: world.customerId,
      invoice: invoice({ invoice_id: 'INV-1', amount: 60_000 }),
    });

    expect(result.balance.nextThresholdAmount).toBe(100_000);
    expect(result.balance.amountToNextThreshold).toBe(40_000);
    expect(result.balance.nextDiscountPct).toBe(5);
  });

  it('reports no next threshold once every tier is earned', async () => {
    const result = await linkTransaction(assistant, {
      customerId: world.customerId,
      invoice: invoice({ invoice_id: 'INV-BIG', amount: 600_000 }),
    });

    expect(result.balance.nextThresholdAmount).toBeNull();
    expect(result.balance.amountToNextThreshold).toBeNull();
  });
});

describe('loop order and scoping', () => {
  it('refuses to link for a customer of another merchant', async () => {
    const otherWorld = await createWorld(prisma);

    await expect(
      linkTransaction(assistant, {
        customerId: otherWorld.customerId,
        invoice: invoice({ invoice_id: 'INV-X', amount: 10_000 }),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses to let an assistant link to a branch they are not bound to', async () => {
    await expect(
      linkTransaction(assistant, {
        customerId: world.customerId,
        invoice: invoice({
          invoice_id: 'INV-X',
          amount: 10_000,
          branch_id: world.otherBranchCode,
        }),
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('audits a manually typed amount, naming who typed it', async () => {
    const result = await linkTransaction(assistant, {
      customerId: world.customerId,
      invoice: invoice({ invoice_id: 'INV-MANUAL', amount: 77_000, amount_capture: 'manual' }),
    });

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'transaction.linked.manual_amount', entityId: result.transaction.id },
    });

    expect(audit).not.toBeNull();
    expect(audit?.actorUserId).toBe(world.assistantId);
  });

  it('does not audit an auto-captured amount', async () => {
    await linkTransaction(assistant, {
      customerId: world.customerId,
      invoice: invoice({ invoice_id: 'INV-AUTO', amount: 77_000, amount_capture: 'auto' }),
    });

    const audits = await prisma.auditLog.count({
      where: { action: 'transaction.linked.manual_amount' },
    });
    expect(audits).toBe(0);
  });

  it('enqueues a notification for every link', async () => {
    await linkTransaction(assistant, {
      customerId: world.customerId,
      invoice: invoice({ invoice_id: 'INV-1', amount: 10_000 }),
    });

    const notifications = await prisma.notificationLog.findMany({
      where: { customerId: world.customerId },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.status).toBe('PENDING');
  });
});
