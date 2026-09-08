#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  CONTENTION DRILL — two people pressing the same button at the same moment
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   node drills/contention.mjs <baseUrl> <dbPath> [rounds]
 *
 * ── Why this is a drill and not only a unit test ─────────────────────────────
 *
 * SQLite's behaviour under contention is a property of its *configuration*, not of the
 * code above it. A pass under a different journal mode, a different busy timeout or a
 * different pool size proves nothing about what ships. So this runs against a real API
 * process, booted in production mode from a production-provisioned database, and it
 * begins by reading the settings back out of SQLite and refusing to continue if they
 * are not the ones the product sets.
 *
 * ── Why many rounds ─────────────────────────────────────────────────────────
 *
 * A race that fails one time in fifty passes a single run and then happens in the shop
 * in week one. Every scenario here is repeated, and the report states how many rounds
 * it survived rather than that it "passed".
 *
 * ── The three that cost the merchant money ──────────────────────────────────
 *
 * 1. **A voucher redeemed twice.** The realistic version is not two cashiers; it is one
 *    cashier double-clicking a slow button. He gives the discount twice and the till is
 *    short.
 * 2. **The same invoice ingested twice.** A retry after a timeout, or a cashier scanning
 *    a receipt again because nothing visibly happened. The customer is credited twice
 *    for one sale.
 * 3. **Two writers crossing a customer's threshold together.** A lost update here means
 *    a customer's spend is understated and the discount they earned never arrives.
 *
 * ── And a fourth thing, which is the point ──────────────────────────────────
 *
 * A concurrency guard nobody has watched fail is not a guard. The last section removes
 * the protection deliberately — a read-then-write redemption on two independent
 * connections, which is what this code would look like if somebody "simplified" it —
 * and shows the double redemption happening. Then it runs the real conditional UPDATE
 * against the same setup and shows it refused.
 */
import { createRequire } from 'node:module';
const require = createRequire('E:/loyalty/apps/api/package.json');
const { PrismaClient } = require('@prisma/client');
const { randomUUID } = require('node:crypto');

const BASE = process.argv[2] ?? 'http://127.0.0.1:4931';
const DB = process.argv[3] ?? 'E:/temp/claude/E--loyalty/f563cfe8-5fe9-4704-8ff7-20f7ac1e703d/scratchpad/prod-drill/walaa.db';
const ROUNDS = Number(process.argv[4] ?? 40);
/** The API's own boot log. Its `sqlite settings` line is what this run may claim. */
const API_LOG = process.argv[5] ?? null;

/**
 * Applies the settings `applySqlitePragmas` applies, to a connection this drill owns.
 *
 * Necessary, and the reason is the first thing this drill checks. `synchronous` and
 * `wal_autocheckpoint` are **per connection**, not properties of the file: a client
 * opened by a tool, a test or a drill gets SQLite's defaults (FULL, 1000) whatever the
 * service set on its own connection. The first version of this script asserted against
 * its own connection, saw `synchronous=2` and `wal_autocheckpoint=1000`, and would have
 * reported a concurrency result obtained under settings the product does not use. That
 * is the exact mistake this section exists to make impossible.
 */
async function applyProductionPragmas(client) {
  await client.$queryRawUnsafe('PRAGMA journal_mode = WAL');
  await client.$queryRawUnsafe('PRAGMA busy_timeout = 5000');
  await client.$queryRawUnsafe('PRAGMA foreign_keys = ON');
  await client.$queryRawUnsafe('PRAGMA synchronous = NORMAL');
  await client.$queryRawUnsafe('PRAGMA wal_autocheckpoint = 512');
}

const db = new PrismaClient({ datasourceUrl: `file:${DB}` });
await applyProductionPragmas(db);
const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        ${detail}`);
};

/** The settings every claim below depends on. Read back, never assumed. */
const EXPECTED = { journal_mode: 'wal', busy_timeout: 5000, foreign_keys: 1, synchronous: 1, wal_autocheckpoint: 512 };

const pragma = async (name) => {
  const rows = await db.$queryRawUnsafe(`PRAGMA ${name}`);
  return Object.values(rows[0] ?? {})[0];
};

/**
 * Signs in, reusing a cached token when there is a live one.
 *
 * `/auth/login` is rate-limited on purpose (§7.5) and the limiter is in-process memory,
 * so a drill run repeatedly during development exhausts the bucket and then fails for a
 * reason that has nothing to do with what it is testing. Caching keeps the limiter
 * honest — it is protecting a real endpoint — while letting this be re-run as often as
 * the evidence requires.
 */
const TOKEN_CACHE = `${DB}.drill-tokens.json`;
const login = async (username) => {
  const { existsSync, readFileSync, writeFileSync } = require('node:fs');
  let cache = {};
  if (existsSync(TOKEN_CACHE)) {
    try { cache = JSON.parse(readFileSync(TOKEN_CACHE, 'utf8')); } catch { cache = {}; }
  }

  // A cached token is only worth reusing if it still opens something.
  if (cache[username]) {
    const probe = await fetch(`${BASE}/api/v1/backup/drive/connect/status`, {
      headers: { authorization: `Bearer ${cache[username]}` },
    });
    if (probe.status !== 401) return cache[username];
  }

  const r = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'Walaa!Dev2026' }),
  });
  if (!r.ok) throw new Error(`login ${username}: ${r.status} ${await r.text()}`);
  const token = (await r.json()).tokens.accessToken;
  cache[username] = token;
  writeFileSync(TOKEN_CACHE, JSON.stringify(cache), 'utf8');
  return token;
};

/**
 * Paces a scenario so the rate limiter never becomes the thing being measured.
 *
 * The limits are per-route and per-minute (§7.5) — 120 for redemption, 300 for
 * ingestion — and they are deliberately not switchable off from the environment,
 * because a production process that can have its throttling disabled by a variable is
 * a production process with no throttling. So the drill slows to fit inside them
 * instead. Contention is created by the eight requests *within* a round; the gap
 * between rounds costs nothing but wall time.
 */
const pace = (perMinute, perRound) => {
  const gapMs = Math.ceil((60_000 / perMinute) * perRound) + 60;
  return () => new Promise((r) => setTimeout(r, gapMs));
};

const post = (token, path, body) =>
  fetch(`${BASE}/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body ?? {}),
  }).then(async (r) => ({ status: r.status, body: await r.text() }));

console.log(`\ncontention drill — ${ROUNDS} rounds per scenario\n`);

// ── 0. The settings this run is entitled to claim ──────────────────────────
{
  const actual = {
    journal_mode: String(await pragma('journal_mode')).toLowerCase(),
    busy_timeout: Number(await pragma('busy_timeout')),
    foreign_keys: Number(await pragma('foreign_keys')),
    synchronous: Number(await pragma('synchronous')),
    wal_autocheckpoint: Number(await pragma('wal_autocheckpoint')),
  };
  const same = Object.entries(EXPECTED).every(([k, v]) => actual[k] === v);
  record("this drill's own connections match production", same, JSON.stringify(actual));
  if (!same) {
    console.log('\n  refusing to continue: a concurrency result under other settings means nothing.\n');
    await db.$disconnect();
    process.exit(1);
  }
}

// The API PROCESS's settings are a different question from this drill's, and the only
// place its private connection is visible from out here is its own boot log.
{
  const { readFileSync } = require('node:fs');
  let apiSettings = null;
  if (API_LOG) {
    try {
      const line = readFileSync(API_LOG, 'utf8')
        .split(/\r?\n/)
        .find((l) => l.includes('"msg":"sqlite settings"'));
      apiSettings = line ? JSON.parse(line) : null;
    } catch { apiSettings = null; }
  }
  const apiSame =
    apiSettings !== null &&
    Object.entries(EXPECTED).every(([k, v]) =>
      typeof v === 'string'
        ? String(apiSettings[k]).toLowerCase() === v
        : Number(apiSettings[k]) === v);
  record('the API process is running the same settings', apiSame,
    apiSettings
      ? JSON.stringify(Object.fromEntries(Object.keys(EXPECTED).map((k) => [k, apiSettings[k]])))
      : 'no "sqlite settings" line found — pass the API log path as the 5th argument');
  if (!apiSame) {
    console.log('  refusing to continue: the service under test is not configured as it ships.');
    await db.$disconnect();
    process.exit(1);
  }
}

const owner = await login('owner');
const station = await login('station');
const agent = await login('agent');
const branch = await db.branch.findFirst({ select: { id: true, code: true } });
const merchant = await db.merchant.findFirst({ select: { id: true } });

/** Mints an ISSUED voucher against a real transaction. Preconditions are made, not waited for. */
async function mintVoucher(n) {
  const customer = await db.customer.findFirst({ select: { id: true } });
  const tx = await db.transaction.create({
    data: {
      merchantId: merchant.id, branchId: branch.id, customerId: customer.id,
      invoiceId: `DRILL-V-${n}-${randomUUID().slice(0, 8)}`,
      amountGross: 100000, discountValue: 3000, amountNet: 97000,
      currency: 'IQD', occurredAt: new Date(), captureMode: 'SPOOL_WATCH', capturedAt: new Date(),
    },
  });
  return db.voucher.create({
    data: {
      merchantId: merchant.id, transactionId: tx.id, customerId: customer.id,
      code: `DRL${n}${randomUUID().slice(0, 6).toUpperCase()}`,
      value: 3000, settlementStrategy: 'MERCHANT_DEFINED', status: 'ISSUED',
    },
    select: { id: true },
  });
}

// ── 1. One voucher, several simultaneous redemptions, many times ───────────
{
  /*
    ── The invariant, stated precisely ───────────────────────────────────────

    The property is "**never more than one** redemption", not "exactly one". Those
    differ, and conflating them made the first version of this drill report a failure
    it had caused itself: `/vouchers/:id/redeem` is rate-limited to 120/minute (§7.5),
    and 40 rounds x 8 requests is 320, so the limiter correctly refused a third of them
    and rounds came back with ZERO successes. That is the limiter working, not a
    double-spend, and counting it as one would have sent somebody hunting a bug that
    was never there.

    So 429s are counted separately and excluded from the verdict — and the count is
    reported, because a run where the limiter ate most of the traffic has contested
    fewer vouchers than it claims to have.
  */
  let doubleSpends = 0;
  let contested = 0;
  let rateLimitedRounds = 0;
  const parallel = 8;
  const waitRedeem = pace(120, parallel);
  for (let i = 0; i < ROUNDS; i += 1) {
    if (i > 0) await waitRedeem();
    const v = await mintVoucher(`r${i}`);
    // station and manager at once, plus a double-click's worth of repeats
    const tokens = Array.from({ length: parallel }, (_, k) => (k % 2 ? station : owner));
    const answers = await Promise.all(tokens.map((t) => post(t, `/vouchers/${v.id}/redeem`, {})));
    const ok = answers.filter((a) => a.status < 300).length;
    const throttled = answers.filter((a) => a.status === 429).length;
    const audits = await db.auditLog.count({
      where: { entityId: v.id, action: { contains: 'REDEEM' } },
    });

    // The money question: did more than one caller walk away believing it redeemed?
    if (ok > 1 || audits > 1) doubleSpends += 1;
    if (throttled > 0) rateLimitedRounds += 1;
    // A round only counts as evidence if at least two callers actually reached the
    // endpoint and raced for it.
    if (parallel - throttled >= 2) contested += 1;
  }
  record(
    `a voucher cannot be redeemed twice (${ROUNDS} rounds x ${parallel} simultaneous)`,
    doubleSpends === 0 && contested >= 10,
    `double redemptions: ${doubleSpends} · genuinely contested rounds: ${contested}/${ROUNDS}` +
      ` · rounds the rate limiter touched: ${rateLimitedRounds}`,
  );
}

// ── 2. The same invoice, sent several times at once, many times ────────────
{
  // Same precision as above: the invariant is "never more than one row", and a 429 is
  // the limiter doing its job rather than a duplicated sale.
  let duplicated = 0;
  let contested = 0;
  let rateLimitedRounds = 0;
  let otherErrors = 0;
  const parallel = 8;
  const waitIngest = pace(300, parallel);
  for (let i = 0; i < ROUNDS; i += 1) {
    if (i > 0) await waitIngest();
    const invoiceId = `DRILL-I-${Date.now()}-${i}`;
    const now = new Date().toISOString();
    const invoice = {
      invoice_id: invoiceId, amount_gross: 90000 + i, currency: 'IQD',
      branch_id: branch.code, occurred_at: now, captured_at: now, capture_mode: 'SPOOL_WATCH',
    };
    const answers = await Promise.all(
      Array.from({ length: parallel }, () => post(agent, '/ingest/invoice', { invoice })),
    );
    const rows = await db.transaction.count({ where: { invoiceId } });
    const throttled = answers.filter((a) => a.status === 429).length;
    const failures = answers.filter((a) => a.status >= 300 && a.status !== 429).length;

    if (rows > 1) duplicated += 1;
    if (throttled > 0) rateLimitedRounds += 1;
    otherErrors += failures;
    if (parallel - throttled >= 2) contested += 1;
  }
  record(
    `the same invoice lands once however often it is sent (${ROUNDS} rounds x ${parallel})`,
    duplicated === 0 && otherErrors === 0 && contested >= 10,
    `duplicated: ${duplicated} · non-429 failures: ${otherErrors}` +
      ` · genuinely contested rounds: ${contested}/${ROUNDS} · rounds the limiter touched: ${rateLimitedRounds}`,
  );
}

// ── 3. Two writers moving one customer across a threshold together ─────────
{
  let lost = 0;
  const parallel = 10;
  for (let i = 0; i < Math.min(ROUNDS, 20); i += 1) {
    const customer = await db.customer.create({
      data: {
        merchantId: merchant.id, phone: `+96477${String(Date.now()).slice(-8)}${i % 10}`,
        name: `درِل ${i}`, category: 'REGULAR',
      },
      select: { id: true },
    });

    const each = 30000;
    const now = new Date().toISOString();
    await Promise.all(
      Array.from({ length: parallel }, (_, k) =>
        db.transaction.create({
          data: {
            merchantId: merchant.id, branchId: branch.id, customerId: customer.id,
            invoiceId: `DRILL-T-${Date.now()}-${i}-${k}`,
            amountGross: each, discountValue: 0, amountNet: each,
            currency: 'IQD', occurredAt: new Date(now), captureMode: 'SPOOL_WATCH', capturedAt: new Date(),
          },
        })),
    );

    const agg = await db.transaction.aggregate({
      where: { customerId: customer.id }, _sum: { amountGross: true }, _count: true,
    });
    if (agg._count !== parallel || agg._sum.amountGross !== each * parallel) lost += 1;
  }
  record(
    `concurrent writes to one customer never lose a sale (${Math.min(ROUNDS, 20)} rounds x ${parallel})`,
    lost === 0,
    `rounds whose total did not equal the sum of its parts: ${lost}`,
  );
}

// ── 4. Remove the guard, and watch it fail ─────────────────────────────────
//
// Two INDEPENDENT connections, so the API's in-process write queue is out of the way
// and the database is the only thing left defending the invariant. That is the honest
// test of the guard: the queue is a performance decision that happens to serialise a
// single process, and it would not survive a second one.
{
  const a = new PrismaClient({ datasourceUrl: `file:${DB}` });
  const b = new PrismaClient({ datasourceUrl: `file:${DB}` });
  for (const c of [a, b]) await applyProductionPragmas(c);

  /** What the code would be if somebody replaced the conditional UPDATE with a check. */
  const unsafeRedeem = async (client, voucherId) => {
    const row = await client.voucher.findUnique({ where: { id: voucherId } });
    if (!row || row.status !== 'ISSUED') return false;
    await new Promise((r) => setTimeout(r, 12)); // the window every read-then-write has
    await client.voucher.update({
      where: { id: voucherId }, data: { status: 'REDEEMED', redeemedAt: new Date() },
    });
    return true;
  };

  /** What the code actually does: one conditional UPDATE, the claim and the check as one. */
  const safeRedeem = async (client, voucherId) => {
    const claimed = await client.voucher.updateMany({
      where: { id: voucherId, status: 'ISSUED' },
      data: { status: 'REDEEMED', redeemedAt: new Date() },
    });
    return claimed.count === 1;
  };

  let unsafeDoubles = 0;
  let safeDoubles = 0;
  const attempts = 30;

  for (let i = 0; i < attempts; i += 1) {
    const v = await mintVoucher(`unsafe${i}`);
    const [x, y] = await Promise.all([unsafeRedeem(a, v.id), unsafeRedeem(b, v.id)]);
    if (x && y) unsafeDoubles += 1;
  }
  for (let i = 0; i < attempts; i += 1) {
    const v = await mintVoucher(`safe${i}`);
    const [x, y] = await Promise.all([safeRedeem(a, v.id), safeRedeem(b, v.id)]);
    if (x && y) safeDoubles += 1;
  }

  await a.$disconnect();
  await b.$disconnect();

  record(
    'the guard is load-bearing — without it the double redemption happens',
    unsafeDoubles > 0,
    `read-then-write double-redeemed ${unsafeDoubles}/${attempts} times`,
  );
  record(
    'with the guard in place the same race is refused every time',
    safeDoubles === 0,
    `conditional UPDATE double-redeemed ${safeDoubles}/${attempts} times`,
  );
}

// ── the file itself, after all that ────────────────────────────────────────
{
  const integrity = await db.$queryRawUnsafe('PRAGMA integrity_check');
  const fk = await db.$queryRawUnsafe('PRAGMA foreign_key_check');
  const orphans = await db.$queryRawUnsafe(
    `SELECT COUNT(*) AS n FROM voucher v LEFT JOIN "transaction" t ON t.id = v.transaction_id WHERE t.id IS NULL`,
  );
  const ok = integrity[0]?.integrity_check === 'ok' && fk.length === 0 && Number(orphans[0].n) === 0;
  record('the database is still sound afterwards', ok,
    `integrity=${integrity[0]?.integrity_check} fkViolations=${fk.length} orphanVouchers=${orphans[0].n}`);
}

await db.$disconnect();

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`}  (${results.length} checks)\n`);
process.exit(failed.length === 0 ? 0 : 1);
