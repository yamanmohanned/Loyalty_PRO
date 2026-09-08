import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS } from '../services/audit.service';
import { ingestInvoice } from '../services/ingestion.service';
import { scanCard } from '../services/scan.service';
import { redeemVoucher } from '../services/voucher.service';
import { isContentionError, writeTransaction } from '../lib/write-transaction';
import { resetDatabase } from './helpers/db';
import { capturedInvoice, createWorld, type World } from './helpers/fixtures';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  CONCURRENCY — what two tills doing the same thing at once must not produce
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The failure that motivated `lib/write-transaction.ts` was measured against a running
 * API rather than here: N simultaneous `POST /scan/card`, each attributing a *different*
 * invoice, produced 9 failures out of 16 and 64 out of 64, every one a 500 and every one
 * a customer who did not get their discount. The cause was Prisma's interactive
 * transaction queue rather than SQLite — the module header carries the numbers and the
 * three error messages.
 *
 * What this suite pins is the behaviour that has to hold underneath that: the write
 * queue serialises, is re-entrant, does not deadlock, does not swallow real errors — and
 * the business invariants that no amount of simultaneity may break.
 */

const prisma = new PrismaClient();
let world: World;

beforeEach(async () => {
  await resetDatabase(prisma);
  world = await createWorld(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

const stationContext = () => ({
  merchantId: world.merchantId,
  userId: world.stationUserId,
  branchId: world.branchId,
});

const agentContext = () => ({
  merchantId: world.merchantId,
  userId: world.agentUserId,
  userBranchId: world.branchId,
});

/* ── The queue itself ─────────────────────────────────────────────────────────── */

describe('the write queue', () => {
  it('runs one transaction at a time', async () => {
    let inside = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 12 }, () =>
        writeTransaction(async (db) => {
          inside += 1;
          peak = Math.max(peak, inside);
          await db.$queryRawUnsafe('SELECT 1');
          inside -= 1;
        }),
      ),
    );

    expect(peak).toBe(1);
  });

  it('runs them in the order they were asked for', async () => {
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        writeTransaction(async () => {
          order.push(i);
        }),
      ),
    );
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  /**
   * A failure must not stop the till. The chain advances on rejection as well as on
   * fulfilment, so one bad transaction cannot wedge every write behind it.
   */
  it('is not poisoned by a transaction that throws', async () => {
    const failure = writeTransaction(async () => {
      throw new Error('deliberate');
    });
    await expect(failure).rejects.toThrow('deliberate');

    await expect(writeTransaction(async () => 'after')).resolves.toBe('after');
  });

  /**
   * Re-entrancy is what stops a strict serial queue deadlocking against itself. A
   * `writeTransaction` reached from inside another joins the outer one — with the same
   * client, so its writes are part of the same commit — rather than queueing behind a
   * transaction it is itself holding.
   */
  it('joins the outer transaction instead of deadlocking', async () => {
    const result = await writeTransaction(async (outer) => {
      const inner = await writeTransaction(async (db) => {
        expect(db).toBe(outer);
        return 'joined';
      });
      return inner;
    });

    expect(result).toBe('joined');
  });

  it('rolls a nested call back with the outer one', async () => {
    await expect(
      writeTransaction(async () => {
        await writeTransaction(async (db) => {
          await db.branch.create({
            data: { merchantId: world.merchantId, name: 'فرع مؤقت', code: 'ROLLBACK-1' },
          });
        });
        throw new Error('outer fails after the nested write');
      }),
    ).rejects.toThrow('outer fails');

    expect(await prisma.branch.count({ where: { code: 'ROLLBACK-1' } })).toBe(0);
  });

  it('does not retry a business failure', async () => {
    let attempts = 0;
    await expect(
      writeTransaction(async () => {
        attempts += 1;
        throw new Error('a real bug, not contention');
      }),
    ).rejects.toThrow('a real bug');

    expect(attempts).toBe(1);
  });
});

describe('recognising contention', () => {
  /** The three messages actually observed under load, plus Prisma's codes. */
  it.each([
    'Transaction API error: Unable to start a transaction in the given time.',
    'Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction.',
    'Transaction API error: Transaction not found.',
  ])('recognises %s', (message) => {
    expect(isContentionError(new Error(message))).toBe(true);
  });

  it('recognises Prisma’s transaction and write-conflict codes', () => {
    expect(isContentionError({ code: 'P2028' })).toBe(true);
    expect(isContentionError({ code: 'P2034' })).toBe(true);
  });

  it('recognises SQLITE_BUSY', () => {
    expect(isContentionError(new Error('SQLITE_BUSY: database is locked'))).toBe(true);
  });

  it('does not mistake an ordinary failure for contention', () => {
    expect(isContentionError(new Error('الزبون غير موجود'))).toBe(false);
    expect(isContentionError({ code: 'P2002' })).toBe(false);
    expect(isContentionError(null)).toBe(false);
  });
});

/* ── The invariants, under simultaneity ───────────────────────────────────────── */

describe('the same invoice captured many times at once', () => {
  it('records it exactly once and reports the rest as duplicates', async () => {
    const invoice = capturedInvoice({ invoice_id: 'CONC-DUPE-1', amount_gross: 77_000 });

    const results = await Promise.all(
      Array.from({ length: 12 }, () => ingestInvoice(agentContext(), invoice)),
    );

    const ids = new Set(results.map((r) => r.transactionId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.duplicate)).toHaveLength(11);

    expect(
      await prisma.transaction.count({
        where: { merchantId: world.merchantId, invoiceId: 'CONC-DUPE-1' },
      }),
    ).toBe(1);
  });
});

describe('the same invoice scanned by two stations at once', () => {
  /**
   * The claim is conditional — `updateMany` with `customerId: null` in the WHERE — so
   * exactly one scan can attribute a capture. Everything after it hangs off that
   * count, which is why a second discount and a second voucher are impossible rather
   * than merely unlikely.
   */
  it('grants one discount and issues one voucher', async () => {
    await ingestInvoice(
      agentContext(),
      capturedInvoice({ invoice_id: 'CONC-RACE-1', amount_gross: 120_000 }),
    );

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        scanCard(stationContext(), {
          barcodeToken: world.customerBarcode,
          invoiceId: 'CONC-RACE-1',
        }),
      ),
    );

    const qualified = results.filter((r) => r.outcome === 'QUALIFIED');
    expect(qualified).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'NO_PENDING_INVOICE')).toHaveLength(9);

    const transaction = await prisma.transaction.findFirstOrThrow({
      where: { merchantId: world.merchantId, invoiceId: 'CONC-RACE-1' },
      include: { vouchers: true },
    });

    expect(transaction.vouchers).toHaveLength(1);
    expect(transaction.discountValue).toBe(transaction.vouchers[0]!.value);
    expect(transaction.amountNet).toBe(transaction.amountGross - transaction.discountValue);

    expect(
      await prisma.auditLog.count({
        where: { entityId: transaction.id, action: AUDIT_ACTIONS.INVOICE_ATTRIBUTED },
      }),
    ).toBe(1);
  });
});

describe('many different sales attributed at once', () => {
  /**
   * The load the queue exists for. Each of these is a separate interactive transaction
   * that actually does work — a claim, a voucher and two audit rows — and before the
   * queue this shape is what produced 500s at sixteen.
   */
  it('all succeed, each with exactly one voucher', async () => {
    const ids = Array.from({ length: 24 }, (_, i) => `CONC-MANY-${i}`);
    await Promise.all(
      ids.map((invoice_id) =>
        ingestInvoice(agentContext(), capturedInvoice({ invoice_id, amount_gross: 60_000 })),
      ),
    );

    const results = await Promise.all(
      ids.map((invoiceId) =>
        scanCard(stationContext(), { barcodeToken: world.customerBarcode, invoiceId }),
      ),
    );

    expect(results.every((r) => r.outcome === 'QUALIFIED')).toBe(true);

    const doubled = await prisma.$queryRawUnsafe<Array<{ transaction_id: string }>>(
      'SELECT transaction_id FROM voucher GROUP BY transaction_id HAVING COUNT(*) > 1',
    );
    expect(doubled).toEqual([]);

    expect(await prisma.voucher.count()).toBe(ids.length);
  });
});

describe('one voucher redeemed by two cashiers at once', () => {
  /**
   * No double-spend, and — the part that was broken — exactly one audit row. Before the
   * redemption became a transaction, a kill between the UPDATE and the audit write left
   * a REDEEMED voucher with nothing in the trail; nine of ten concurrent redeems then
   * answered 500 rather than "already used".
   */
  it('settles it once and refuses the rest by name', async () => {
    await ingestInvoice(
      agentContext(),
      capturedInvoice({ invoice_id: 'CONC-REDEEM-1', amount_gross: 100_000 }),
    );
    const scan = await scanCard(stationContext(), {
      barcodeToken: world.customerBarcode,
      invoiceId: 'CONC-REDEEM-1',
    });
    const voucherId = scan.voucher!.id;

    const outcomes = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        redeemVoucher({
          merchantId: world.merchantId,
          voucherId,
          actorUserId: world.ownerId,
        }),
      ),
    );

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);

    const rejected = outcomes.filter(
      (o): o is PromiseRejectedResult => o.status === 'rejected',
    );
    expect(rejected).toHaveLength(9);
    // Every loser is told the truth — the slip was already settled — rather than
    // «حدث خطأ غير متوقع», which sends a cashier to the manager for a non-problem.
    for (const failure of rejected) {
      expect(failure.reason).toMatchObject({ code: 'COUPON_NOT_REDEEMABLE' });
    }

    const voucher = await prisma.voucher.findUniqueOrThrow({ where: { id: voucherId } });
    expect(voucher.status).toBe('REDEEMED');
    expect(
      await prisma.auditLog.count({
        where: { entityId: voucherId, action: AUDIT_ACTIONS.VOUCHER_REDEEMED },
      }),
    ).toBe(1);
  });
});
