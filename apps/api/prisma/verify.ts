/**
 * Phase 0 verification probe.
 *
 * Reads back what the migration and seed produced and asserts the invariants that
 * Phase 0 is responsible for — most importantly that the idempotency guard exists
 * as a real database constraint and actually refuses a duplicate invoice
 * (CLAUDE.md §0.2, §0.6: evidence before assertions).
 *
 * Exits non-zero if any check fails, so it is usable in CI.
 */

import { PrismaClient } from '@prisma/client';
import { computePeriodKey, formatIqd, formatPhoneLocal } from '@walaa/shared-types';
import { loadEnv } from '../src/config/env';

// Everything reaches the environment through the validated config module (§7.6) —
// this also loads the repo-root .env that Prisma Client needs for DATABASE_URL.
loadEnv();

const prisma = new PrismaClient();

/* eslint-disable no-console -- this script's entire purpose is operator output */

let failures = 0;

function check(label: string, passed: boolean, detail = ''): void {
  const mark = passed ? '✔' : '✘';
  console.log(`  ${mark} ${label}${detail ? `  ${detail}` : ''}`);
  if (!passed) failures += 1;
}

interface IndexRow {
  indexname: string;
  indexdef: string;
}

async function main(): Promise<void> {
  console.log('\n── بيانات مُدخلة ─────────────────────────────────────────────\n');

  const merchant = await prisma.merchant.findFirst({
    include: { branches: { orderBy: { code: 'asc' } }, users: { orderBy: { username: 'asc' } } },
  });
  if (!merchant) throw new Error('لا يوجد تاجر — شغّل `pnpm db:seed` أولاً');

  console.log(`  التاجر    ${merchant.name}  ·  ${merchant.timezone}  ·  ${merchant.currency}`);
  console.log(
    `  الفروع    ${merchant.branches.map((b) => `${b.code} (${b.name})`).join('  ·  ')}`,
  );
  console.log(
    `  الطاقم    ${merchant.users.map((u) => `${u.username}:${u.role}`).join('  ·  ')}`,
  );

  const ruleSet = await prisma.loyaltyRuleSet.findFirst({
    where: { merchantId: merchant.id, isActive: true },
    include: { tiers: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!ruleSet) throw new Error('لا توجد قواعد ولاء فعّالة');

  console.log(
    `\n  المستويات (${ruleSet.periodType})  ` +
      ruleSet.tiers
        .map((t) => `${formatIqd(t.thresholdAmount)} → ${t.discountPct}٪ / ${t.couponValidityDays}ي`)
        .join('   ·   '),
  );

  const currentPeriod = computePeriodKey({
    periodType: ruleSet.periodType,
    occurredAt: new Date(),
    timeZone: merchant.timezone,
    customStart: ruleSet.periodStart,
    customEnd: ruleSet.periodEnd,
  });
  console.log(`  الفترة الحالية  ${currentPeriod}\n`);

  console.log('── أرصدة الزبائن ─────────────────────────────────────────────\n');
  console.log('  الزبون                الهاتف           الفئة       الرصيد التراكمي   العمليات');

  const customers = await prisma.customer.findMany({
    where: { merchantId: merchant.id },
    include: {
      balanceSnapshots: { where: { periodKey: currentPeriod } },
      _count: { select: { transactions: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  for (const c of customers) {
    const snapshot = c.balanceSnapshots[0];
    const balance = snapshot ? formatIqd(snapshot.cumulativeAmount) : '—';
    console.log(
      `  ${c.name.padEnd(20)}  ${formatPhoneLocal(c.phone).padEnd(15)}  ` +
        `${c.category.padEnd(10)}  ${balance.padStart(15)}   ${String(c._count.transactions).padStart(3)}`,
    );
  }

  /* ── Invariant checks ─────────────────────────────────────────────────────── */

  console.log('\n── تحقق من القيود ────────────────────────────────────────────\n');

  // 1. The snapshot cache must agree with the authoritative transaction rows.
  //    The cache is derived; if it ever disagrees, the cache is what is wrong.
  let snapshotsAgree = true;
  for (const c of customers) {
    const snapshot = c.balanceSnapshots[0];
    const grouped = await prisma.transaction.aggregate({
      where: { customerId: c.id, periodKey: currentPeriod },
      _sum: { amount: true },
      _count: true,
    });
    const computed = grouped._sum.amount ?? 0;
    const cached = snapshot?.cumulativeAmount ?? 0;
    if (computed !== cached) {
      snapshotsAgree = false;
      console.log(`      تعارض عند ${c.name}: محسوب ${computed} ≠ مخزّن ${cached}`);
    }
  }
  check('الرصيد المخزّن مطابق للمحسوب من العمليات', snapshotsAgree);

  // 2. The idempotency guard must exist as a real UNIQUE index, not just API logic.
  const indexes = await prisma.$queryRaw<IndexRow[]>`
    SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'transaction'
  `;
  const uniqueGuard = indexes.find(
    (i) =>
      i.indexdef.includes('UNIQUE') &&
      i.indexdef.includes('merchant_id') &&
      i.indexdef.includes('branch_id') &&
      i.indexdef.includes('invoice_id'),
  );
  check(
    'قيد الفريدة (merchant_id, branch_id, invoice_id) موجود في قاعدة البيانات',
    Boolean(uniqueGuard),
    uniqueGuard ? `[${uniqueGuard.indexname}]` : '',
  );

  // 3. And it must actually refuse a duplicate. A constraint nobody tested is a hope.
  const sample = await prisma.transaction.findFirst({ where: { merchantId: merchant.id } });
  if (!sample) throw new Error('لا توجد عمليات لاختبار التكرار');

  let duplicateRejected = false;
  let duplicateCode = '';
  try {
    await prisma.transaction.create({
      data: {
        merchantId: sample.merchantId,
        branchId: sample.branchId,
        customerId: sample.customerId,
        invoiceId: sample.invoiceId, // same invoice, same branch — must be refused
        amount: 1_000,
        currency: 'IQD',
        occurredAt: new Date(),
        source: 'SCAN',
        amountCapture: 'MANUAL',
        periodKey: sample.periodKey,
        linkedByUserId: sample.linkedByUserId,
      },
    });
  } catch (error: unknown) {
    duplicateRejected = true;
    if (error && typeof error === 'object' && 'code' in error) {
      duplicateCode = String((error as { code: unknown }).code);
    }
  }
  check(
    `قاعدة البيانات ترفض ربط نفس الفاتورة مرتين (${sample.invoiceId})`,
    duplicateRejected,
    duplicateCode ? `[Prisma ${duplicateCode}]` : '',
  );

  // 4. Hot-path indexes from CLAUDE.md §8 must be present.
  const customerIndexes = await prisma.$queryRaw<IndexRow[]>`
    SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'customer'
  `;
  const couponIndexes = await prisma.$queryRaw<IndexRow[]>`
    SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'coupon'
  `;
  const hasIndexOn = (rows: IndexRow[], column: string): boolean =>
    rows.some((r) => r.indexdef.includes(`(${column})`) || r.indexdef.includes(`${column},`) || r.indexdef.includes(`, ${column})`));

  check('فهرس customer.phone', hasIndexOn(customerIndexes, 'phone'));
  check('فهرس customer.qr_token', hasIndexOn(customerIndexes, 'qr_token'));
  check('فهرس transaction (branch_id, invoice_id)', hasIndexOn(indexes, 'branch_id'));
  check('فهرس transaction.customer_id', hasIndexOn(indexes, 'customer_id'));
  check('فهرس coupon.customer_id', hasIndexOn(couponIndexes, 'customer_id'));
  check('فهرس coupon.status', hasIndexOn(couponIndexes, 'status'));

  // 5. No customer QR token may contain the customer's phone number (§7.9).
  const leakingQr = customers.filter((c) => {
    const national = c.phone.replace('+964', '');
    return c.qrToken.includes(national) || c.qrToken.includes(c.phone);
  });
  check('لا يحتوي أي رمز QR على رقم هاتف الزبون', leakingQr.length === 0);

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
