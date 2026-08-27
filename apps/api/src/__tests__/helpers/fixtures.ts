import type { PrismaClient } from '@prisma/client';
import { hashPassword } from '../../lib/password';
import { generateQrToken } from '../../lib/qr-token';
import { loadEnv } from '../../config/env';

/**
 * Minimal, explicit fixtures.
 *
 * Deliberately not the dev seed: tests assert on exact amounts and thresholds, so
 * they build precisely the world each case needs. Reusing the seed would couple
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
  assistantId: string;
  ruleSetId: string;
  customerId: string;
  customerPhone: string;
  customerQrToken: string;
}

/** Tier ladder used across the suite: 100k→5%, 250k→10%, 500k→15%. */
export const TIERS = [
  { thresholdAmount: 100_000, discountPct: 5, couponValidityDays: 30, sortOrder: 0 },
  { thresholdAmount: 250_000, discountPct: 10, couponValidityDays: 30, sortOrder: 1 },
  { thresholdAmount: 500_000, discountPct: 15, couponValidityDays: 45, sortOrder: 2 },
];

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
  const assistant = await prisma.user.create({
    data: {
      merchantId: merchant.id,
      name: 'المساعد',
      username: 'assistant',
      passwordHash,
      role: 'ASSISTANT',
      branchId: branch.id,
    },
  });

  const ruleSet = await prisma.loyaltyRuleSet.create({
    data: {
      merchantId: merchant.id,
      periodType: options?.periodType ?? 'MONTHLY',
      isActive: true,
      tiers: { create: TIERS },
    },
  });

  const customer = await prisma.customer.create({
    data: {
      merchantId: merchant.id,
      name: 'حسين علي',
      phone: '+9647701234567',
      category: 'REGULAR',
      qrToken: generateQrToken(env.QR_TOKEN_SECRET),
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
    assistantId: assistant.id,
    ruleSetId: ruleSet.id,
    customerId: customer.id,
    customerPhone: customer.phone,
    customerQrToken: customer.qrToken,
  };
}

/** Builds a Normalized Invoice Schema payload with sensible defaults. */
export function invoice(overrides: {
  invoice_id: string;
  amount: number;
  branch_id?: string;
  occurred_at?: string;
  amount_capture?: 'auto' | 'manual';
}) {
  return {
    invoice_id: overrides.invoice_id,
    amount: overrides.amount,
    currency: 'IQD' as const,
    branch_id: overrides.branch_id ?? 'BAG-01',
    customer_identifier: '+9647701234567',
    occurred_at: overrides.occurred_at ?? new Date().toISOString(),
    source: 'scan' as const,
    amount_capture: overrides.amount_capture ?? 'auto',
  };
}
