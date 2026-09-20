import { hashPassword } from '../lib/password';
import { prisma } from '../lib/prisma';
import { createCustomer } from './customer.service';
import { ingestInvoice } from './ingestion.service';
import { scanCard } from './scan.service';
import { redeemVoucher } from './voucher.service';
import { generateCardBatch } from './card.service';
import { buildDemoCustomers, buildDemoInvoices, DEMO, makeRng } from '../lib/demo-data';
import { DEMO_PASSWORD } from '../lib/demo-credentials';

/**
 * Building the demo shop.
 *
 * ── Why this is a SERVICE and not only a seed script ─────────────────────────
 *
 * The demo is meant to be clicked around: the merchant can retire a discount level,
 * redeem a voucher, void a card batch, edit a customer. All of that is the point, and
 * all of it is destructive. So «إعادة تعيين البيانات التجريبية» has to exist, and it
 * has to run on his laptop where there is no `tsx`, no `prisma` CLI and no seed script
 * — only the bundled API. Putting the generator here means the build-time seed and the
 * in-app reset are the same code producing the same shop, rather than two things that
 * agree until one of them is edited.
 *
 * ── It is gated twice ────────────────────────────────────────────────────────
 *
 *  1. `isDemoBuild()` — the API only registers the reset route when `LOYALTY_DEMO=1`,
 *     which the demo launcher sets and a production install never does.
 *  2. `assertDemoDatabase()` — this refuses to wipe anything unless the database file
 *     it is connected to has `demo` in its name.
 *
 * Either alone would be enough on a good day. Together they mean that turning a real
 * installation into a demo takes two independent mistakes, and that the destructive
 * half cannot run at all against a file called `loyalty-pro.db`.
 */

/**
 * The demo login, re-exported so existing callers keep working.
 *
 * Defined in `lib/demo-credentials` because the build gate and the readme generator
 * both need it, and neither should import the seed generator to read a string.
 */
export { DEMO_PASSWORD } from '../lib/demo-credentials';

const MERCHANT_ID = '00000000-0000-4000-8000-000000000001';
const TIMEZONE = 'Asia/Baghdad';

/**
 * A fixed seed, so the shop is the same shop after every reset.
 *
 * A demo that reshuffles itself is a demo the merchant cannot learn: he shows his
 * brother-in-law "look at this customer" and the customer is gone.
 */
const RNG_SEED = 20260905;

export { isDemoBuild } from '../lib/demo-guard';

/**
 * The second gate, and the one that actually protects data.
 *
 * Read from the live connection rather than from `process.env`, because the env var is
 * what a mistake would get wrong. `PRAGMA database_list` reports the file SQLite has
 * open; if that is not a demo file, nothing below runs.
 */
export async function assertDemoDatabase(): Promise<void> {
  const rows = await prisma.$queryRawUnsafe<Array<{ file: string | null }>>(
    'PRAGMA database_list',
  );
  const file = rows.find((r) => r.file)?.file ?? '';
  if (!/demo/i.test(file)) {
    throw new Error(
      `refusing to rebuild demo data: the open database is "${file}", which is not a demo file`,
    );
  }
}

export interface DemoBuildResult {
  customers: number;
  invoices: number;
  attributed: number;
  vouchersIssued: number;
  vouchersRedeemed: number;
  seconds: number;
}

const daysBefore = (days: number): Date => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  // Trading hours rather than midnight: every invoice landing at 00:00 makes the
  // merchant-local day bucketing (§13.1) untestable and reads as synthetic in the list.
  d.setHours(9 + Math.floor(((days * 7919) % 600) / 60), (days * 37) % 60, 0, 0);
  return d;
};

/** Children first. `deleteMany` rather than dropping the file — the schema survives. */
async function wipe(): Promise<void> {
  await prisma.voucher.deleteMany({});
  await prisma.transaction.deleteMany({});
  await prisma.card.deleteMany({});
  await prisma.cardBatch.deleteMany({});
  await prisma.notificationLog.deleteMany({});
  await prisma.auditLog.deleteMany({});
  await prisma.customer.deleteMany({});
}

export async function buildDemoShop(
  log: (line: string) => void = () => {},
): Promise<DemoBuildResult> {
  await assertDemoDatabase();
  const started = Date.now();
  await wipe();

  const merchant = await prisma.merchant.upsert({
    where: { id: MERCHANT_ID },
    update: { name: DEMO.merchantName, timezone: TIMEZONE },
    create: { id: MERCHANT_ID, name: DEMO.merchantName, timezone: TIMEZONE, currency: 'IQD' },
  });

  const branch = await prisma.branch.upsert({
    where: { merchantId_code: { merchantId: merchant.id, code: 'BAG-01' } },
    update: { name: 'فرع الكرادة' },
    create: { merchantId: merchant.id, name: 'فرع الكرادة', code: 'BAG-01' },
  });

  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const staff = [
    { username: 'owner', name: 'مصطفى الجبوري', role: 'OWNER', branchId: null as string | null },
    { username: 'manager', name: 'سارة العبيدي', role: 'MANAGER', branchId: branch.id },
    { username: 'station', name: 'محطة الولاء — الكرادة', role: 'STATION', branchId: branch.id },
    { username: 'agent', name: 'وكيل الالتقاط — الصندوق 1', role: 'AGENT', branchId: branch.id },
  ];
  for (const s of staff) {
    await prisma.user.upsert({
      where: { merchantId_username: { merchantId: merchant.id, username: s.username } },
      update: { name: s.name, role: s.role, branchId: s.branchId, passwordHash, isActive: true },
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

  const owner = await prisma.user.findUniqueOrThrow({
    where: { merchantId_username: { merchantId: merchant.id, username: 'owner' } },
  });
  const station = await prisma.user.findUniqueOrThrow({
    where: { merchantId_username: { merchantId: merchant.id, username: 'station' } },
  });
  const agent = await prisma.user.findUniqueOrThrow({
    where: { merchantId_username: { merchantId: merchant.id, username: 'agent' } },
  });

  /*
    The product's real default ladder, restored on every reset.

    Restored rather than merely created: the whole reason this exists is that the
    merchant may have edited it, so `update` has to put it back. This is the one place
    the demo overwrites a merchant's configuration, and it is what «إعادة تعيين» means.
  */
  await prisma.discountSettings.upsert({
    where: { merchantId: merchant.id },
    update: {
      discountType: 'PERCENTAGE',
      minRate: 1,
      maxRate: 3,
      absoluteMaxDiscountValue: 5_000,
      settlementStrategy: 'MERCHANT_DEFINED',
    },
    create: {
      merchantId: merchant.id,
      discountType: 'PERCENTAGE',
      minRate: 1,
      maxRate: 3,
      absoluteMaxDiscountValue: 5_000,
      settlementStrategy: 'MERCHANT_DEFINED',
    },
  });

  await prisma.discountRule.deleteMany({ where: { merchantId: merchant.id } });
  const ladder = [
    { thresholdAmount: 25_000, discountType: 'PERCENTAGE', discountRate: 2, maxDiscountValue: null, sortOrder: 1 },
    { thresholdAmount: 75_000, discountType: 'PERCENTAGE', discountRate: 3, maxDiscountValue: null, sortOrder: 2 },
    { thresholdAmount: 200_000, discountType: 'FIXED_AMOUNT', discountRate: 5_000, maxDiscountValue: null, sortOrder: 3 },
  ];
  for (const rule of ladder) {
    await prisma.discountRule.create({
      data: { merchantId: merchant.id, ...rule, isActive: true },
    });
  }

  const rng = makeRng(RNG_SEED);
  const people = buildDemoCustomers(rng);
  const invoices = buildDemoInvoices(rng, people);
  log(`${people.length} customers · ${invoices.length} invoices · ${DEMO.days} days`);

  const preprinted = people.filter((p) => p.card === 'PRE_PRINTED').length;
  await generateCardBatch(
    { merchantId: merchant.id, actorUserId: owner.id },
    { quantity: preprinted + 10, note: 'الدفعة الأولى — بطاقات PVC' },
  );
  await generateCardBatch(
    { merchantId: merchant.id, actorUserId: owner.id },
    { quantity: 50, note: 'دفعة احتياطية — لم تُسلَّم بعد' },
  );

  const takeBlank = async (): Promise<string> => {
    const blank = await prisma.card.findFirst({
      where: { merchantId: merchant.id, status: 'PRINTED' },
      orderBy: { serial: 'asc' },
    });
    if (!blank) throw new Error('نفدت البطاقات الجاهزة');
    return blank.cardNumber;
  };

  const cardOf = new Map<number, string>();
  for (const [index, person] of people.entries()) {
    const created = await createCustomer(
      { merchantId: merchant.id, actorUserId: station.id },
      {
        name: person.name,
        phone: person.phone,
        category: person.category,
        ...(person.card === 'PRE_PRINTED' ? { cardNumber: await takeBlank() } : {}),
      },
    );
    // Backdated so the base looks like one that grew, not 96 people who joined today.
    await prisma.customer.update({
      where: { id: created.id },
      data: { createdAt: daysBefore(person.joinedDaysAgo) },
    });
    if (created.cardNumber) cardOf.set(index, created.cardNumber);
  }

  const ingestCtx = { merchantId: merchant.id, userId: agent.id, userBranchId: branch.id };
  const scanCtx = {
    merchantId: merchant.id,
    userId: station.id,
    branchId: branch.id,
    stationId: 'station-01',
  };

  let attributed = 0;
  let vouchersIssued = 0;
  let vouchersRedeemed = 0;

  for (const [n, inv] of invoices.entries()) {
    const at = daysBefore(inv.daysAgo);

    await ingestInvoice(ingestCtx, {
      invoice_id: inv.invoiceId,
      amount_gross: inv.amountGross,
      currency: 'IQD',
      branch_id: 'BAG-01',
      occurred_at: at.toISOString(),
      captured_at: at.toISOString(),
      capture_mode: inv.captureMode,
    });

    const cardNumber = inv.customer === null ? undefined : cardOf.get(inv.customer);
    if (cardNumber) {
      const outcome = await scanCard(scanCtx, {
        barcodeToken: cardNumber,
        invoiceId: inv.invoiceId,
        stationId: 'station-01',
      });
      attributed += 1;

      // Timestamps only. Every business value on the row came from the services above.
      await prisma.transaction.updateMany({
        where: { merchantId: merchant.id, branchId: branch.id, invoiceId: inv.invoiceId },
        data: { linkedAt: at },
      });

      if (outcome.voucher) {
        vouchersIssued += 1;
        await prisma.voucher.update({ where: { id: outcome.voucher.id }, data: { issuedAt: at } });
        if (inv.redeem) {
          await redeemVoucher({
            merchantId: merchant.id,
            voucherId: outcome.voucher.id,
            actorUserId: station.id,
          });
          await prisma.voucher.update({
            where: { id: outcome.voucher.id },
            data: { redeemedAt: at },
          });
          vouchersRedeemed += 1;
        }
      }
    }

    if ((n + 1) % 500 === 0) log(`… ${n + 1}/${invoices.length}`);
  }

  return {
    customers: people.length,
    invoices: invoices.length,
    attributed,
    vouchersIssued,
    vouchersRedeemed,
    seconds: Math.round((Date.now() - started) / 1000),
  };
}
