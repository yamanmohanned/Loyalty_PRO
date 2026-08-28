import type { PrismaClient } from '@prisma/client';
import { computePeriodKey } from '@walaa/shared-types';
import { loadEnv } from '../../config/env';
import { generateBarcodeToken } from '../../lib/barcode-token';
import { hashPassword } from '../../lib/password';

/**
 * Minimal, explicit fixtures (v3).
 *
 * Deliberately not the dev seed: tests assert on exact amounts and thresholds, so
 * each case builds precisely the world it needs. Reusing the seed would couple
 * every assertion to fixture data that exists for a different purpose.
 */

const env = loadEnv();

export const TEST_PASSWORD = 'TestPassw0rd!';

export interface World {
  merchantId: string;
  branchId: string;
  branchCode: string;
  otherBranchId: string;
  otherBranchCode: string;
  ownerId: string;
  managerId: string;
  stationUserId: string;
  customerId: string;
  customerPhone: string;
  customerBarcode: string;
}

/**
 * The ladder used across the suite. Inside the 1–3% safe band (§2.3), because a
 * fixture is also a worked example and should not model a rate that loses money.
 */
export const DISCOUNT_RULES = [
  { thresholdAmount: 25_000, discountType: 'PERCENTAGE', discountRate: 2, maxDiscountValue: null, sortOrder: 0 },
  { thresholdAmount: 75_000, discountType: 'PERCENTAGE', discountRate: 3, maxDiscountValue: null, sortOrder: 1 },
];

export const ABSOLUTE_MAX_DISCOUNT = 5_000;

export async function createWorld(
  prisma: PrismaClient,
  options?: { periodType?: 'WEEKLY' | 'MONTHLY' | 'CUSTOM'; timezone?: string },
): Promise<World> {
  const merchant = await prisma.merchant.create({
    data: {
      name: 'سوبرماركت الاختبار',
      timezone: options?.timezone ?? 'Asia/Baghdad',
      currency: 'IQD',
    },
  });

  const branch = await prisma.branch.create({
    data: { merchantId: merchant.id, name: 'فرع الاختبار', code: 'BAG-01' },
  });
  const otherBranch = await prisma.branch.create({
    data: { merchantId: merchant.id, name: 'فرع آخر', code: 'BAG-02' },
  });

  const passwordHash = await hashPassword(TEST_PASSWORD);

  const owner = await prisma.user.create({
    data: {
      merchantId: merchant.id,
      name: 'المالك',
      username: 'owner',
      passwordHash,
      role: 'OWNER',
      branchId: null,
    },
  });
  const manager = await prisma.user.create({
    data: {
      merchantId: merchant.id,
      name: 'المدير',
      username: 'manager',
      passwordHash,
      role: 'MANAGER',
      branchId: branch.id,
    },
  });
  const station = await prisma.user.create({
    data: {
      merchantId: merchant.id,
      name: 'محطة الولاء',
      username: 'station',
      passwordHash,
      role: 'STATION',
      branchId: branch.id,
    },
  });

  await prisma.discountSettings.create({
    data: {
      merchantId: merchant.id,
      discountType: 'PERCENTAGE',
      minRate: 1,
      maxRate: 3,
      absoluteMaxDiscountValue: ABSOLUTE_MAX_DISCOUNT,
      periodType: options?.periodType ?? 'MONTHLY',
      settlementStrategy: 'VOUCHER_AS_PAYMENT',
    },
  });

  for (const rule of DISCOUNT_RULES) {
    await prisma.discountRule.create({
      data: { merchantId: merchant.id, ...rule, isActive: true },
    });
  }

  const customer = await prisma.customer.create({
    data: {
      merchantId: merchant.id,
      name: 'حسين علي',
      phone: '+9647701234567',
      category: 'REGULAR',
      barcodeToken: generateBarcodeToken(env.QR_TOKEN_SECRET),
    },
  });

  return {
    merchantId: merchant.id,
    branchId: branch.id,
    branchCode: branch.code,
    otherBranchId: otherBranch.id,
    otherBranchCode: otherBranch.code,
    ownerId: owner.id,
    managerId: manager.id,
    stationUserId: station.id,
    customerId: customer.id,
    customerPhone: customer.phone,
    customerBarcode: customer.barcodeToken,
  };
}

/**
 * Writes a captured transaction directly.
 *
 * `customerId: null` produces an unattributed capture — an invoice the agent
 * recorded before (or without) any card scan, which is the common case in a real
 * store and must be exercised as a first-class state.
 */
export async function createTransaction(
  prisma: PrismaClient,
  world: World,
  params: {
    invoiceId: string;
    amountGross: number;
    customerId?: string | null;
    occurredAt?: Date;
    captureMode?: string;
    branchId?: string;
    timezone?: string;
  },
): Promise<{ id: string; periodKey: string }> {
  const occurredAt = params.occurredAt ?? new Date();
  const periodKey = computePeriodKey({
    periodType: 'MONTHLY',
    occurredAt,
    timeZone: params.timezone ?? 'Asia/Baghdad',
  });

  const customerId = params.customerId === undefined ? world.customerId : params.customerId;

  const created = await prisma.transaction.create({
    data: {
      merchantId: world.merchantId,
      branchId: params.branchId ?? world.branchId,
      customerId,
      invoiceId: params.invoiceId,
      amountGross: params.amountGross,
      discountType: 'NONE',
      discountRate: 0,
      discountValue: 0,
      amountNet: params.amountGross,
      currency: 'IQD',
      captureMode: params.captureMode ?? 'SPOOL_WATCH',
      periodKey,
      occurredAt,
      capturedAt: occurredAt,
      linkedAt: customerId ? occurredAt : null,
      linkedByUserId: customerId ? world.stationUserId : null,
    },
  });

  return { id: created.id, periodKey };
}

/** A captured-invoice payload as the Print Capture Agent would send it. */
export function capturedInvoice(overrides: {
  invoice_id: string;
  amount_gross: number;
  branch_id?: string;
  occurred_at?: string;
  capture_mode?: 'SPOOL_WATCH' | 'VIRTUAL_PRINTER' | 'SERIAL_BRIDGE' | 'NETWORK_PROXY' | 'MANUAL';
}) {
  const occurred = overrides.occurred_at ?? new Date().toISOString();
  return {
    invoice_id: overrides.invoice_id,
    amount_gross: overrides.amount_gross,
    currency: 'IQD' as const,
    branch_id: overrides.branch_id ?? 'BAG-01',
    occurred_at: occurred,
    captured_at: occurred,
    capture_mode: overrides.capture_mode ?? ('SPOOL_WATCH' as const),
  };
}
