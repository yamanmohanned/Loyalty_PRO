import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ingestInvoice, type IngestionContext } from '../services/ingestion.service';
import { resetSubscribers, subscribe } from '../services/realtime.service';
import { scanCard, type ScanContext } from '../services/scan.service';
import { resetDatabase } from './helpers/db';
import { capturedInvoice, createWorld, type World } from './helpers/fixtures';

/**
 * The v3 core loop: capture, then attribute with an instant discount.
 *
 * These cover what PROMPT_v3 names for V3-2 — threshold evaluation, cap
 * enforcement, idempotent ingestion — plus the invariant that matters most: a
 * discount is never recorded without the voucher that explains it.
 */

const prisma = new PrismaClient();
let world: World;
let agent: IngestionContext;
let station: ScanContext;

beforeEach(async () => {
  await resetDatabase(prisma);
  resetSubscribers();
  world = await createWorld(prisma);
  agent = {
    merchantId: world.merchantId,
    userId: world.stationUserId,
    userBranchId: world.branchId,
    agentId: 'agent-01',
  };
  station = {
    merchantId: world.merchantId,
    userId: world.stationUserId,
    branchId: world.branchId,
    stationId: 'station-01',
  };
});

afterEach(() => {
  resetSubscribers();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const capture = (invoiceId: string, amountGross: number) =>
  ingestInvoice(agent, capturedInvoice({ invoice_id: invoiceId, amount_gross: amountGross }));

const scan = (invoiceId?: string) =>
  scanCard(station, { barcodeToken: world.customerBarcode, ...(invoiceId ? { invoiceId } : {}) });

describe('ingestion (CLAUDE_v3.md §4.8)', () => {
  it('records a captured invoice with no customer attached', async () => {
    const result = await capture('INV-1', 30_000);

    expect(result.duplicate).toBe(false);
    const stored = await prisma.transaction.findUniqueOrThrow({
      where: { id: result.transactionId },
    });
    // Nobody is known at capture time — this is the central v3 change.
    expect(stored.customerId).toBeNull();
    expect(stored.linkedAt).toBeNull();
    expect(stored.amountGross).toBe(30_000);
    expect(stored.amountNet).toBe(30_000);
    expect(stored.discountValue).toBe(0);
  });

  it('is idempotent — a retry reports the original, not a second sale', async () => {
    const first = await capture('INV-RETRY', 25_000);
    const retry = await capture('INV-RETRY', 25_000);

    expect(retry.duplicate).toBe(true);
    expect(retry.transactionId).toBe(first.transactionId);
    expect(await prisma.transaction.count()).toBe(1);
  });

  it('reports a duplicate rather than failing — a retry is a success for the agent', async () => {
    await capture('INV-1', 10_000);
    // Answering 409 would push a normal event onto the agent's error path and risk
    // it queueing the capture forever.
    await expect(capture('INV-1', 10_000)).resolves.toMatchObject({ duplicate: true });
  });

  it('rejects a duplicate under concurrency', async () => {
    const attempts = await Promise.all(
      Array.from({ length: 5 }, () => capture('INV-RACE', 20_000)),
    );

    expect(attempts.filter((a) => !a.duplicate)).toHaveLength(1);
    expect(await prisma.transaction.count()).toBe(1);
  });

  it('refuses to record an invoice for another branch', async () => {
    await expect(
      ingestInvoice(
        agent,
        capturedInvoice({ invoice_id: 'INV-X', amount_gross: 10_000, branch_id: 'BAG-02' }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('broadcasts the capture in real time', async () => {
    const events: string[] = [];
    subscribe(world.merchantId, (event) => events.push(event.type));

    await capture('INV-1', 15_000);

    expect(events).toContain('INVOICE_CAPTURED');
  });
});

describe('scan attribution and threshold evaluation', () => {
  it('attributes the pending invoice to the scanned card', async () => {
    await capture('INV-1', 10_000);
    const result = await scan();

    expect(result.outcome).toBe('NOT_QUALIFIED');
    expect(result.customer?.id).toBe(world.customerId);

    const stored = await prisma.transaction.findFirstOrThrow({ where: { invoiceId: 'INV-1' } });
    expect(stored.customerId).toBe(world.customerId);
    expect(stored.linkedAt).not.toBeNull();
  });

  it('names the bracket rather than rejecting, and instructs nothing', async () => {
    await capture('INV-1', 10_000);
    const result = await scan();

    expect(result.outcome).toBe('NOT_QUALIFIED');
    expect(result.voucher).toBeNull();

    // A sales prompt: what an invoice needs to be, not what this one missed. It
    // states the bracket itself (25,000), not the difference — the v3 message said
    // «تبقّى 15,000» and the v4 draft said «أضف 15,000 لهذه الفاتورة», which asked
    // the customer to do something the shop forbids: the receipt is already printed
    // and cashiers may not modify an invoice (§1.4, corrected 2026-09-04).
    expect(result.progressMessage).toContain('25,000');
    expect(result.progressMessage).toContain('2٪');
    expect(result.progressMessage).not.toContain('أضف');
    expect(result.progressMessage).not.toContain('تبقّى');

    expect(result.invoiceOutcome?.bracketAmount).toBeNull();
    expect(result.invoiceOutcome?.nextBracketAmount).toBe(25_000);
    expect(result.invoiceOutcome?.amountToNextBracket).toBe(15_000);
  });

  it('grants at exactly the bracket amount — the boundary is inclusive', async () => {
    // 25,000 is the first bracket at 2%. A customer told "spend 25,000 for 2%" who
    // hands over exactly 25,000 must not be refused on an off-by-one.
    await capture('INV-1', 25_000);
    const result = await scan();

    expect(result.outcome).toBe('QUALIFIED');
    expect(result.transaction?.discountValue).toBe(500);
    expect(result.transaction?.amountNet).toBe(24_500);
    expect(result.voucher?.value).toBe(500);
  });

  it('IGNORES prior spend — history buys nothing (v4 §1.1)', async () => {
    // The inversion of the v3 test this replaces, and the single most important
    // assertion in this file. There, 10,000 on top of 20,000 already spent qualified;
    // here the small invoice earns nothing no matter what came before it, because the
    // engine never sees what came before it.
    await capture('INV-1', 20_000);
    await scan('INV-1');

    await capture('INV-2', 10_000);
    const result = await scan('INV-2');

    expect(result.outcome).toBe('NOT_QUALIFIED');
    expect(result.transaction?.discountValue).toBe(0);
    expect(result.voucher).toBeNull();

    // The spend is still recorded — it is history, and history is still kept (§1.4).
    expect(result.lifetime?.totalSpend).toBe(30_000);
    expect(result.lifetime?.transactionCount).toBe(2);
  });

  it('grants on a large invoice even for a first-time customer', async () => {
    // The mirror of the test above. v3 required a customer to accumulate before any
    // discount was possible; v4 rewards the basket in front of the till on its own.
    await capture('INV-ONLY', 90_000);
    const result = await scan('INV-ONLY');

    expect(result.outcome).toBe('QUALIFIED');
    expect(result.transaction?.discountRate).toBe(3);
    expect(result.transaction?.discountValue).toBe(2_700);
    expect(result.lifetime?.transactionCount).toBe(1);
  });

  it('applies the higher bracket once the invoice reaches it', async () => {
    await capture('INV-BIG', 80_000);
    const result = await scan();

    expect(result.transaction?.discountRate).toBe(3);
    expect(result.transaction?.discountValue).toBe(2_400); // 3% of 80,000
  });

  it('offers registration for an unknown card', async () => {
    await capture('INV-1', 30_000);
    const result = await scanCard(station, { barcodeToken: 'v1.not-a-real-card.signature' });

    expect(result.outcome).toBe('UNKNOWN_CARD');
    expect(result.customer).toBeNull();
    // The invoice stays unclaimed for whoever actually holds it.
    const stored = await prisma.transaction.findFirstOrThrow({ where: { invoiceId: 'INV-1' } });
    expect(stored.customerId).toBeNull();
  });

  it('reports nothing pending when no invoice is waiting', async () => {
    const result = await scan();
    expect(result.outcome).toBe('NO_PENDING_INVOICE');
    expect(result.customer?.id).toBe(world.customerId);
  });

  it('never attributes the same invoice twice under concurrency', async () => {
    await capture('INV-ONE', 40_000);

    const attempts = await Promise.all([scan('INV-ONE'), scan('INV-ONE'), scan('INV-ONE')]);
    const qualified = attempts.filter((a) => a.outcome === 'QUALIFIED');

    // Exactly one discount for one sale. More than one voucher on a single invoice
    // would double-discount it and open a cash gap.
    expect(await prisma.voucher.count()).toBe(1);
    expect(qualified.length).toBeGreaterThanOrEqual(1);
  });

  it('ignores an invoice captured at a different branch', async () => {
    await prisma.transaction.create({
      data: {
        merchantId: world.merchantId,
        branchId: world.otherBranchId,
        customerId: null,
        invoiceId: 'INV-OTHER',
        amountGross: 90_000,
        discountType: 'NONE',
        discountRate: 0,
        discountValue: 0,
        amountNet: 90_000,
        currency: 'IQD',
        captureMode: 'SPOOL_WATCH',
        occurredAt: new Date(),
        capturedAt: new Date(),
      },
    });

    const result = await scan();
    expect(result.outcome).toBe('NO_PENDING_INVOICE');
  });
});

describe('the absolute cap in the live engine (§2.3)', () => {
  it('caps a large basket at the configured ceiling', async () => {
    // 3% of 500,000 is 15,000 — roughly the entire net profit on that basket.
    // The cap holds it to 5,000.
    await capture('INV-HUGE', 500_000);
    const result = await scan();

    expect(result.transaction?.discountValue).toBe(5_000);
    expect(result.voucher?.value).toBe(5_000);
    expect(result.transaction?.amountNet).toBe(495_000);
  });

  it('records the capped value, not the uncapped one', async () => {
    await capture('INV-HUGE', 1_000_000);
    await scan();

    const stored = await prisma.transaction.findFirstOrThrow({ where: { invoiceId: 'INV-HUGE' } });
    expect(stored.discountValue).toBe(5_000);
    expect(stored.amountGross - stored.discountValue).toBe(stored.amountNet);
  });

  it('grants nothing when discounting is switched off', async () => {
    await prisma.discountSettings.update({
      where: { merchantId: world.merchantId },
      data: { discountType: 'NONE' },
    });

    await capture('INV-1', 500_000);
    const result = await scan();

    expect(result.outcome).toBe('NOT_QUALIFIED');
    expect(await prisma.voucher.count()).toBe(0);
  });
});

describe('accounting integrity (§0 rule 3)', () => {
  it('never records a discount without a voucher to explain it', async () => {
    await capture('INV-1', 30_000);
    await capture('INV-2', 60_000);
    await scan('INV-1');
    await scan('INV-2');

    const discounted = await prisma.transaction.findMany({ where: { discountValue: { gt: 0 } } });
    expect(discounted.length).toBeGreaterThan(0);

    for (const transaction of discounted) {
      const voucher = await prisma.voucher.findFirst({ where: { transactionId: transaction.id } });
      // A drawer short by an unexplained amount reads as theft in the books and
      // wrongly implicates whoever was on the till.
      expect(voucher, `transaction ${transaction.invoiceId} has no voucher`).not.toBeNull();
      expect(voucher?.value).toBe(transaction.discountValue);
    }
  });

  it('keeps gross, discount and net internally consistent', async () => {
    for (const [id, amount] of [
      ['INV-A', 26_000],
      ['INV-B', 120_000],
      ['INV-C', 900_000],
    ] as const) {
      await capture(id, amount);
      await scan(id);
    }

    const all = await prisma.transaction.findMany();
    for (const t of all) {
      expect(t.amountNet, t.invoiceId).toBe(t.amountGross - t.discountValue);
      expect(t.discountValue).toBeGreaterThanOrEqual(0);
      expect(t.amountNet).toBeGreaterThanOrEqual(0);
    }
  });

  it('leaves the POS gross amount untouched by the discount', async () => {
    // The loyalty system reads what the POS recorded and never rewrites it (§0 #4).
    await capture('INV-1', 25_000);
    await scan();

    const stored = await prisma.transaction.findFirstOrThrow({ where: { invoiceId: 'INV-1' } });
    expect(stored.amountGross).toBe(25_000);
  });

  it('issues at most one voucher per invoice', async () => {
    await capture('INV-1', 30_000);
    await scan('INV-1');
    await scan('INV-1'); // replayed scan

    expect(await prisma.voucher.count({ where: { transactionId: { not: undefined } } })).toBe(1);
  });
});

describe('scan replay', () => {
  it('returns the original outcome instead of a confusing empty result', async () => {
    await capture('INV-1', 30_000);
    const first = await scan('INV-1');
    // The station lost the response and sent again.
    const replay = await scan('INV-1');

    expect(replay.outcome).toBe(first.outcome);
    expect(replay.transaction?.id).toBe(first.transaction?.id);
    expect(replay.voucher?.id).toBe(first.voucher?.id);
    expect(await prisma.voucher.count()).toBe(1);
  });
});

describe('realtime broadcast (§7.2)', () => {
  it('publishes a scan and a voucher issue', async () => {
    const events: string[] = [];
    subscribe(world.merchantId, (event) => events.push(event.type));

    await capture('INV-1', 30_000);
    await scan();

    expect(events).toContain('INVOICE_CAPTURED');
    expect(events).toContain('CARD_SCANNED');
    expect(events).toContain('VOUCHER_ISSUED');
  });

  it('does not leak one merchant’s activity to another', async () => {
    const other = await createWorld(prisma);
    const otherEvents: string[] = [];
    subscribe(other.merchantId, (event) => otherEvents.push(event.type));

    await capture('INV-1', 30_000);

    expect(otherEvents).toHaveLength(0);
  });

  it('survives a subscriber that throws', async () => {
    // A broken socket must not fail the sale that triggered the event.
    subscribe(world.merchantId, () => {
      throw new Error('socket exploded');
    });
    const good: string[] = [];
    subscribe(world.merchantId, (event) => good.push(event.type));

    await expect(capture('INV-1', 10_000)).resolves.toBeDefined();
    expect(good).toContain('INVOICE_CAPTURED');
  });
});

describe('period boundaries', () => {
  it('starts a fresh ladder in a new period', async () => {
    await ingestInvoice(
      agent,
      capturedInvoice({
        invoice_id: 'INV-JULY',
        amount_gross: 90_000,
        occurred_at: '2026-07-10T09:00:00Z',
      }),
    );
    await scan('INV-JULY');

    await ingestInvoice(
      agent,
      capturedInvoice({
        invoice_id: 'INV-AUG',
        amount_gross: 10_000,
        occurred_at: '2026-08-10T09:00:00Z',
      }),
    );
    const august = await scan('INV-AUG');

    // July's 90,000 does not carry over, so 10,000 alone earns nothing.
    expect(august.outcome).toBe('NOT_QUALIFIED');
  });
});

describe('idempotency keys from the sync queue', () => {
  it('treats a replayed operation id as the same capture', async () => {
    const key = randomUUID();
    const first = await ingestInvoice(agent, {
      ...capturedInvoice({ invoice_id: 'INV-KEY', amount_gross: 20_000 }),
      idempotency_key: key,
    });
    const replay = await ingestInvoice(agent, {
      ...capturedInvoice({ invoice_id: 'INV-KEY', amount_gross: 20_000 }),
      idempotency_key: key,
    });

    expect(replay.duplicate).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
  });
});
