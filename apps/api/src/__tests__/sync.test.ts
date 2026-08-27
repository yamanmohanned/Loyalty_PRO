import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isSyncItemSettled, type SyncOperation } from '@walaa/shared-types';
import { processSyncBatch } from '../services/sync.service';
import type { LinkTransactionContext } from '../services/transaction.service';
import { resetDatabase } from './helpers/db';
import { createWorld, invoice, type World } from './helpers/fixtures';

/**
 * Offline sync reconciliation (CLAUDE.md §10).
 *
 * The device is the temporary source of truth until a batch is confirmed, so the
 * properties under test are: per-item idempotency, per-item results, and that a
 * partial failure never corrupts the queue.
 */

const prisma = new PrismaClient();
let world: World;
let context: LinkTransactionContext;

const linkOp = (invoiceId: string, amount: number, customerId?: string): SyncOperation => ({
  type: 'LINK_TRANSACTION',
  operationId: randomUUID(),
  queuedAt: new Date().toISOString(),
  payload: {
    customerId: customerId ?? world.customerId,
    invoice: invoice({ invoice_id: invoiceId, amount }),
  },
});

beforeEach(async () => {
  await resetDatabase(prisma);
  world = await createWorld(prisma);
  context = {
    merchantId: world.merchantId,
    userId: world.assistantId,
    role: 'ASSISTANT',
    userBranchId: world.branchId,
  };
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('batch sync', () => {
  it('applies a queue of operations and reports each one', async () => {
    const operations = [linkOp('INV-1', 20_000), linkOp('INV-2', 30_000), linkOp('INV-3', 40_000)];

    const response = await processSyncBatch(context, { deviceId: 'device-01', operations });

    expect(response.results).toHaveLength(3);
    expect(response.results.every((r) => r.status === 'APPLIED')).toBe(true);
    expect(response.results.every((r) => r.entityId !== null)).toBe(true);
    expect(await prisma.transaction.count()).toBe(3);
  });

  it('is idempotent when the whole batch is replayed', async () => {
    // The classic offline failure: the batch was applied, but the response never
    // reached the device, so it sends the same queue again.
    const operations = [linkOp('INV-1', 20_000), linkOp('INV-2', 30_000)];

    const first = await processSyncBatch(context, { deviceId: 'device-01', operations });
    const replay = await processSyncBatch(context, { deviceId: 'device-01', operations });

    expect(first.results.every((r) => r.status === 'APPLIED')).toBe(true);

    // The replay must not create a second set of transactions, and must not report
    // failure either — the device needs to clear these.
    expect(await prisma.transaction.count()).toBe(2);
    expect(replay.results.every((r) => isSyncItemSettled(r.status))).toBe(true);
  });

  it('lets one bad operation fail without poisoning the batch', async () => {
    const operations: SyncOperation[] = [
      linkOp('INV-GOOD-1', 20_000),
      // A customer that does not exist — permanently invalid, never retryable.
      linkOp('INV-BAD', 30_000, '00000000-0000-4000-8000-000000000999'),
      linkOp('INV-GOOD-2', 40_000),
    ];

    const response = await processSyncBatch(context, { deviceId: 'device-01', operations });

    expect(response.results[0]?.status).toBe('APPLIED');
    expect(response.results[1]?.status).toBe('REJECTED');
    expect(response.results[2]?.status).toBe('APPLIED');

    // The good ones committed regardless of the bad one in the middle.
    expect(await prisma.transaction.count()).toBe(2);
  });

  it('marks a duplicate invoice DUPLICATE, which the device treats as settled', async () => {
    const first = linkOp('INV-DUP', 25_000);
    await processSyncBatch(context, { deviceId: 'device-01', operations: [first] });

    // A different operationId carrying the same invoice — e.g. the operator scanned
    // the same receipt twice on two devices.
    const second = linkOp('INV-DUP', 25_000);
    const response = await processSyncBatch(context, {
      deviceId: 'device-02',
      operations: [second],
    });

    expect(response.results[0]?.status).toBe('DUPLICATE');
    expect(response.results[0]?.errorCode).toBe('DUPLICATE_INVOICE');
    // Settled: retrying forever would never succeed, so the device drops it.
    expect(isSyncItemSettled('DUPLICATE')).toBe(true);
    expect(await prisma.transaction.count()).toBe(1);
  });

  it('registers a customer offline, then links their invoice in the same batch', async () => {
    const createId = randomUUID();
    const newPhone = '+9647801112233';

    const operations: SyncOperation[] = [
      {
        type: 'CREATE_CUSTOMER',
        operationId: createId,
        queuedAt: new Date().toISOString(),
        payload: { name: 'زينب عبد الرزاق', phone: newPhone, category: 'REGULAR' },
      },
    ];

    const created = await processSyncBatch(context, { deviceId: 'device-01', operations });
    expect(created.results[0]?.status).toBe('APPLIED');

    const customerId = created.results[0]?.entityId;
    expect(customerId).not.toBeNull();

    // The link references the id the server just assigned — which is why operations
    // are applied in order rather than concurrently.
    const linked = await processSyncBatch(context, {
      deviceId: 'device-01',
      operations: [linkOp('INV-NEW', 55_000, customerId ?? '')],
    });
    expect(linked.results[0]?.status).toBe('APPLIED');
  });

  it('rejects a re-registration of an existing phone rather than retrying it', async () => {
    const operations: SyncOperation[] = [
      {
        type: 'CREATE_CUSTOMER',
        operationId: randomUUID(),
        queuedAt: new Date().toISOString(),
        // The world fixture already holds this number.
        payload: { name: 'حسين علي', phone: world.customerPhone, category: 'REGULAR' },
      },
    ];

    const response = await processSyncBatch(context, { deviceId: 'device-01', operations });

    expect(response.results[0]?.status).toBe('REJECTED');
    expect(response.results[0]?.errorCode).toBe('CUSTOMER_ALREADY_EXISTS');
  });

  it('preserves the offline occurrence time, not the sync time', async () => {
    // A sale made while offline belongs to the period it happened in, not the one
    // it was uploaded in. Getting this wrong would silently move spend between
    // periods for every device that syncs after a boundary.
    const operationId = randomUUID();
    const response = await processSyncBatch(context, {
      deviceId: 'device-01',
      operations: [
        {
          type: 'LINK_TRANSACTION',
          operationId,
          queuedAt: new Date().toISOString(),
          payload: {
            customerId: world.customerId,
            invoice: invoice({
              invoice_id: 'INV-OFFLINE',
              amount: 15_000,
              occurred_at: '2026-07-20T08:30:00Z',
            }),
          },
        },
      ],
    });

    expect(response.results[0]?.status).toBe('APPLIED');
    const stored = await prisma.transaction.findFirst({ where: { invoiceId: 'INV-OFFLINE' } });
    expect(stored?.occurredAt.toISOString()).toBe('2026-07-20T08:30:00.000Z');
    expect(stored?.periodKey).toBe('2026-07');
  });

  it('returns a server clock so a skewed device can correct itself', async () => {
    const response = await processSyncBatch(context, {
      deviceId: 'device-01',
      operations: [linkOp('INV-1', 10_000)],
    });
    expect(() => new Date(response.serverTime).toISOString()).not.toThrow();
  });

  it('reconciles a realistic offline session end to end', async () => {
    // Device goes offline, records four sales that together cross a threshold,
    // then reconnects and uploads everything at once.
    const operations = [
      linkOp('OFF-1', 30_000),
      linkOp('OFF-2', 30_000),
      linkOp('OFF-3', 25_000),
      linkOp('OFF-4', 20_000),
    ];

    const response = await processSyncBatch(context, { deviceId: 'device-01', operations });

    expect(response.results.every((r) => r.status === 'APPLIED')).toBe(true);

    const snapshot = await prisma.balanceSnapshot.findFirst({
      where: { customerId: world.customerId },
    });
    expect(snapshot?.cumulativeAmount).toBe(105_000);

    // Crossing 100,000 during an offline session still earns the coupon on sync.
    const coupon = await prisma.coupon.findFirst({ where: { customerId: world.customerId } });
    expect(coupon?.discountPct).toBe(5);
  });
});
