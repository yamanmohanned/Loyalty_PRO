import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isSyncItemSettled, type SyncOperation } from '@walaa/shared-types';
import { getAllFlags, isEnabled, setFlag } from '../services/feature-flags.service';
import { ingestInvoice, type IngestionContext } from '../services/ingestion.service';
import { resetSubscribers } from '../services/realtime.service';
import { scanCard, type ScanContext } from '../services/scan.service';
import {
  ALL_SETTLEMENT_STRATEGIES,
  dailyPromotionalExpenseStrategy,
  getSettlementStrategy,
  voucherAsPaymentStrategy,
} from '../services/settlement';
import { processSyncBatch, type SyncContext } from '../services/sync.service';
import { reconcileDay, redeemVoucher, voidVoucher } from '../services/voucher.service';
import { resetDatabase } from './helpers/db';
import { capturedInvoice, createWorld, type World } from './helpers/fixtures';

/**
 * Settlement strategies, vouchers, feature flags and offline sync.
 *
 * The settlement tests exist because §9 is an open blocker: the mechanism is not
 * confirmed, so both implementations must be correct and interchangeable before
 * the answer arrives.
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
  };
  station = {
    merchantId: world.merchantId,
    userId: world.stationUserId,
    branchId: world.branchId,
    stationId: 'station-01',
  };
});

afterAll(async () => {
  await prisma.$disconnect();
});

const capture = (invoiceId: string, amountGross: number) =>
  ingestInvoice(agent, capturedInvoice({ invoice_id: invoiceId, amount_gross: amountGross }));

const scan = (invoiceId?: string) =>
  scanCard(station, { barcodeToken: world.customerBarcode, ...(invoiceId ? { invoiceId } : {}) });

describe('settlement strategy selection (§9)', () => {
  it('defaults to voucher-as-payment', () => {
    expect(getSettlementStrategy('VOUCHER_AS_PAYMENT').name).toBe('VOUCHER_AS_PAYMENT');
  });

  it('falls back to the preferred strategy on an unrecognised value', () => {
    // SQLite stores this as a plain string. A bad value must not stop the store
    // discounting, and the preferred strategy is the safe default because it never
    // asks a cashier to take short payment.
    expect(getSettlementStrategy('NONSENSE').name).toBe('VOUCHER_AS_PAYMENT');
  });

  it('exposes both implementations for the settings UI', () => {
    expect(ALL_SETTLEMENT_STRATEGIES).toHaveLength(2);
    expect(voucherAsPaymentStrategy.requiresSplitPayment).toBe(true);
    // The fallback exists precisely for a POS that cannot split payment.
    expect(dailyPromotionalExpenseStrategy.requiresSplitPayment).toBe(false);
  });
});

describe('both strategies protect the cash drawer (§0 rule 3)', () => {
  const context = {
    merchantId: 'm',
    transactionId: 't',
    customerId: 'c',
    customerName: 'حسين علي',
    invoiceId: 'INV-1',
    amountGross: 25_000,
    discountValue: 500,
    amountNet: 24_500,
    discountLabel: '2٪',
    issuedAt: new Date(),
  };

  it('voucher-as-payment tells the cashier not to modify the invoice', () => {
    const outcome = voucherAsPaymentStrategy.settle(context);

    expect(outcome.strategy).toBe('VOUCHER_AS_PAYMENT');
    expect(outcome.value).toBe(500);
    // Cashiers are not authorised to modify invoices — the instruction must not
    // ask them to, and must state the full value they leave in place.
    expect(outcome.cashierInstruction).toContain('لا تعدّل الفاتورة');
    expect(outcome.cashierInstruction).toContain('25,000');
    expect(outcome.cashierInstruction).toContain('24,500');
  });

  it('promotional-expense tells the cashier to collect the FULL amount', () => {
    const outcome = dailyPromotionalExpenseStrategy.settle(context);

    expect(outcome.strategy).toBe('DAILY_PROMOTIONAL_EXPENSE');
    // The trap this avoids: telling the cashier to accept less cash, which leaves
    // the drawer short with nothing in the POS to explain it.
    expect(outcome.cashierInstruction).toContain('لا تستلم مبلغاً أقل');
    expect(outcome.cashierInstruction).toContain('25,000');
  });

  it('neither strategy ever instructs short payment', () => {
    for (const strategy of ALL_SETTLEMENT_STRATEGIES) {
      const outcome = strategy.settle(context);
      expect(outcome.value).toBe(context.discountValue);
      expect(outcome.cashierInstruction.length).toBeGreaterThan(0);
      expect(outcome.accountingNote.length).toBeGreaterThan(0);
    }
  });

  it('generates distinct, unambiguous voucher codes', () => {
    const codes = new Set(
      ALL_SETTLEMENT_STRATEGIES.flatMap(() =>
        Array.from({ length: 200 }, () => voucherAsPaymentStrategy.settle(context).code),
      ),
    );
    expect(codes.size).toBeGreaterThan(350);

    for (const code of codes) {
      // Read off thermal paper in poor light — no 0/O or 1/I confusion.
      expect(code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    }
  });
});

describe('the configured strategy is recorded on the voucher', () => {
  it('stamps the strategy in force at issue time', async () => {
    await prisma.discountSettings.update({
      where: { merchantId: world.merchantId },
      data: { settlementStrategy: 'DAILY_PROMOTIONAL_EXPENSE' },
    });

    await capture('INV-1', 30_000);
    const result = await scan();

    expect(result.voucher?.settlementStrategy).toBe('DAILY_PROMOTIONAL_EXPENSE');
  });

  it('does not retroactively reinterpret slips already in the drawer', async () => {
    await capture('INV-1', 30_000);
    const first = await scan('INV-1');
    expect(first.voucher?.settlementStrategy).toBe('VOUCHER_AS_PAYMENT');

    // The manager switches strategy after the slip is already printed and handed over.
    await prisma.discountSettings.update({
      where: { merchantId: world.merchantId },
      data: { settlementStrategy: 'DAILY_PROMOTIONAL_EXPENSE' },
    });

    const stored = await prisma.voucher.findFirstOrThrow({
      where: { id: first.voucher?.id ?? '' },
    });
    expect(stored.settlementStrategy).toBe('VOUCHER_AS_PAYMENT');
  });
});

describe('voucher lifecycle', () => {
  async function issue(): Promise<string> {
    await capture('INV-1', 30_000);
    const result = await scan();
    const id = result.voucher?.id;
    if (!id) throw new Error('fixture failed to issue a voucher');
    return id;
  }

  it('redeems once', async () => {
    const voucherId = await issue();
    const result = await redeemVoucher({
      merchantId: world.merchantId,
      voucherId,
      actorUserId: world.stationUserId,
    });

    expect(result.voucher.status).toBe('REDEEMED');
    expect(result.accountingNote.length).toBeGreaterThan(0);
  });

  it('refuses a second redemption', async () => {
    const voucherId = await issue();
    await redeemVoucher({
      merchantId: world.merchantId,
      voucherId,
      actorUserId: world.stationUserId,
    });

    await expect(
      redeemVoucher({ merchantId: world.merchantId, voucherId, actorUserId: world.stationUserId }),
    ).rejects.toMatchObject({ code: 'COUPON_NOT_REDEEMABLE' });
  });

  it('lets exactly one of many concurrent redemptions win', async () => {
    // Two cashiers settling the same slip would be a cash discrepancy.
    const voucherId = await issue();

    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        redeemVoucher({
          merchantId: world.merchantId,
          voucherId,
          actorUserId: world.stationUserId,
        }),
      ),
    );

    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
  });

  it('refuses a voucher from another merchant', async () => {
    const voucherId = await issue();
    const other = await createWorld(prisma);

    await expect(
      redeemVoucher({
        merchantId: other.merchantId,
        voucherId,
        actorUserId: other.stationUserId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('voids an unredeemed voucher and blocks later redemption', async () => {
    const voucherId = await issue();
    await voidVoucher({
      merchantId: world.merchantId,
      voucherId,
      actorUserId: world.managerId,
      reason: 'الزبون غادر دون إتمام الشراء',
    });

    await expect(
      redeemVoucher({ merchantId: world.merchantId, voucherId, actorUserId: world.stationUserId }),
    ).rejects.toMatchObject({ code: 'COUPON_NOT_REDEEMABLE' });
  });

  it('audits every redemption', async () => {
    const voucherId = await issue();
    await redeemVoucher({
      merchantId: world.merchantId,
      voucherId,
      actorUserId: world.stationUserId,
    });

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'voucher.redeemed', entityId: voucherId },
    });
    expect(audit?.actorUserId).toBe(world.stationUserId);
  });
});

describe('end-of-day reconciliation', () => {
  it('separates redeemed from outstanding slips', async () => {
    await capture('INV-1', 30_000);
    const a = await scan('INV-1');
    await capture('INV-2', 60_000);
    const b = await scan('INV-2');

    await redeemVoucher({
      merchantId: world.merchantId,
      voucherId: a.voucher?.id ?? '',
      actorUserId: world.stationUserId,
    });

    const report = await reconcileDay(world.merchantId);

    expect(report.issuedCount).toBe(2);
    expect(report.redeemedCount).toBe(1);
    // Outstanding is the number a manager acts on: slips issued but never
    // collected mean the drawer will not match what the system believes.
    expect(report.outstandingCount).toBe(1);
    expect(report.outstandingValue).toBe(b.voucher?.value ?? 0);
    expect(report.issuedValue).toBe(report.redeemedValue + report.outstandingValue);
  });
});

describe('feature flags (§8)', () => {
  it('returns shipping defaults for a merchant with no rows', async () => {
    await prisma.featureFlag.deleteMany({ where: { merchantId: world.merchantId } });
    const flags = await getAllFlags(world.merchantId);

    // A mandatory safeguard that ships switched off is not a safeguard.
    expect(flags.cloud_backup).toBe(true);
    expect(flags.whatsapp_integration).toBe(false);
    // Out of scope for v3 (§12.4).
    expect(flags.auto_update).toBe(false);
  });

  it('toggles a flag and audits the change', async () => {
    await setFlag({
      merchantId: world.merchantId,
      key: 'whatsapp_integration',
      isEnabled: true,
      actorUserId: world.managerId,
    });

    expect(await isEnabled(world.merchantId, 'whatsapp_integration')).toBe(true);

    const audit = await prisma.auditLog.findFirst({ where: { action: 'feature_flag.toggled' } });
    expect(audit?.entityId).toBe('whatsapp_integration');
  });

  it('rejects an unknown flag key', async () => {
    await expect(
      setFlag({
        merchantId: world.merchantId,
        key: 'not_a_real_flag',
        isEnabled: true,
        actorUserId: world.managerId,
      }),
    ).rejects.toThrow();
  });

  it('scopes flags to a merchant', async () => {
    const other = await createWorld(prisma);
    await setFlag({
      merchantId: world.merchantId,
      key: 'advanced_reports',
      isEnabled: true,
      actorUserId: world.managerId,
    });

    expect(await isEnabled(world.merchantId, 'advanced_reports')).toBe(true);
    expect(await isEnabled(other.merchantId, 'advanced_reports')).toBe(false);
  });
});

describe('offline sync reconciliation (§7.2)', () => {
  let syncContext: SyncContext;

  beforeEach(() => {
    syncContext = {
      merchantId: world.merchantId,
      userId: world.stationUserId,
      branchId: world.branchId,
      deviceId: 'agent-01',
    };
  });

  const ingestOp = (invoiceId: string, amount: number): SyncOperation => ({
    type: 'INGEST_INVOICE',
    operationId: randomUUID(),
    queuedAt: new Date().toISOString(),
    payload: capturedInvoice({ invoice_id: invoiceId, amount_gross: amount }),
  });

  it('flushes a queue of captures recorded while offline', async () => {
    const response = await processSyncBatch(syncContext, {
      deviceId: 'agent-01',
      operations: [ingestOp('OFF-1', 20_000), ingestOp('OFF-2', 30_000), ingestOp('OFF-3', 40_000)],
    });

    expect(response.results.every((r) => r.status === 'APPLIED')).toBe(true);
    expect(await prisma.transaction.count()).toBe(3);
  });

  it('is idempotent when the whole batch is replayed', async () => {
    // The classic offline failure: the batch applied but the response never
    // reached the device, so it sends the same queue again.
    const operations = [ingestOp('OFF-1', 20_000), ingestOp('OFF-2', 30_000)];

    await processSyncBatch(syncContext, { deviceId: 'agent-01', operations });
    const replay = await processSyncBatch(syncContext, { deviceId: 'agent-01', operations });

    expect(await prisma.transaction.count()).toBe(2);
    expect(replay.results.every((r) => r.status === 'DUPLICATE')).toBe(true);
    // DUPLICATE is settled — the device clears it rather than retrying forever.
    expect(replay.results.every((r) => isSyncItemSettled(r.status))).toBe(true);
  });

  it('lets one bad operation fail without poisoning the batch', async () => {
    const operations: SyncOperation[] = [
      ingestOp('GOOD-1', 20_000),
      {
        type: 'SCAN_CARD',
        operationId: randomUUID(),
        queuedAt: new Date().toISOString(),
        payload: { barcodeToken: 'v1.unknown.card' },
      },
      ingestOp('GOOD-2', 30_000),
    ];

    const response = await processSyncBatch(syncContext, { deviceId: 'agent-01', operations });

    expect(response.results[0]?.status).toBe('APPLIED');
    expect(response.results[2]?.status).toBe('APPLIED');
    // The good captures committed regardless of what happened in the middle.
    expect(await prisma.transaction.count()).toBe(2);
  });

  it('rejects a re-registration rather than retrying it forever', async () => {
    const response = await processSyncBatch(syncContext, {
      deviceId: 'station-01',
      operations: [
        {
          type: 'CREATE_CUSTOMER',
          operationId: randomUUID(),
          queuedAt: new Date().toISOString(),
          payload: { name: 'حسين علي', phone: world.customerPhone, category: 'REGULAR' },
        },
      ],
    });

    expect(response.results[0]?.status).toBe('REJECTED');
    expect(response.results[0]?.errorCode).toBe('CUSTOMER_ALREADY_EXISTS');
  });

  it('preserves the offline occurrence time, not the sync time', async () => {
    // A sale made offline belongs to the period it happened in. Getting this wrong
    // would silently move spend between periods for every device syncing after a
    // boundary.
    await processSyncBatch(syncContext, {
      deviceId: 'agent-01',
      operations: [
        {
          type: 'INGEST_INVOICE',
          operationId: randomUUID(),
          queuedAt: new Date().toISOString(),
          payload: capturedInvoice({
            invoice_id: 'OFF-JULY',
            amount_gross: 15_000,
            occurred_at: '2026-07-20T08:30:00Z',
          }),
        },
      ],
    });

    const stored = await prisma.transaction.findFirstOrThrow({ where: { invoiceId: 'OFF-JULY' } });
    expect(stored.occurredAt.toISOString()).toBe('2026-07-20T08:30:00.000Z');
    expect(stored.periodKey).toBe('2026-07');
  });

  it('reconciles a full offline session end to end', async () => {
    // Device offline: three captures, then a scan that qualifies on the total.
    const response = await processSyncBatch(syncContext, {
      deviceId: 'agent-01',
      operations: [ingestOp('OFF-1', 12_000), ingestOp('OFF-2', 9_000), ingestOp('OFF-3', 6_000)],
    });
    expect(response.results.every((r) => r.status === 'APPLIED')).toBe(true);

    for (const invoiceId of ['OFF-1', 'OFF-2', 'OFF-3']) {
      await scan(invoiceId);
    }

    // 27,000 cumulative clears the 25,000 threshold, so the last basket is discounted.
    const vouchers = await prisma.voucher.count();
    expect(vouchers).toBe(1);
  });

  it('returns a server clock so a skewed device can correct itself', async () => {
    const response = await processSyncBatch(syncContext, {
      deviceId: 'agent-01',
      operations: [ingestOp('OFF-1', 10_000)],
    });
    expect(() => new Date(response.serverTime).toISOString()).not.toThrow();
  });
});

describe('the printed slip (§6.3)', () => {
  it('carries every figure the cashier needs, so nothing is calculated at the till', async () => {
    await capture('INV-SLIP-1', 90_000);
    const outcome = await scan('INV-SLIP-1');

    expect(outcome.outcome).toBe('QUALIFIED');
    const slip = outcome.slip;
    expect(slip).not.toBeNull();
    if (!slip) return;

    expect(slip.invoiceId).toBe('INV-SLIP-1');
    expect(slip.customerName).toBe('حسين علي');
    expect(slip.voucherCode).toBe(outcome.voucher?.code);
    expect(slip.amountBefore).toBe(90_000);
    expect(slip.discountValue).toBe(outcome.voucher?.value);
    // The arithmetic the cashier must never have to do themselves.
    expect(slip.amountBefore - slip.discountValue).toBe(slip.amountAfter);
    expect(slip.discountLabel).toMatch(/٪|د\.ع/);
    expect(slip.cashierInstruction.length).toBeGreaterThan(20);
  });

  it('is absent when no discount was earned', async () => {
    // A slip with nothing on it is a slip a cashier might still act on.
    await capture('INV-SLIP-2', 1_000);
    const outcome = await scan('INV-SLIP-2');

    expect(outcome.outcome).toBe('NOT_QUALIFIED');
    expect(outcome.slip).toBeNull();
    expect(outcome.voucher).toBeNull();
  });

  it('reprints identically when a station retries a scan it lost the answer to', async () => {
    await capture('INV-SLIP-3', 120_000);
    const first = await scan('INV-SLIP-3');
    const retry = await scan('INV-SLIP-3');

    expect(first.slip).not.toBeNull();
    expect(retry.slip).not.toBeNull();
    // The same paper, not a second discount and not a second voucher code — the
    // end-of-day reconciliation is looking for exactly one slip per discount.
    expect(retry.slip?.voucherCode).toBe(first.slip?.voucherCode);
    expect(retry.slip?.amountAfter).toBe(first.slip?.amountAfter);
    expect(retry.slip?.cashierInstruction).toBe(first.slip?.cashierInstruction);
  });

  it('words the slip with the strategy recorded on the voucher, not today setting', async () => {
    await capture('INV-SLIP-4', 100_000);
    const issued = await scan('INV-SLIP-4');
    expect(issued.voucher?.settlementStrategy).toBe('VOUCHER_AS_PAYMENT');
    expect(issued.slip?.cashierInstruction).toContain('لا تعدّل الفاتورة');

    // The merchant switches strategy after the slip is already in the drawer.
    await prisma.discountSettings.updateMany({
      where: { merchantId: world.merchantId },
      data: { settlementStrategy: 'DAILY_PROMOTIONAL_EXPENSE' },
    });

    const reprint = await scan('INV-SLIP-4');
    // Still the original wording: a cashier holding that slip was told to do one
    // thing, and re-reading it must not tell them to do the opposite.
    expect(reprint.slip?.cashierInstruction).toBe(issued.slip?.cashierInstruction);
    expect(reprint.slip?.cashierInstruction).toContain('لا تعدّل الفاتورة');
  });
});

describe('a scan that arrives after the sale was settled (§7.2 offline queue)', () => {
  it('credits the spend but issues no discount and no voucher', async () => {
    await capture('INV-OFF-1', 150_000);

    // What the sync route does with a queued scan: the customer paid full price at
    // the till hours ago, so a voucher issued now would be one the cash drawer
    // cannot produce at closing time.
    const outcome = await scanCard(
      station,
      { barcodeToken: world.customerBarcode, invoiceId: 'INV-OFF-1' },
      { issueDiscount: false },
    );

    expect(outcome.outcome).toBe('LINKED_WITHOUT_DISCOUNT');
    expect(outcome.voucher).toBeNull();
    expect(outcome.slip).toBeNull();

    const stored = await prisma.transaction.findFirstOrThrow({
      where: { merchantId: world.merchantId, invoiceId: 'INV-OFF-1' },
    });
    // Attributed to the customer…
    expect(stored.customerId).toBe(world.customerId);
    // …recorded at what they actually paid.
    expect(stored.discountValue).toBe(0);
    expect(stored.amountNet).toBe(150_000);
    expect(stored.discountType).toBe('NONE');

    const vouchers = await prisma.voucher.count({ where: { transactionId: stored.id } });
    expect(vouchers).toBe(0);
  });

  it('still moves the customer toward their next discount', async () => {
    // Losing the discount on one basket is the cost of the network being down.
    // Losing the progress as well would penalise the customer twice for it.
    await capture('INV-OFF-2', 150_000);
    const outcome = await scanCard(
      station,
      { barcodeToken: world.customerBarcode, invoiceId: 'INV-OFF-2' },
      { issueDiscount: false },
    );

    expect(outcome.balance?.cumulativeAmount).toBe(150_000);
  });

  it('is distinguishable from a customer who simply did not qualify', async () => {
    await capture('INV-OFF-3', 1_000);
    const small = await scanCard(station, {
      barcodeToken: world.customerBarcode,
      invoiceId: 'INV-OFF-3',
    });
    expect(small.outcome).toBe('NOT_QUALIFIED');

    await capture('INV-OFF-4', 150_000);
    const deferred = await scanCard(
      station,
      { barcodeToken: world.customerBarcode, invoiceId: 'INV-OFF-4' },
      { issueDiscount: false },
    );
    // A report that conflated these two would understate how often the network cost
    // a customer a discount they had earned.
    expect(deferred.outcome).toBe('LINKED_WITHOUT_DISCOUNT');
  });
});
