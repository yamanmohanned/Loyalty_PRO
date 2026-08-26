/**
 * Development seed — realistic Iraqi data for a single merchant (CLAUDE.md §0.7).
 *
 * This file is a DEV SEED and is clearly marked as such. No part of the production
 * path may depend on it. Names, branches and amounts are plausible Iraqi retail data,
 * never placeholder filler like "John Doe" or "Acme".
 *
 * What it deliberately does NOT create: coupons. Coupon issuance is a threshold
 * crossing detected by the loyalty engine (Phase 1) — minting them by hand here
 * would bake a guess at the business rule into the fixtures.
 *
 * Re-runnable: every write is an upsert keyed on a natural unique constraint.
 */

import { PrismaClient, type PrismaClient as PrismaClientType } from '@prisma/client';
import { hash as argon2Hash } from '@node-rs/argon2';
import { computePeriodKey } from '@walaa/shared-types';
import { loadEnv } from '../src/config/env';
import { generateQrToken } from '../src/lib/qr-token';

const prisma = new PrismaClient();
const env = loadEnv();

/**
 * Dev-only credentials. Printed at the end of the run so there is no hunting for
 * them. Production users are created through the API, never through this file.
 */
const DEV_PASSWORD = 'Walaa!Dev2026';

/** Argon2id with parameters matching what the API will use in Phase 1. */
const ARGON2_OPTIONS = {
  memoryCost: 19_456, // 19 MiB — OWASP minimum for Argon2id
  timeCost: 2,
  parallelism: 1,
} as const;

const MERCHANT_TIMEZONE = env.MERCHANT_TIMEZONE;

/** Fixed reference instant so a re-seed produces the same period bucket. */
const NOW = new Date();

interface SeedTransaction {
  invoiceId: string;
  amount: number;
  /** Days before now the purchase happened. */
  daysAgo: number;
  amountCapture: 'AUTO' | 'MANUAL';
}

interface SeedCustomer {
  name: string;
  phone: string;
  category: 'REGULAR' | 'WHOLESALE' | 'VIP';
  /** Why this fixture exists — which UI state it exercises. */
  covers: string;
  transactions: SeedTransaction[];
}

/**
 * Fixtures chosen to cover every state the dashboard and assistant must render:
 * below the first tier, approaching it, crossed one, crossed all, and no activity.
 */
const CUSTOMERS: SeedCustomer[] = [
  {
    name: 'حسين علي',
    phone: '07701234567',
    category: 'REGULAR',
    covers: 'crossed tier 1, climbing toward tier 2',
    transactions: [
      { invoiceId: 'INV-9801', amount: 62_000, daysAgo: 18, amountCapture: 'AUTO' },
      { invoiceId: 'INV-9807', amount: 45_500, daysAgo: 12, amountCapture: 'AUTO' },
      { invoiceId: 'INV-9814', amount: 73_250, daysAgo: 5, amountCapture: 'MANUAL' },
    ],
  },
  {
    name: 'زينب عبد الرزاق',
    phone: '07811239876',
    category: 'VIP',
    covers: 'crossed every tier',
    transactions: [
      { invoiceId: 'INV-9802', amount: 210_000, daysAgo: 20, amountCapture: 'AUTO' },
      { invoiceId: 'INV-9809', amount: 185_750, daysAgo: 9, amountCapture: 'AUTO' },
      { invoiceId: 'INV-9818', amount: 128_000, daysAgo: 2, amountCapture: 'AUTO' },
    ],
  },
  {
    name: 'مصطفى الكاظمي',
    phone: '07901112233',
    category: 'WHOLESALE',
    covers: 'wholesale volume — large amounts, monospace column width',
    transactions: [
      { invoiceId: 'INV-9803', amount: 640_000, daysAgo: 21, amountCapture: 'MANUAL' },
      { invoiceId: 'INV-9811', amount: 415_500, daysAgo: 11, amountCapture: 'MANUAL' },
      { invoiceId: 'INV-9820', amount: 198_000, daysAgo: 1, amountCapture: 'AUTO' },
    ],
  },
  {
    name: 'نور الهدى حسن',
    phone: '07512345678',
    category: 'REGULAR',
    covers: 'below the first tier',
    transactions: [
      { invoiceId: 'INV-9804', amount: 38_500, daysAgo: 14, amountCapture: 'AUTO' },
      { invoiceId: 'INV-9815', amount: 27_000, daysAgo: 4, amountCapture: 'AUTO' },
    ],
  },
  {
    name: 'علي فاضل الربيعي',
    phone: '07709876543',
    category: 'REGULAR',
    covers: 'just under tier 2 — the amber "approaching" state',
    transactions: [
      { invoiceId: 'INV-9805', amount: 96_000, daysAgo: 16, amountCapture: 'AUTO' },
      { invoiceId: 'INV-9812', amount: 88_750, daysAgo: 8, amountCapture: 'AUTO' },
      { invoiceId: 'INV-9819', amount: 56_500, daysAgo: 2, amountCapture: 'MANUAL' },
    ],
  },
  {
    name: 'رقية جاسم',
    phone: '07803334455',
    category: 'REGULAR',
    covers: 'registered but never scanned — the empty state',
    transactions: [],
  },
  {
    name: 'أحمد عبد الأمير',
    phone: '07705556677',
    category: 'VIP',
    covers: 'crossed tier 2',
    transactions: [
      { invoiceId: 'INV-9806', amount: 175_000, daysAgo: 19, amountCapture: 'AUTO' },
      { invoiceId: 'INV-9816', amount: 142_300, daysAgo: 3, amountCapture: 'AUTO' },
    ],
  },
  {
    name: 'سجى محمد الطائي',
    phone: '07907778899',
    category: 'REGULAR',
    covers: 'a few dinars short of tier 1',
    transactions: [
      { invoiceId: 'INV-9808', amount: 51_000, daysAgo: 13, amountCapture: 'AUTO' },
      { invoiceId: 'INV-9817', amount: 44_250, daysAgo: 6, amountCapture: 'MANUAL' },
    ],
  },
];

/** The merchant default ladder: more spend earns a bigger discount. */
const TIERS = [
  { thresholdAmount: 100_000, discountPct: 5, couponValidityDays: 30, sortOrder: 0 },
  { thresholdAmount: 250_000, discountPct: 10, couponValidityDays: 30, sortOrder: 1 },
  { thresholdAmount: 500_000, discountPct: 15, couponValidityDays: 45, sortOrder: 2 },
];

function daysBefore(days: number): Date {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

/** E.164 normalisation, mirroring packages/shared-types/src/phone.ts. */
function toE164(local: string): string {
  return `+964${local.replace(/^0/, '')}`;
}

async function seed(db: PrismaClientType): Promise<void> {
  // ── Merchant ───────────────────────────────────────────────────────────────
  const merchant = await db.merchant.upsert({
    where: { id: '00000000-0000-4000-8000-000000000001' },
    update: { name: 'سوبرماركت الرشيد', timezone: MERCHANT_TIMEZONE },
    create: {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'سوبرماركت الرشيد',
      timezone: MERCHANT_TIMEZONE,
      currency: 'IQD',
    },
  });

  // ── Branches ───────────────────────────────────────────────────────────────
  const branch = await db.branch.upsert({
    where: { merchantId_code: { merchantId: merchant.id, code: 'BAG-01' } },
    update: { name: 'فرع الكرادة' },
    create: { merchantId: merchant.id, name: 'فرع الكرادة', code: 'BAG-01' },
  });

  // A second branch exists so branch-scoping bugs surface in development rather
  // than in production, and so the Integrations screen has more than one row.
  await db.branch.upsert({
    where: { merchantId_code: { merchantId: merchant.id, code: 'BAG-02' } },
    update: { name: 'فرع المنصور' },
    create: { merchantId: merchant.id, name: 'فرع المنصور', code: 'BAG-02' },
  });

  // ── Staff ──────────────────────────────────────────────────────────────────
  const passwordHash = await argon2Hash(DEV_PASSWORD, ARGON2_OPTIONS);

  const staff = [
    { username: 'owner', name: 'مصطفى الجبوري', role: 'OWNER' as const, branchId: null },
    { username: 'manager', name: 'سارة العبيدي', role: 'MANAGER' as const, branchId: branch.id },
    { username: 'assistant', name: 'حيدر الموسوي', role: 'ASSISTANT' as const, branchId: branch.id },
  ];

  const users = await Promise.all(
    staff.map((s) =>
      db.user.upsert({
        where: { merchantId_username: { merchantId: merchant.id, username: s.username } },
        update: { name: s.name, role: s.role, branchId: s.branchId, isActive: true },
        create: {
          merchantId: merchant.id,
          branchId: s.branchId,
          name: s.name,
          username: s.username,
          passwordHash,
          role: s.role,
        },
      }),
    ),
  );

  const assistant = users.find((u) => u.role === 'ASSISTANT');
  if (!assistant) throw new Error('تعذر إنشاء مستخدم المساعد');

  // ── Loyalty rules ──────────────────────────────────────────────────────────
  const existingRuleSet = await db.loyaltyRuleSet.findFirst({
    where: { merchantId: merchant.id, isActive: true },
  });

  const ruleSet =
    existingRuleSet ??
    (await db.loyaltyRuleSet.create({
      data: { merchantId: merchant.id, periodType: 'MONTHLY', isActive: true },
    }));

  for (const tier of TIERS) {
    await db.loyaltyTier.upsert({
      where: {
        ruleSetId_thresholdAmount: {
          ruleSetId: ruleSet.id,
          thresholdAmount: tier.thresholdAmount,
        },
      },
      update: {
        discountPct: tier.discountPct,
        couponValidityDays: tier.couponValidityDays,
        sortOrder: tier.sortOrder,
      },
      create: { ruleSetId: ruleSet.id, ...tier },
    });
  }

  // ── Customers, transactions and derived balances ───────────────────────────
  let transactionCount = 0;

  for (const fixture of CUSTOMERS) {
    const phone = toE164(fixture.phone);

    const existing = await db.customer.findUnique({
      where: { merchantId_phone: { merchantId: merchant.id, phone } },
    });

    const customer =
      existing ??
      (await db.customer.create({
        data: {
          merchantId: merchant.id,
          name: fixture.name,
          phone,
          category: fixture.category,
          // Opaque signed token — never the phone number (CLAUDE.md §3.6).
          qrToken: generateQrToken(env.QR_TOKEN_SECRET),
        },
      }));

    // Accumulate per period so the snapshot cache matches what the transactions say.
    const perPeriod = new Map<string, { amount: number; count: number }>();

    for (const tx of fixture.transactions) {
      const occurredAt = daysBefore(tx.daysAgo);
      const periodKey = computePeriodKey({
        periodType: ruleSet.periodType,
        occurredAt,
        timeZone: MERCHANT_TIMEZONE,
        customStart: ruleSet.periodStart,
        customEnd: ruleSet.periodEnd,
      });

      await db.transaction.upsert({
        where: {
          merchantId_branchId_invoiceId: {
            merchantId: merchant.id,
            branchId: branch.id,
            invoiceId: tx.invoiceId,
          },
        },
        update: {},
        create: {
          merchantId: merchant.id,
          branchId: branch.id,
          customerId: customer.id,
          invoiceId: tx.invoiceId,
          amount: tx.amount,
          currency: 'IQD',
          occurredAt,
          source: 'SCAN',
          amountCapture: tx.amountCapture,
          periodKey,
          linkedByUserId: assistant.id,
          deviceId: 'seed-device-01',
        },
      });

      transactionCount += 1;
      const bucket = perPeriod.get(periodKey) ?? { amount: 0, count: 0 };
      bucket.amount += tx.amount;
      bucket.count += 1;
      perPeriod.set(periodKey, bucket);
    }

    for (const [periodKey, bucket] of perPeriod) {
      await db.balanceSnapshot.upsert({
        where: { customerId_periodKey: { customerId: customer.id, periodKey } },
        update: { cumulativeAmount: bucket.amount, transactionCount: bucket.count },
        create: {
          merchantId: merchant.id,
          customerId: customer.id,
          periodKey,
          cumulativeAmount: bucket.amount,
          transactionCount: bucket.count,
        },
      });
    }
  }

  // eslint-disable-next-line no-console -- a seed script reports to the operator by design
  console.log(
    [
      '',
      '  ✔ اكتمل إدخال بيانات التطوير',
      '',
      `    التاجر        ${merchant.name}`,
      `    الفروع        BAG-01 (فرع الكرادة) · BAG-02 (فرع المنصور)`,
      `    المستخدمون    ${staff.map((s) => s.username).join(' · ')}`,
      `    كلمة المرور   ${DEV_PASSWORD}   ← بيئة التطوير فقط`,
      `    الزبائن       ${CUSTOMERS.length}`,
      `    العمليات      ${transactionCount}`,
      `    المستويات     ${TIERS.map((t) => `${t.thresholdAmount / 1000}k → ${t.discountPct}%`).join(' · ')}`,
      '',
    ].join('\n'),
  );
}

seed(prisma)
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error: unknown) => {
    console.error('فشل إدخال البيانات:', error);
    await prisma.$disconnect();
    process.exitCode = 1;
  });
