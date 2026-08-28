/**
 * V3-1 verification probe.
 *
 * Reads back what the migration and seed produced and asserts the invariants the
 * data layer is responsible for. Exits non-zero on any failure, so it is usable
 * in CI as well as by hand.
 *
 * The invariant it exists for above all others: **cumulative balance is computed
 * from transactions, never stored** (CLAUDE_v3.md §5.3). There is no snapshot
 * table any more, so this proves the derivation returns the right number rather
 * than proving a cache agrees with its source.
 */

import { PrismaClient } from '@prisma/client';
import { computeDiscount, computePeriodKey, formatIqd, formatPhoneLocal } from '@walaa/shared-types';
import { loadEnv } from '../src/config/env';
import { applySqlitePragmas } from '../src/lib/prisma';

loadEnv();

const prisma = new PrismaClient();

/* eslint-disable no-console -- this script's entire purpose is operator output */

let failures = 0;

function check(label: string, passed: boolean, detail = ''): void {
  console.log(`  ${passed ? '✔' : '✘'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!passed) failures += 1;
}

interface TableRow {
  name: string;
}

async function main(): Promise<void> {
  await applySqlitePragmas(prisma);
  console.log('\n── بيانات مُدخلة ─────────────────────────────────────────────\n');

  const merchant = await prisma.merchant.findFirst({
    include: { branches: { orderBy: { code: 'asc' } }, users: { orderBy: { username: 'asc' } } },
  });
  if (!merchant) throw new Error('لا يوجد تاجر — شغّل `pnpm db:seed` أولاً');

  console.log(`  التاجر    ${merchant.name}  ·  ${merchant.timezone}  ·  ${merchant.currency}`);
  console.log(`  الفروع    ${merchant.branches.map((b) => `${b.code} (${b.name})`).join('  ·  ')}`);
  console.log(`  الطاقم    ${merchant.users.map((u) => `${u.username}:${u.role}`).join('  ·  ')}`);

  const settings = await prisma.discountSettings.findUnique({ where: { merchantId: merchant.id } });
  if (!settings) throw new Error('لا توجد إعدادات خصم');

  const rules = await prisma.discountRule.findMany({
    where: { merchantId: merchant.id, isActive: true },
    orderBy: { thresholdAmount: 'asc' },
  });

  console.log(
    `\n  قواعد الخصم (${settings.periodType})  ` +
      rules
        .map((r) =>
          r.discountType === 'PERCENTAGE'
            ? `${formatIqd(r.thresholdAmount)} → ${r.discountRate}٪`
            : `${formatIqd(r.thresholdAmount)} → ${formatIqd(r.discountRate)}`,
        )
        .join('   ·   '),
  );
  console.log(`  الحد الأقصى المطلق للخصم  ${formatIqd(settings.absoluteMaxDiscountValue)}`);
  console.log(`  استراتيجية التسوية        ${settings.settlementStrategy}`);

  const currentPeriod = computePeriodKey({
    periodType: settings.periodType as 'WEEKLY' | 'MONTHLY' | 'CUSTOM',
    occurredAt: new Date(),
    timeZone: merchant.timezone,
    customStart: settings.periodStart,
    customEnd: settings.periodEnd,
  });
  console.log(`  الفترة الحالية            ${currentPeriod}\n`);

  /* ── Derived balances ─────────────────────────────────────────────────────── */

  console.log('── أرصدة الزبائن (محسوبة من العمليات — لا تُخزَّن) ──────────────\n');
  console.log('  الزبون                الهاتف           الفئة       الرصيد التراكمي   الفواتير');

  const customers = await prisma.customer.findMany({
    where: { merchantId: merchant.id },
    orderBy: { createdAt: 'asc' },
  });

  for (const c of customers) {
    // §5.3: computed on demand from the log. There is no stored total to read.
    const totals = await prisma.transaction.aggregate({
      where: { customerId: c.id, periodKey: currentPeriod },
      _sum: { amountGross: true },
      _count: true,
    });
    const cumulative = totals._sum.amountGross ?? 0;

    console.log(
      `  ${c.name.padEnd(20)}  ${formatPhoneLocal(c.phone).padEnd(15)}  ` +
        `${c.category.padEnd(10)}  ${(cumulative ? formatIqd(cumulative) : '—').padStart(15)}   ${String(totals._count).padStart(3)}`,
    );
  }

  /* ── Invariant checks ─────────────────────────────────────────────────────── */

  console.log('\n── تحقق من القيود ────────────────────────────────────────────\n');

  // 1. No stored-balance table may exist. This is the check that would catch a
  //    future reintroduction of a cache — the failure mode §5.3 exists to prevent.
  const tables = await prisma.$queryRaw<TableRow[]>`
    SELECT name FROM sqlite_master WHERE type = 'table'
  `;
  const tableNames = tables.map((t) => t.name);
  check(
    'لا يوجد جدول لتخزين الرصيد التراكمي (§5.3)',
    !tableNames.includes('balance_snapshot'),
    `[${tableNames.length} جدول]`,
  );

  // 2. The coupon engine is gone.
  check('جداول الكوبونات محذوفة', !tableNames.includes('coupon'));

  // 3. The v3 tables exist.
  for (const expected of ['discount_rule', 'discount_settings', 'voucher', 'feature_flag']) {
    check(`جدول ${expected} موجود`, tableNames.includes(expected));
  }

  // 4. The derived balance must equal a hand-summed total.
  const sample = customers.find((c) => c.name === 'زينب عبد الرزاق');
  if (sample) {
    const rows = await prisma.transaction.findMany({
      where: { customerId: sample.id, periodKey: currentPeriod },
      select: { amountGross: true },
    });
    const byHand = rows.reduce((sum, r) => sum + r.amountGross, 0);
    const aggregated = await prisma.transaction.aggregate({
      where: { customerId: sample.id, periodKey: currentPeriod },
      _sum: { amountGross: true },
    });
    check(
      'الرصيد المحسوب يطابق الجمع اليدوي للعمليات',
      byHand === (aggregated._sum.amountGross ?? 0),
      `[${formatIqd(byHand)}]`,
    );
  }

  // 5. The idempotency guard must exist as a real UNIQUE index.
  const indexes = await prisma.$queryRaw<Array<{ name: string; sql: string | null }>>`
    SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'transaction'
  `;
  const guard = indexes.find(
    (i) =>
      i.sql &&
      i.sql.includes('merchant_id') &&
      i.sql.includes('branch_id') &&
      i.sql.includes('invoice_id') &&
      i.sql.toUpperCase().includes('UNIQUE'),
  );
  check('قيد الفريدة (merchant_id, branch_id, invoice_id) موجود', Boolean(guard), guard ? `[${guard.name}]` : '');

  // 6. And it must actually refuse a duplicate. A constraint nobody tested is a hope.
  const existing = await prisma.transaction.findFirst({ where: { merchantId: merchant.id } });
  if (!existing) throw new Error('لا توجد عمليات لاختبار التكرار');

  let duplicateRejected = false;
  try {
    await prisma.transaction.create({
      data: {
        merchantId: existing.merchantId,
        branchId: existing.branchId,
        customerId: existing.customerId,
        invoiceId: existing.invoiceId, // same invoice, same branch — must be refused
        amountGross: 1_000,
        amountNet: 1_000,
        currency: 'IQD',
        captureMode: 'SPOOL_WATCH',
        periodKey: existing.periodKey,
        occurredAt: new Date(),
        capturedAt: new Date(),
      },
    });
  } catch {
    duplicateRejected = true;
  }
  check(`قاعدة البيانات ترفض التقاط نفس الفاتورة مرتين (${existing.invoiceId})`, duplicateRejected);

  // 7. Unattributed captures are a normal state, not an error (§4).
  const unattributed = await prisma.transaction.count({
    where: { merchantId: merchant.id, customerId: null },
  });
  check('توجد فواتير ملتقطة غير مرتبطة بزبون (حالة طبيعية)', unattributed > 0, `[${unattributed}]`);

  // 8. No barcode token may contain the customer's phone number.
  const leaking = customers.filter((c) => {
    const national = c.phone.replace('+964', '');
    return c.barcodeToken.includes(national) || c.barcodeToken.includes(c.phone);
  });
  check('لا يحتوي أي رمز بطاقة على رقم هاتف الزبون', leaking.length === 0);

  // 9. WAL mode must be on — the concurrency decision in §12.5 depends on it.
  const journal = await prisma.$queryRaw<Array<{ journal_mode: string }>>`PRAGMA journal_mode`;
  check(
    'وضع WAL مفعّل (قرّاء متزامنون + كاتب واحد)',
    journal[0]?.journal_mode?.toLowerCase() === 'wal',
    `[${journal[0]?.journal_mode ?? 'unknown'}]`,
  );

  // 10. The discount engine's cap must hold against a deliberately large basket.
  const activeRules = rules.map((r) => ({
    thresholdAmount: r.thresholdAmount,
    discountType: r.discountType as 'PERCENTAGE' | 'FIXED_AMOUNT',
    discountRate: r.discountRate,
    maxDiscountValue: r.maxDiscountValue,
    isActive: r.isActive,
  }));
  const huge = computeDiscount({
    amountGross: 5_000_000,
    cumulativeAmount: 5_000_000,
    rules: activeRules,
    absoluteMaxDiscountValue: settings.absoluteMaxDiscountValue,
    discountTypeSetting: settings.discountType as 'PERCENTAGE' | 'FIXED_AMOUNT' | 'NONE',
  });
  check(
    'الحد الأقصى المطلق يقيّد فاتورة ضخمة (§2.3)',
    huge.discountValue <= settings.absoluteMaxDiscountValue,
    `[5,000,000 د.ع → خصم ${formatIqd(huge.discountValue)}]`,
  );

  console.log('');
  if (failures > 0) {
    console.error(`✘ فشل ${failures} تحقق\n`);
    process.exitCode = 1;
  } else {
    console.log('✔ اجتازت جميع عمليات التحقق\n');
  }
}

main()
  .catch((error: unknown) => {
    console.error('فشل التحقق:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
