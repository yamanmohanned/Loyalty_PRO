/**
 * Development seed — realistic Iraqi data for one supermarket (v3).
 *
 * Clearly a DEV SEED. No production path may depend on it. Names, branches and
 * amounts are plausible Iraqi retail data, never placeholder filler.
 *
 * Two things it deliberately does NOT create:
 *  - **Vouchers.** A voucher is proof of a discount granted by the engine at a real
 *    scan. Minting them here would bake a guess at the calculation into fixtures and
 *    let a bug in the engine hide behind seeded data that looks correct.
 *  - **Balances.** There is no balance table to seed (§5.3). Cumulative spend is
 *    derived from transaction rows, so seeding transactions *is* seeding balances.
 *
 * Re-runnable: every write is an upsert keyed on a natural unique constraint.
 */

import { PrismaClient, type PrismaClient as PrismaClientType } from '@prisma/client';
import { hash as argon2Hash } from '@node-rs/argon2';
import { computePeriodKey, DEFAULT_FEATURE_FLAGS, type FeatureFlagKey } from '@walaa/shared-types';
import { loadEnv } from '../src/config/env';
import { applySqlitePragmas } from '../src/lib/prisma';
import { generateBarcodeToken, verifyBarcodeToken } from '../src/lib/barcode-token';

const prisma = new PrismaClient();
const env = loadEnv();

/** Dev-only credentials, printed at the end so there is no hunting for them. */
const DEV_PASSWORD = 'Walaa!Dev2026';

/** Argon2id parameters matching what the API uses. Must not drift, or logins fail. */
const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

const MERCHANT_ID = '00000000-0000-4000-8000-000000000001';
const MERCHANT_TIMEZONE = env.MERCHANT_TIMEZONE;
const NOW = new Date();

/**
 * The default discount ladder.
 *
 * Deliberately inside the **1–3% safe band** (§2.3). The instant discount is a pure
 * price cut with 100% take-up and no return visit to earn it back, so on a 2–4% net
 * margin anything higher loses money on every qualifying sale. A seed that shipped
 * 10% would be teaching the wrong default.
 *
 * The absolute cap is set to 5,000 IQD: at 3%, that binds on any basket above
 * roughly 167,000 IQD, which is where a percentage starts to hurt.
 */
const DISCOUNT_RULES = [
  { thresholdAmount: 25_000, discountType: 'PERCENTAGE', discountRate: 2, maxDiscountValue: null, sortOrder: 0 },
  { thresholdAmount: 75_000, discountType: 'PERCENTAGE', discountRate: 3, maxDiscountValue: null, sortOrder: 1 },
  { thresholdAmount: 200_000, discountType: 'FIXED_AMOUNT', discountRate: 7_500, maxDiscountValue: 7_500, sortOrder: 2 },
];

interface SeedTransaction {
  invoiceId: string;
  amountGross: number;
  daysAgo: number;
  captureMode: 'SPOOL_WATCH' | 'VIRTUAL_PRINTER' | 'MANUAL';
  /** false leaves the invoice unattributed — a real and common outcome (§4). */
  attributed: boolean;
}

interface SeedCustomer {
  name: string;
  phone: string;
  category: 'REGULAR' | 'WHOLESALE' | 'VIP';
  /** Which UI state this fixture exercises. */
  covers: string;
  transactions: SeedTransaction[];
}

const CUSTOMERS: SeedCustomer[] = [
  {
    name: 'حسين علي',
    phone: '07701234567',
    category: 'REGULAR',
    covers: 'cleared tier 1, climbing toward tier 2',
    transactions: [
      { invoiceId: 'INV-9801', amountGross: 28_500, daysAgo: 12, captureMode: 'SPOOL_WATCH', attributed: true },
      { invoiceId: 'INV-9807', amountGross: 19_250, daysAgo: 6, captureMode: 'SPOOL_WATCH', attributed: true },
    ],
  },
  {
    name: 'زينب عبد الرزاق',
    phone: '07811239876',
    category: 'VIP',
    covers: 'cleared every tier',
    transactions: [
      { invoiceId: 'INV-9802', amountGross: 120_000, daysAgo: 15, captureMode: 'SPOOL_WATCH', attributed: true },
      { invoiceId: 'INV-9809', amountGross: 95_500, daysAgo: 8, captureMode: 'VIRTUAL_PRINTER', attributed: true },
      { invoiceId: 'INV-9818', amountGross: 61_000, daysAgo: 2, captureMode: 'SPOOL_WATCH', attributed: true },
    ],
  },
  {
    name: 'مصطفى الكاظمي',
    phone: '07901112233',
    category: 'WHOLESALE',
    covers: 'wholesale volume — large baskets where the absolute cap binds',
    transactions: [
      { invoiceId: 'INV-9803', amountGross: 480_000, daysAgo: 14, captureMode: 'MANUAL', attributed: true },
      { invoiceId: 'INV-9811', amountGross: 315_500, daysAgo: 7, captureMode: 'SPOOL_WATCH', attributed: true },
    ],
  },
  {
    name: 'نور الهدى حسن',
    phone: '07512345678',
    category: 'REGULAR',
    covers: 'below the first threshold — the progress-message state',
    transactions: [
      { invoiceId: 'INV-9804', amountGross: 12_500, daysAgo: 9, captureMode: 'SPOOL_WATCH', attributed: true },
    ],
  },
  {
    name: 'علي فاضل الربيعي',
    phone: '07709876543',
    category: 'REGULAR',
    covers: 'a few dinars short of tier 2',
    transactions: [
      { invoiceId: 'INV-9805', amountGross: 40_000, daysAgo: 11, captureMode: 'SPOOL_WATCH', attributed: true },
      { invoiceId: 'INV-9812', amountGross: 33_750, daysAgo: 4, captureMode: 'SPOOL_WATCH', attributed: true },
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
    covers: 'spend split across two periods, proving the reset',
    transactions: [
      { invoiceId: 'INV-9806', amountGross: 88_000, daysAgo: 45, captureMode: 'SPOOL_WATCH', attributed: true },
      { invoiceId: 'INV-9816', amountGross: 26_300, daysAgo: 3, captureMode: 'SPOOL_WATCH', attributed: true },
    ],
  },
];

/**
 * Invoices captured with no card scanned. These are the majority of real traffic —
 * most shoppers are not enrolled — and the gap between captured and attributed is
 * the enrolment rate, a headline metric rather than an error.
 */
const UNATTRIBUTED: SeedTransaction[] = [
  { invoiceId: 'INV-9820', amountGross: 15_750, daysAgo: 1, captureMode: 'SPOOL_WATCH', attributed: false },
  { invoiceId: 'INV-9821', amountGross: 42_000, daysAgo: 1, captureMode: 'SPOOL_WATCH', attributed: false },
  { invoiceId: 'INV-9822', amountGross: 8_250, daysAgo: 0, captureMode: 'SPOOL_WATCH', attributed: false },
  { invoiceId: 'INV-9823', amountGross: 63_400, daysAgo: 0, captureMode: 'VIRTUAL_PRINTER', attributed: false },
];

function daysBefore(days: number): Date {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

/** E.164 normalisation, mirroring packages/shared-types/src/phone.ts. */
const toE164 = (local: string): string => `+964${local.replace(/^0/, '')}`;

async function seed(db: PrismaClientType): Promise<void> {
  await applySqlitePragmas(prisma);
  // ── Merchant ───────────────────────────────────────────────────────────────
  const merchant = await db.merchant.upsert({
    where: { id: MERCHANT_ID },
    update: { name: 'سوبرماركت الرشيد', timezone: MERCHANT_TIMEZONE },
    create: {
      id: MERCHANT_ID,
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

  await db.branch.upsert({
    where: { merchantId_code: { merchantId: merchant.id, code: 'BAG-02' } },
    update: { name: 'فرع المنصور' },
    create: { merchantId: merchant.id, name: 'فرع المنصور', code: 'BAG-02' },
  });

  // ── Staff ──────────────────────────────────────────────────────────────────
  const passwordHash = await argon2Hash(DEV_PASSWORD, ARGON2_OPTIONS);

  const staff = [
    { username: 'owner', name: 'مصطفى الجبوري', role: 'OWNER', branchId: null },
    { username: 'manager', name: 'سارة العبيدي', role: 'MANAGER', branchId: branch.id },
    // The Loyalty Station operator (§6.2). Scans, registers and prints — and never
    // sees a settings screen.
    { username: 'station', name: 'محطة الولاء — الكرادة', role: 'STATION', branchId: branch.id },
  ];

  for (const s of staff) {
    await db.user.upsert({
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
    });
  }

  const stationUser = await db.user.findUniqueOrThrow({
    where: { merchantId_username: { merchantId: merchant.id, username: 'station' } },
  });

  // ── Discount configuration ─────────────────────────────────────────────────
  await db.discountSettings.upsert({
    where: { merchantId: merchant.id },
    update: {},
    create: {
      merchantId: merchant.id,
      discountType: 'PERCENTAGE',
      minRate: 1,
      maxRate: 3,
      // The last line of defence (§2.3). Never ship a percentage without it.
      absoluteMaxDiscountValue: 5_000,
      periodType: 'MONTHLY',
      settlementStrategy: 'VOUCHER_AS_PAYMENT',
    },
  });

  for (const rule of DISCOUNT_RULES) {
    await db.discountRule.upsert({
      where: {
        merchantId_thresholdAmount: {
          merchantId: merchant.id,
          thresholdAmount: rule.thresholdAmount,
        },
      },
      update: {
        discountType: rule.discountType,
        discountRate: rule.discountRate,
        maxDiscountValue: rule.maxDiscountValue,
        sortOrder: rule.sortOrder,
        isActive: true,
      },
      create: { merchantId: merchant.id, ...rule, isActive: true },
    });
  }

  // ── Feature flags ──────────────────────────────────────────────────────────
  for (const [key, enabled] of Object.entries(DEFAULT_FEATURE_FLAGS) as Array<[FeatureFlagKey, boolean]>) {
    await db.featureFlag.upsert({
      where: { merchantId_key: { merchantId: merchant.id, key } },
      update: {},
      create: { merchantId: merchant.id, key, isEnabled: enabled },
    });
  }

  // ── Customers and captured invoices ────────────────────────────────────────
  let attributedCount = 0;

  const writeTransaction = async (
    tx: SeedTransaction,
    customerId: string | null,
  ): Promise<void> => {
    const occurredAt = daysBefore(tx.daysAgo);
    const periodKey = computePeriodKey({
      periodType: 'MONTHLY',
      occurredAt,
      timeZone: MERCHANT_TIMEZONE,
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
        customerId,
        invoiceId: tx.invoiceId,
        amountGross: tx.amountGross,
        // Seeded rows carry no discount: a discount is the engine's output at a
        // real scan, and inventing one here would let an engine bug hide.
        discountType: 'NONE',
        discountRate: 0,
        discountValue: 0,
        amountNet: tx.amountGross,
        currency: 'IQD',
        captureMode: tx.captureMode,
        periodKey,
        occurredAt,
        capturedAt: occurredAt,
        linkedAt: customerId ? occurredAt : null,
        linkedByUserId: customerId ? stationUser.id : null,
        stationId: customerId ? 'station-01' : null,
      },
    });
  };

  let remintedCards = 0;

  for (const fixture of CUSTOMERS) {
    const phone = toE164(fixture.phone);

    const existing = await db.customer.findUnique({
      where: { merchantId_phone: { merchantId: merchant.id, phone } },
    });

    let customer =
      existing ??
      (await db.customer.create({
        data: {
          merchantId: merchant.id,
          name: fixture.name,
          phone,
          category: fixture.category,
          // Opaque signed card number — never the phone number (§6.2, §12.12).
          barcodeToken: generateBarcodeToken(env.QR_TOKEN_SECRET),
        },
      }));

    // Re-mint a card number this server can no longer verify. A developer's database
    // outlives a change to the signing scheme, and a seeded card that cannot be
    // scanned is worse than useless — it looks like a bug in the station.
    if (!verifyBarcodeToken(customer.barcodeToken, env.QR_TOKEN_SECRET)) {
      customer = await db.customer.update({
        where: { id: customer.id },
        data: { barcodeToken: generateBarcodeToken(env.QR_TOKEN_SECRET) },
      });
      remintedCards += 1;
    }

    for (const tx of fixture.transactions) {
      await writeTransaction(tx, customer.id);
      attributedCount += 1;
    }
  }

  for (const tx of UNATTRIBUTED) {
    await writeTransaction(tx, null);
  }

  // eslint-disable-next-line no-console -- a seed script reports to the operator by design
  console.log(
    [
      '',
      '  ✔ اكتمل إدخال بيانات التطوير (v3)',
      '',
      `    التاجر          ${merchant.name}`,
      `    الفروع          BAG-01 (فرع الكرادة) · BAG-02 (فرع المنصور)`,
      `    المستخدمون      ${staff.map((s) => `${s.username}:${s.role}`).join(' · ')}`,
      `    كلمة المرور     ${DEV_PASSWORD}   ← بيئة التطوير فقط`,
      `    الزبائن         ${CUSTOMERS.length}`,
      ...(remintedCards > 0
        ? [`    أرقام بطاقات جُدّدت ${remintedCards}   ← بصيغة رقمية جديدة (§12.12)`]
        : []),
      `    فواتير مرتبطة   ${attributedCount}`,
      `    فواتير غير مرتبطة ${UNATTRIBUTED.length}   ← طبيعي: أغلب المتسوقين غير مسجّلين`,
      `    قواعد الخصم     ${DISCOUNT_RULES.map((r) => r.discountType === 'PERCENTAGE' ? `${r.thresholdAmount / 1000}k→${r.discountRate}٪` : `${r.thresholdAmount / 1000}k→${r.discountRate} د.ع`).join(' · ')}`,
      `    الحد الأقصى للخصم 5,000 د.ع  ← خط الدفاع الأخير (§2.3)`,
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
