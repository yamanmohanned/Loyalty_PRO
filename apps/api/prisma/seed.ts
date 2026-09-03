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
import {
  computePeriodKey,
  DEFAULT_FEATURE_FLAGS,
  normalizePhone,
  validateRulesAgainstSettings,
  type DiscountRuleInput,
  type FeatureFlagKey,
} from '@walaa/shared-types';
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
/**
 * The ladder this seed installs. Validated below against the settings it also
 * installs, by the same function the API uses (§12.38).
 *
 * The third rule was `7_500` until 2026-09-02, above the 5,000 absolute ceiling in
 * the settings a few lines down — a configuration `PUT /discount/rules` refuses and
 * this file created anyway, because it writes to the database directly. It is
 * 5,000 now: 2.5% of the 200,000 threshold, inside §2.3's recommended band, and a
 * number the engine can actually grant rather than one it silently caps.
 */
const DISCOUNT_RULES: Array<
  Pick<DiscountRuleInput, 'thresholdAmount' | 'discountType' | 'discountRate' | 'maxDiscountValue'> & {
    sortOrder: number;
  }
> = [
  { thresholdAmount: 25_000, discountType: 'PERCENTAGE', discountRate: 2, maxDiscountValue: null, sortOrder: 0 },
  { thresholdAmount: 75_000, discountType: 'PERCENTAGE', discountRate: 3, maxDiscountValue: null, sortOrder: 1 },
  { thresholdAmount: 200_000, discountType: 'FIXED_AMOUNT', discountRate: 5_000, maxDiscountValue: 5_000, sortOrder: 2 },
];

/** The settings the ladder above is checked against, and the ones written below. */
const DISCOUNT_SETTINGS = {
  discountType: 'PERCENTAGE' as const,
  minRate: 1,
  maxRate: 3,
  /** The last line of defence (§2.3). Never ship a percentage without it. */
  absoluteMaxDiscountValue: 5_000,
  periodType: 'MONTHLY' as const,
  settlementStrategy: 'MERCHANT_DEFINED' as const,
};

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

/**
 * E.164 normalisation — the SHARED one, not a copy (§12.38).
 *
 * This was `` `+964${local.replace(/^0/, '')}` ``: a one-line approximation of a
 * twenty-line function. It agreed with the real one for every phone number in this
 * file, which is how it survived — but it validated nothing, and it would have
 * written a non-E.164 value for any fixture entered as `+964…`, `00964…`, or with
 * spaces. §13.4 is explicit that the per-merchant UNIQUE constraint on
 * `customer.phone` is only meaningful if **every** write normalises first, and this
 * file writes customers directly.
 */
const toE164 = (local: string): string => {
  const normalized = normalizePhone(local);
  if (!normalized) throw new Error(`seed fixture has an invalid phone number: ${local}`);
  return normalized;
};

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
    // The Print Capture Agent. `agent/README.md` has always told the installer to
    // configure this username; until the V3-6 security pass there was no such account
    // and no role for it, so the only way to run an agent was to hand it a Station
    // login — which is precisely what `INGEST_ROLES` now prevents. Its password lives in
    // cleartext on the cashier PC, so this account can post a capture and nothing else.
    { username: 'agent', name: 'وكيل الالتقاط — الصندوق ١', role: 'AGENT', branchId: branch.id },
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
    create: { merchantId: merchant.id, ...DISCOUNT_SETTINGS },
  });

  // ── The same check the API runs, on the same implementation (§12.38) ───────
  //
  // This file writes to the database directly, so nothing else stands between it
  // and a configuration the API considers impossible. It got one: a fixed amount
  // above the absolute ceiling, which the engine then silently capped on every
  // qualifying sale. Failing here is the point — a seed that quietly installs an
  // illegal ladder is worse than one that will not run.
  const violations = validateRulesAgainstSettings(DISCOUNT_RULES, DISCOUNT_SETTINGS);
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`  ✗ ${violation.path}: ${violation.message}`);
    }
    throw new Error('DISCOUNT_RULES is not valid under DISCOUNT_SETTINGS — fix the seed');
  }

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

    const customer =
      existing ??
      (await db.customer.create({
        data: {
          merchantId: merchant.id,
          name: fixture.name,
          phone,
          category: fixture.category,
        },
      }));

    // The card lives in its own table now (§12.25). Seeded customers get a THERMAL
    // card, because that is what a card minted here is: printed on demand, with no
    // physical stock behind it and therefore no serial. Pre-printed stock comes from
    // a batch the manager generates, which is a deliberate act and not something a
    // seed should fake.
    const activeCard = await db.card.findFirst({
      where: { merchantId: merchant.id, customerId: customer.id, status: 'ASSIGNED' },
    });

    // Re-mint a card number this server can no longer verify. A developer's database
    // outlives a change to the signing scheme, and a seeded card that cannot be
    // scanned is worse than useless — it looks like a bug in the station.
    if (!activeCard) {
      await db.card.create({
        data: {
          merchantId: merchant.id,
          cardNumber: generateBarcodeToken(env.QR_TOKEN_SECRET),
          scheme: 'card.v1',
          origin: 'THERMAL',
          status: 'ASSIGNED',
          customerId: customer.id,
          assignedAt: new Date(),
        },
      });
      remintedCards += 1;
    } else if (!verifyBarcodeToken(activeCard.cardNumber, env.QR_TOKEN_SECRET)) {
      await db.card.update({
        where: { id: activeCard.id },
        data: { cardNumber: generateBarcodeToken(env.QR_TOKEN_SECRET) },
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
