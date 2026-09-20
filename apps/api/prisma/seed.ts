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
  DEFAULT_FEATURE_FLAGS,
  normalizePhone,
  validateRulesAgainstSettings,
  type DiscountRuleInput,
  type FeatureFlagKey,
} from '@loyalty-pro/shared-types';
import { loadEnv } from '../src/config/env';
import { createCustomer } from '../src/services/customer.service';
import { ingestInvoice } from '../src/services/ingestion.service';
import { scanCard } from '../src/services/scan.service';
import { redeemVoucher } from '../src/services/voucher.service';
import {
  generateCardBatch,
  replaceCard,
  reportCardLost,
  voidCard,
} from '../src/services/card.service';
import { applySqlitePragmas } from '../src/lib/prisma';
import { generateBarcodeToken, verifyBarcodeToken } from '../src/lib/barcode-token';

const prisma = new PrismaClient();
const env = loadEnv();

/** Dev-only credentials, printed at the end so there is no hunting for them. */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THIS SCRIPT REFUSES TO RUN AGAINST A PRODUCTION DATABASE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It creates `owner` / `manager` / `station` / `agent`, all with the password on the
 * next line — a password that is in this repository, in the shell history of everyone
 * who has run this, and in every conversation about the project. On a developer's
 * machine that is exactly right. On a merchant's it would be the single worst
 * credential mistake this product could make: the same working login on every
 * installation, published.
 *
 * Two things keep it away from a shop, and the second exists because the first is not
 * a guarantee:
 *
 *   1. **It is not shipped.** `stage.mjs` bundles `src/server.ts` and its imports; this
 *      is a `prisma/` script and never enters the bundle. A merchant's machine has no
 *      copy of it and no `tsx` to run it with.
 *   2. **It refuses anyway.** Not being present is a property of the packaging, and
 *      packaging changes. A developer with the repository open, a `DATABASE_URL`
 *      pointed at a restored copy of a shop's database, and one absent-minded
 *      `pnpm db:seed` is the realistic accident — and it would put a published password
 *      into a live shop with no error at all.
 *
 * The check is `NODE_ENV`, which the installer writes as `production` into every
 * `loyalty-pro.env` it generates. `LOYALTY_ALLOW_PRODUCTION_SEED=1` overrides it for the one
 * legitimate case: rebuilding a demo dataset from a production-shaped environment.
 */
function refuseInProduction(): void {
  const production = process.env.NODE_ENV === 'production';
  const overridden = process.env.LOYALTY_ALLOW_PRODUCTION_SEED === '1';
  if (!production || overridden) return;

  console.error(
    [
      '',
      '  REFUSED: this is a development seed and NODE_ENV is production.',
      '',
      '  It would create accounts whose password is published in this repository.',
      '  A real shop creates its own owner on first launch — see',
      '  `bootstrap.service.ts` and the first-run screen.',
      '',
      '  If you genuinely mean to seed a production-shaped database (rebuilding a',
      '  demo dataset, for instance), set LOYALTY_ALLOW_PRODUCTION_SEED=1.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

refuseInProduction();

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
  settlementStrategy: 'MERCHANT_DEFINED' as const,
};

interface SeedTransaction {
  invoiceId: string;
  amountGross: number;
  daysAgo: number;
  captureMode: 'SPOOL_WATCH' | 'VIRTUAL_PRINTER' | 'SERIAL_BRIDGE' | 'NETWORK_PROXY' | 'MANUAL';
  /** false leaves the invoice unattributed — a real and common outcome (§4). */
  attributed: boolean;
  /** Redeem the voucher this invoice earns, so the funnel is not all-outstanding. */
  redeem?: boolean;
}

/**
 * How this customer's card came to exist.
 *
 *  - `THERMAL` — printed at the counter, no physical stock behind it, no serial.
 *  - `PRE_PRINTED` — assigned from a batch the manager generated (§12.25).
 *  - `LOST_NO_REPLACEMENT` — pre-printed, then reported lost and never replaced, so
 *    the customer holds **no card at all**. `cardNumber: null` is a normal state, not
 *    an error (§12.25), and nothing else in the fixture set renders it.
 *  - `REPLACED` — pre-printed, reported lost, replaced. Two card rows, one live.
 */
type SeedCardOrigin = 'THERMAL' | 'PRE_PRINTED' | 'LOST_NO_REPLACEMENT' | 'REPLACED';

interface SeedCustomer {
  name: string;
  phone: string;
  category: 'REGULAR' | 'WHOLESALE' | 'VIP';
  card: SeedCardOrigin;
  /** Which UI state this fixture exercises. */
  covers: string;
  transactions: SeedTransaction[];
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE FIXTURE MATRIX — every amount here is chosen to render a state
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Under v4 a bracket is a property of an invoice, so a fixture's *amounts* are what
 * decide which screen states appear — not the customer's history, which now renders
 * nothing but a lifetime total. Every `covers` note below names a state, and the
 * whole set is checked against the screens rather than assumed.
 *
 * With the ladder at 25,000→2% · 75,000→3% · 200,000→5,000 fixed and a 5,000 cap:
 *
 *  - **The cap only bites between 166,667 and 199,999.** Below that 3% is under
 *    5,000; at 200,000 and above the FIXED rule pays exactly 5,000 and nothing is
 *    trimmed. That narrow window is why the capped fixture is 185,000 and not 480,000
 *    — an obvious-looking "very large basket" would NOT have exercised §12.37 at all.
 *  - **The 200,000 bracket is deliberately empty in the default 30-day range**, so
 *    `bracketPerformance` renders a zero row with its label intact (§12.33) — and
 *    fills in when the range is switched to 90d, which exercises the range control at
 *    the same time.
 */
const CUSTOMERS: SeedCustomer[] = [
  {
    name: 'حسين علي',
    phone: '07701234567',
    category: 'REGULAR',
    card: 'THERMAL',
    covers: 'one invoice qualifies, one does not — the two outcomes on one customer',
    transactions: [
      { invoiceId: 'INV-9801', amountGross: 28_500, daysAgo: 12, captureMode: 'SPOOL_WATCH', attributed: true, redeem: true },
      { invoiceId: 'INV-9807', amountGross: 19_250, daysAgo: 6, captureMode: 'SPOOL_WATCH', attributed: true },
    ],
  },
  {
    name: 'زينب عبد الرزاق',
    phone: '07811239876',
    category: 'VIP',
    card: 'PRE_PRINTED',
    covers: 'the 3% bracket, twice, plus a smaller basket in the 2% bracket',
    transactions: [
      { invoiceId: 'INV-9802', amountGross: 120_000, daysAgo: 15, captureMode: 'SPOOL_WATCH', attributed: true, redeem: true },
      { invoiceId: 'INV-9809', amountGross: 95_500, daysAgo: 8, captureMode: 'VIRTUAL_PRINTER', attributed: true, redeem: true },
      { invoiceId: 'INV-9818', amountGross: 61_000, daysAgo: 2, captureMode: 'SPOOL_WATCH', attributed: true },
    ],
  },
  {
    name: 'مصطفى الكاظمي',
    phone: '07901112233',
    category: 'WHOLESALE',
    card: 'PRE_PRINTED',
    covers:
      'THE CAP BITING (185,000 → 3% = 5,550 → 5,000), and the top bracket outside the default range',
    transactions: [
      // 3% of 185,000 is 5,550 against a 5,000 ceiling. This is the ONE fixture that
      // makes §12.37's panel show a non-zero «ما وفّره الحد الأقصى».
      { invoiceId: 'INV-9803', amountGross: 185_000, daysAgo: 5, captureMode: 'MANUAL', attributed: true },
      // Both top-bracket invoices sit outside 30d on purpose — see the header note.
      { invoiceId: 'INV-9811', amountGross: 480_000, daysAgo: 45, captureMode: 'SPOOL_WATCH', attributed: true, redeem: true },
      { invoiceId: 'INV-9824', amountGross: 315_500, daysAgo: 52, captureMode: 'SERIAL_BRIDGE', attributed: true },
    ],
  },
  {
    name: 'نور الهدى حسن',
    phone: '07512345678',
    category: 'REGULAR',
    card: 'REPLACED',
    covers: 'short of the first bracket by 700 — the sharpest case for the bracket message',
    transactions: [
      { invoiceId: 'INV-9804', amountGross: 24_300, daysAgo: 9, captureMode: 'SPOOL_WATCH', attributed: true },
    ],
  },
  {
    name: 'علي فاضل الربيعي',
    phone: '07709876543',
    category: 'REGULAR',
    card: 'THERMAL',
    covers: 'an invoice EXACTLY at a bracket — proves the boundary is inclusive',
    transactions: [
      { invoiceId: 'INV-9805', amountGross: 25_000, daysAgo: 11, captureMode: 'SPOOL_WATCH', attributed: true, redeem: true },
      { invoiceId: 'INV-9812', amountGross: 33_750, daysAgo: 4, captureMode: 'SPOOL_WATCH', attributed: true },
    ],
  },
  {
    name: 'رقية جاسم',
    phone: '07803334455',
    category: 'REGULAR',
    card: 'THERMAL',
    covers: 'registered but never scanned — the empty state on customer detail',
    transactions: [],
  },
  {
    name: 'أحمد عبد الأمير',
    phone: '07705556677',
    category: 'VIP',
    card: 'THERMAL',
    covers: 'one invoice inside the default range and one outside it — the range boundary',
    transactions: [
      { invoiceId: 'INV-9806', amountGross: 88_000, daysAgo: 45, captureMode: 'SPOOL_WATCH', attributed: true },
      { invoiceId: 'INV-9816', amountGross: 26_300, daysAgo: 3, captureMode: 'SPOOL_WATCH', attributed: true },
    ],
  },
  {
    name: 'سجاد الطائي',
    phone: '07701239988',
    category: 'REGULAR',
    card: 'LOST_NO_REPLACEMENT',
    covers: 'holds NO card — cardNumber null, which no other fixture produces',
    transactions: [
      { invoiceId: 'INV-9825', amountGross: 31_000, daysAgo: 10, captureMode: 'SPOOL_WATCH', attributed: true },
    ],
  },
];

/**
 * Invoices captured with no card scanned. These are the majority of real traffic —
 * most shoppers are not enrolled — and the gap between captured and attributed is
 * the enrolment rate, a headline metric rather than an error.
 *
 * The capture modes here and above deliberately span four of the five, so the capture
 * chart has enough series to exercise §12.33's validated palette rather than one bar.
 */
const UNATTRIBUTED: SeedTransaction[] = [
  { invoiceId: 'INV-9820', amountGross: 15_750, daysAgo: 1, captureMode: 'SPOOL_WATCH', attributed: false },
  { invoiceId: 'INV-9821', amountGross: 42_000, daysAgo: 1, captureMode: 'NETWORK_PROXY', attributed: false },
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
    { username: 'agent', name: 'وكيل الالتقاط — الصندوق 1', role: 'AGENT', branchId: branch.id },
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
  const ownerUser = await db.user.findUniqueOrThrow({
    where: { merchantId_username: { merchantId: merchant.id, username: 'owner' } },
  });
  const agentUser = await db.user.findUniqueOrThrow({
    where: { merchantId_username: { merchantId: merchant.id, username: 'agent' } },
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

  // ── Customers, cards and the real core loop ────────────────────────────────
  let remintedCards = 0;

  /* ── Pre-printed card stock (§12.25) ─────────────────────────────────────── */

  // Generated through the SERVICE, never by writing card rows — the serials, the
  // check digits and the batch arithmetic are then the real ones (§12.38).
  //
  // Two batches, because §12.32 requires every tally to be drawn *even at zero*: the
  // first ends up with all five statuses non-zero, the second stays entirely PRINTED
  // so four of its tallies render as a plain nought. One batch could not show both.
  const existingBatches = await db.cardBatch.count({ where: { merchantId: merchant.id } });
  if (existingBatches === 0) {
    await generateCardBatch(
      { merchantId: merchant.id, actorUserId: ownerUser.id },
      { quantity: 10, note: 'الدفعة الأولى — بطاقات PVC' },
    );
    await generateCardBatch(
      { merchantId: merchant.id, actorUserId: ownerUser.id },
      { quantity: 5, note: 'دفعة احتياطية — لم تُطبع بعد' },
    );
  }

  /** Blank pre-printed cards, oldest serial first — the drawer the operator reaches into. */
  const takeBlankCard = async (): Promise<string> => {
    const blank = await db.card.findFirst({
      where: { merchantId: merchant.id, status: 'PRINTED' },
      orderBy: { serial: 'asc' },
    });
    if (!blank) throw new Error('نفدت البطاقات الجاهزة في بيانات البذرة');
    return blank.cardNumber;
  };

  /* ── Customers, their cards, and their invoices ──────────────────────────── */

  let attributedCount = 0;
  let vouchersIssued = 0;
  let vouchersRedeemed = 0;
  let cappedInvoices = 0;

  const ingestionContext = {
    merchantId: merchant.id,
    userId: agentUser.id,
    userBranchId: branch.id,
  };
  const scanContext = {
    merchantId: merchant.id,
    userId: stationUser.id,
    branchId: branch.id,
    stationId: 'station-01',
  };

  /**
   * Replays the REAL core loop for one seeded invoice: the agent's capture, then the
   * station's scan (§10.3).
   *
   * **The seed used to write `discountType: NONE, discountValue: 0` on every row and
   * create no vouchers**, on the reasoning that inventing a calculation would let an
   * engine bug hide behind fixtures that looked correct. The instinct was right; the
   * zeros did not achieve it. They produced a database where the engine was never
   * exercised at all — so nothing could hide behind the fixtures and nothing could be
   * verified against them either, and every screen that reports on discounting
   * rendered empty.
   *
   * Running the engine achieves what the zeros were reaching for: a bug in
   * `computeDiscount`, in the settlement strategy or in the voucher write changes what
   * this seed produces, loudly, instead of being papered over by a hardcoded number.
   *
   * The voucher is not optional. A discount without one is a customer paying less than
   * the POS recorded with nothing in the books to explain it (§0 rule 3), so they are
   * written together by `scanCard` or neither is.
   */
  const replayInvoice = async (tx: SeedTransaction, cardNumber: string | null): Promise<void> => {
    const occurredAt = daysBefore(tx.daysAgo);

    await ingestInvoice(ingestionContext, {
      invoice_id: tx.invoiceId,
      amount_gross: tx.amountGross,
      currency: 'IQD',
      branch_id: 'BAG-01',
      occurred_at: occurredAt.toISOString(),
      captured_at: occurredAt.toISOString(),
      capture_mode: tx.captureMode,
    });

    if (!tx.attributed || !cardNumber) return;

    const outcome = await scanCard(scanContext, {
      barcodeToken: cardNumber,
      invoiceId: tx.invoiceId,
      stationId: 'station-01',
    });

    attributedCount += 1;

    // **Timestamps only.** `scanCard` stamps the clock, which would file every seeded
    // voucher as issued today and make end-of-day reconciliation report the whole
    // history as a single day's trading. Correcting the two timestamps is a fixture
    // concern; every *business* value on these rows — the bracket, the discount, the
    // cap, the voucher code, the settlement wording — came from the services above and
    // is never touched here.
    await db.transaction.updateMany({
      where: { merchantId: merchant.id, branchId: branch.id, invoiceId: tx.invoiceId },
      data: { linkedAt: occurredAt },
    });

    if (outcome.voucher) {
      vouchersIssued += 1;
      await db.voucher.update({
        where: { id: outcome.voucher.id },
        data: { issuedAt: occurredAt },
      });

      if (tx.redeem) {
        await redeemVoucher({
          merchantId: merchant.id,
          voucherId: outcome.voucher.id,
          actorUserId: stationUser.id,
        });
        await db.voucher.update({
          where: { id: outcome.voucher.id },
          data: { redeemedAt: occurredAt },
        });
        vouchersRedeemed += 1;
      }
    }

    if (outcome.transaction && outcome.transaction.discountValue > 0) {
      const row = await db.transaction.findFirst({
        where: { merchantId: merchant.id, branchId: branch.id, invoiceId: tx.invoiceId },
        select: { discountValue: true, discountUncappedValue: true },
      });
      if (row && row.discountUncappedValue > row.discountValue) cappedInvoices += 1;
    }
  };

  for (const fixture of CUSTOMERS) {
    const phone = toE164(fixture.phone);

    let customer = await db.customer.findUnique({
      where: { merchantId_phone: { merchantId: merchant.id, phone } },
    });
    const isNewCustomer = customer === null;

    if (!customer) {
      // Through the service, so the card assignment, the check digit and the audit row
      // are the real ones. A pre-printed fixture is handed a blank exactly as an
      // operator would hand one over at the counter; a THERMAL fixture is given none
      // and `createCustomer` mints one, which is the §6.3 fallback path.
      const blank = fixture.card === 'THERMAL' ? undefined : await takeBlankCard();
      const created = await createCustomer(
        { merchantId: merchant.id, actorUserId: stationUser.id },
        {
          name: fixture.name,
          phone: fixture.phone,
          category: fixture.category,
          ...(blank ? { cardNumber: blank } : {}),
        },
      );
      customer = await db.customer.findUniqueOrThrow({ where: { id: created.id } });
    }

    const activeCard = await db.card.findFirst({
      where: { merchantId: merchant.id, customerId: customer.id, status: 'ASSIGNED' },
    });

    // A developer's database outlives a change to the signing scheme, and a seeded
    // card the station cannot verify looks like a bug in the station rather than a
    // stale fixture.
    //
    // **THERMAL only, and the restriction is load-bearing.** `verifyBarcodeToken`
    // understands the `card.v1` shape alone — 10-digit payload, 6-digit signature. A
    // pre-printed `card.v2` number is 6 digits of serial and 10 of check code, so it
    // fails this check every time even when it is perfectly valid; the station
    // verifies it through `lookupCard`, which tries both schemes (§12.25).
    //
    // Without this guard the seed re-minted every pre-printed card with a v1 number
    // while leaving `scheme: 'card.v2'` and `serial` untouched — so the serial printed
    // on the physical card no longer matched its own barcode, which is the exact
    // support path the v2 scheme exists to provide. Found by asking why the seed
    // reported three re-minted cards on a database it had just created.
    //
    // A pre-printed card that genuinely fails verification is not a fixture problem
    // and must not be papered over here: it means `QR_TOKEN_SECRET` changed, which
    // §12.25 says also invalidates blank stock sitting in the merchant's drawer.
    if (
      activeCard &&
      activeCard.origin === 'THERMAL' &&
      !verifyBarcodeToken(activeCard.cardNumber, env.QR_TOKEN_SECRET)
    ) {
      await db.card.update({
        where: { id: activeCard.id },
        data: { cardNumber: generateBarcodeToken(env.QR_TOKEN_SECRET) },
      });
      remintedCards += 1;
    }

    const scanNumber = activeCard
      ? ((await db.card.findUniqueOrThrow({ where: { id: activeCard.id } })).cardNumber)
      : null;

    for (const tx of fixture.transactions) {
      await replayInvoice(tx, scanNumber);
    }

    // ── Card lifecycle, applied AFTER the invoices ──────────────────────────
    //
    // **The order is the fixture.** These two customers shopped and *then* lost the
    // card, which is the only order that happens in a shop. Running the lifecycle
    // first — as this loop originally did — left `سجاد الطائي` with no card to scan,
    // so his invoice was captured and never attributed and he rendered as a customer
    // with no history at all. That duplicated the empty-state fixture and quietly
    // deleted the state he exists for: **history, and no card to reprint it onto**.
    //
    // Caught by reading his row on the customers screen — 0 د.ع against a fixture
    // whose note says otherwise. A count that does not match the situation.
    //
    // Both paths go through the card service, so the state guards, the partial unique
    // index and the audit trail are exercised rather than sidestepped — and a card in
    // a state the station must refuse actually exists for §12.30's messages.
    if (isNewCustomer && (fixture.card === 'LOST_NO_REPLACEMENT' || fixture.card === 'REPLACED')) {
      const live = await db.card.findFirstOrThrow({
        where: { merchantId: merchant.id, customerId: customer.id, status: 'ASSIGNED' },
      });
      await reportCardLost(
        { merchantId: merchant.id, actorUserId: stationUser.id },
        live.id,
        'بيانات تطوير — بلاغ فقدان',
      );
      if (fixture.card === 'REPLACED') {
        await replaceCard(
          { merchantId: merchant.id, actorUserId: stationUser.id },
          live.id,
          await takeBlankCard(),
          'بيانات تطوير — بطاقة بديلة',
        );
      }
    }
  }

  // One misprint, so batch A carries a VOID tally alongside the other four.
  const voidable = await db.card.findFirst({
    where: { merchantId: merchant.id, status: 'PRINTED' },
    orderBy: { serial: 'desc' },
  });
  if (voidable) {
    await voidCard(
      { merchantId: merchant.id, actorUserId: ownerUser.id },
      voidable.id,
      'بيانات تطوير — بطاقة تالفة عند الطباعة',
    );
  }

  for (const tx of UNATTRIBUTED) {
    await replayInvoice(tx, null);
  }

  // eslint-disable-next-line no-console -- a seed script reports to the operator by design
  console.log(
    [
      '',
      '  ✔ اكتمل إدخال بيانات التطوير (v4 — خصم حسب قيمة الفاتورة)',
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
      `    قسائم صادرة     ${vouchersIssued}  (مستردة ${vouchersRedeemed})  ← من المحرّك الحقيقي (§10.3)`,
      `    فواتير طُبّق عليها الحد الأقصى ${cappedInvoices}   ← يجب أن يكون 1 (§12.37)`,
      `    شرائح الفاتورة  ${DISCOUNT_RULES.map((r) => r.discountType === 'PERCENTAGE' ? `${r.thresholdAmount / 1000}k→${r.discountRate}٪` : `${r.thresholdAmount / 1000}k→${r.discountRate} د.ع`).join(' · ')}`,
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
