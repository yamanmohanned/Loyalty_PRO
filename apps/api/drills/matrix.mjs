#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ACCEPTANCE MATRIX — the whole product, from a bare directory to a recovery
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   node drills/matrix.mjs [port]
 *
 * Runs the STAGED RUNTIME — `packaging/dist/runtime`, the exact tree the NSIS installer
 * bundles — in production mode against a directory that starts empty. Everything the
 * installer does that this cannot is elevation-only (registering the Windows Service,
 * the firewall rule, writing under `Program Files`), and those are listed as NOT
 * VERIFIED in the report rather than approximated here.
 *
 * What it walks, in the order a shop would:
 *
 *   first launch → login → register a customer → capture an invoice → discount applied
 *   → voucher issued → voucher redeemed once and refused twice → backup → restore into
 *   a clean directory and verify the contents → killed mid-operation → relaunch →
 *   clean shutdown and restart (the reboot path) → the database still whole.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('E:/loyalty/apps/api/package.json');
const { PrismaClient } = require('@prisma/client');

const PORT = Number(process.argv[2] ?? 4971);
const SCRATCH = 'E:/temp/claude/E--loyalty/f563cfe8-5fe9-4704-8ff7-20f7ac1e703d/scratchpad';
const ROOT = `${SCRATCH}/matrix`;
const DB = `${ROOT}/walaa.db`;
const ENV = `${ROOT}/env`;
const BACKUPS = `${ROOT}/backups`;
const RUNTIME = 'E:/loyalty/packaging/dist/runtime';
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
const step = (name, ok, detail) => {
  rows.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        ${detail}`);
};
const hardKill = (pid) => {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
};

/** The staged service, exactly as the installer ships it: node.exe + the CJS bundle. */
const start = () =>
  spawn(`${RUNTIME}/node.exe`, ['walaa-api.cjs'], {
    cwd: RUNTIME,
    /*
      `WALAA_SUPERVISED=1` because that is how the service host runs it.

      Windows has no SIGTERM and a service process has no console, so the supervisor's
      only way to ask for a graceful stop is to close the child's stdin — and the API
      only listens for that when supervised. Without this the drill closed stdin, the
      service ignored it, and the "clean shutdown" step measured a hard kill: the WAL
      was still there afterwards, correctly, because nothing had checkpointed it.
    */
    env: { ...process.env, WALAA_ENV_FILE: ENV, WALAA_DATA_DIR: ROOT, WALAA_SUPERVISED: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

let log = '';
const healthy = async (child, ms = 60000) => {
  if (child) {
    child.stdout.on('data', (c) => { log += c.toString(); });
    child.stderr.on('data', (c) => { log += c.toString(); });
  }
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if ((await fetch(`${BASE}/health`)).ok) return true; } catch { /* not yet */ }
    await sleep(400);
  }
  return false;
};

let token = null;
/**
 * The till's own account.
 *
 * `/scan/card` is a STATION route and refuses a caller with no branch —
 * «هذه المحطة غير مرتبطة بفرع» — which is correct: an unbound OWNER attributing a sale
 * would be attributing it to no branch, and §12 makes branch a verified property of the
 * writer rather than something the request declares. The drill used `owner` and was
 * rightly refused; a real till signs in as `station`.
 */
let stationToken = null;
const api = async (method, path, body, auth = true, useStation = false) => {
  const r = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(auth && (useStation ? stationToken : token)
        ? { authorization: `Bearer ${useStation ? stationToken : token}` }
        : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: r.status, body: parsed, text };
};

async function query(fn) {
  const db = new PrismaClient({ datasourceUrl: `file:${DB}` });
  try { return await fn(db); } finally { await db.$disconnect(); }
}

console.log('\nacceptance matrix — staged runtime, production mode, empty directory\n');

// ── 1. First launch on a bare directory ────────────────────────────────────
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(BACKUPS, { recursive: true });
writeFileSync(
  ENV,
  readFileSync(`${SCRATCH}/prod-drill/env`, 'utf8')
    .split(/\r?\n/)
    .map((l) =>
      l.startsWith('DATABASE_URL=') ? `DATABASE_URL="file:${DB}"`
      : l.startsWith('API_PORT=') ? `API_PORT=${PORT}`
      : l.startsWith('BACKUP_LOCAL_DIR=') ? `BACKUP_LOCAL_DIR="${BACKUPS}"`
      : l)
    .join('\n') + `\nBACKUP_LOCAL_DIR="${BACKUPS}"\n`,
);

let child = start();
{
  const up = await healthy(child);
  const installed = log.includes('installed the shipped database template');
  const migrated = log.includes('database migrations applied');
  const identity = log.includes('database identity verified');
  const integrity = log.includes('database integrity verified');
  step('first launch on an empty directory', up && installed && !migrated && identity && integrity,
    `serving=${up} templateInstalled=${installed} migrationsRun=${migrated} identity=${identity} integrity=${integrity}`);
}

// Seeded through the shipped runtime's own migrations directory, so the shop has staff.
execFileSync('npx', ['dotenv', '-e', '../../.env', '-v', `DATABASE_URL=file:${DB}`, '--', 'tsx', 'prisma/seed.ts'],
  { cwd: 'E:/loyalty/apps/api', stdio: 'ignore', shell: true });

// ── 2. Login ───────────────────────────────────────────────────────────────
{
  const r = await api('POST', '/auth/login', { username: 'owner', password: 'Walaa!Dev2026' }, false);
  token = r.body?.tokens?.accessToken ?? null;
  step('login through the real endpoint', r.status === 200 && Boolean(token),
    r.status === 200 ? `${r.body.user.name} — ${r.body.user.role} at ${r.body.user.merchantName}` : r.text.slice(0, 140));
}

// ── 3. Register a customer ─────────────────────────────────────────────────
let customerId = null;
{
  const phone = `0770${String(Date.now()).slice(-7)}`;
  const r = await api('POST', '/customers', { name: 'زبون الفحص النهائي', phone, category: 'REGULAR' });
  customerId = r.body?.customer?.id ?? null;
  step('register a customer', r.status < 300 && Boolean(customerId),
    r.status < 300 ? `${r.body.customer.name} · ${r.body.customer.phone}` : `${r.status} ${r.text.slice(0, 160)}`);
}

// ── 4. Capture an invoice over the discount threshold ──────────────────────
const invoiceId = `MATRIX-${Date.now()}`;
{
  const branch = await query((db) => db.branch.findFirst({ select: { code: true } }));
  const now = new Date().toISOString();
  const r = await api('POST', '/ingest/invoice', {
    invoice: {
      invoice_id: invoiceId, amount_gross: 250000, currency: 'IQD', branch_id: branch.code,
      occurred_at: now, captured_at: now, capture_mode: 'SPOOL_WATCH',
    },
  });
  step('capture an invoice', r.status < 300 && r.body?.duplicate === false,
    r.status < 300 ? `${r.body.invoiceId} recorded` : `${r.status} ${r.text.slice(0, 160)}`);
}

// ── 5 & 6. Attribute it: discount applied, voucher issued ──────────────────
let voucherId = null;
{
  /*
    The scanner types a CARD NUMBER, not a customer id — `lookupCard` matches it against
    an ASSIGNED card. A freshly registered customer has no card until one is assigned,
    so the drill assigns one from printed stock rather than skipping the core loop,
    which is the one path this whole product exists to run.
  */
  let cardNumber = (await query((db) =>
    db.card.findFirst({ where: { customerId, status: 'ASSIGNED' }, select: { cardNumber: true } })))?.cardNumber;

  if (!cardNumber) {
    const spare = await query((db) =>
      db.card.findFirst({ where: { status: 'PRINTED' }, select: { id: true, cardNumber: true } }));
    if (spare) {
      await query((db) => db.card.update({
        where: { id: spare.id },
        data: { customerId, status: 'ASSIGNED', assignedAt: new Date() },
      }));
      cardNumber = spare.cardNumber;
    }
  }

  const stationLogin = await api('POST', '/auth/login', { username: 'station', password: 'Walaa!Dev2026' }, false);
  stationToken = stationLogin.body?.tokens?.accessToken ?? null;

  const r = cardNumber && stationToken
    ? await api('POST', '/scan/card', { barcodeToken: cardNumber, invoiceId }, true, true)
    : { status: 0, text: `card=${cardNumber ?? 'none'} stationToken=${Boolean(stationToken)}`, body: null };

  const tx = await query((db) => db.transaction.findFirst({ where: { invoiceId }, select: { discountValue: true, amountNet: true, customerId: true } }));
  const v = await query((db) => db.voucher.findFirst({ where: { customerId }, orderBy: { issuedAt: 'desc' }, select: { id: true, value: true, status: true, code: true } }));
  voucherId = v?.id ?? null;

  step('attributing the sale applies the discount', r.status < 300 && tx?.customerId === customerId && tx.discountValue > 0,
    `scan=${r.status} card=${cardNumber ?? 'none'} ` +
    (tx ? `discount=${tx.discountValue} net=${tx.amountNet} attributed=${tx.customerId === customerId}` : 'no transaction') +
    ` · ${String(r.text).slice(0, 200)}`);
  step('and issues a voucher for it', Boolean(v) && v.status === 'ISSUED',
    v ? `${v.code} · ${v.value} IQD · ${v.status}` : 'no voucher issued');
}

// ── 7. Redeem it once; refuse it the second time ───────────────────────────
{
  const first = await api('POST', `/vouchers/${voucherId}/redeem`, {}, true, true);
  const second = await api('POST', `/vouchers/${voucherId}/redeem`, {}, true, true);
  const after = await query((db) => db.voucher.findUnique({ where: { id: voucherId }, select: { status: true } }));
  step('redeem the voucher once', first.status < 300 && after.status === 'REDEEMED',
    `first=${first.status} status=${after.status}`);
  step('a second redemption is refused, in Arabic', second.status >= 400,
    `second=${second.status} · ${second.body?.error?.message ?? second.text.slice(0, 120)}`);
}

// ── 8. Back up ─────────────────────────────────────────────────────────────
let archive = null;
{
  await api('POST', '/backup/key/generate');
  const revealed = await api('POST', '/backup/key/reveal');
  await api('POST', '/backup/key/confirm', { key: revealed.body?.key });
  const r = await api('POST', '/backup/run');
  archive = r.body?.name ?? null;
  step('take a backup', r.status < 300 && r.body?.ok === true,
    r.status < 300 ? `${archive} · ${r.body.archiveBytes} bytes from ${r.body.snapshotBytes}` : r.text.slice(0, 160));
}

const before = await query(async (db) => ({
  customers: await db.customer.count(),
  transactions: await db.transaction.count(),
  vouchers: await db.voucher.count(),
}));

// ── 9. Killed mid-operation, then relaunched ───────────────────────────────
{
  let stop = false;
  const branch = await query((db) => db.branch.findFirst({ select: { code: true } }));
  const firing = (async () => {
    let n = 0;
    while (!stop) {
      const now = new Date().toISOString();
      fetch(`${BASE}/api/v1/ingest/invoice`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ invoice: {
          invoice_id: `MATRIX-K-${n++}-${Date.now()}`, amount_gross: 90000, currency: 'IQD',
          branch_id: branch.code, occurred_at: now, captured_at: now, capture_mode: 'SPOOL_WATCH' } }),
      }).catch(() => {});
      await sleep(8);
    }
  })();
  await sleep(1200);
  hardKill(child.pid);
  stop = true;
  await firing.catch(() => {});
  await sleep(700);

  log = '';
  child = start();
  const up = await healthy(child);
  const state = await query(async (db) => {
    const integrity = await db.$queryRawUnsafe('PRAGMA integrity_check');
    const fk = await db.$queryRawUnsafe('PRAGMA foreign_key_check');
    const orphans = await db.$queryRawUnsafe(
      `SELECT COUNT(*) AS n FROM voucher v LEFT JOIN "transaction" t ON t.id = v.transaction_id WHERE t.id IS NULL`);
    const dupes = await db.$queryRawUnsafe(
      `SELECT COUNT(*) AS n FROM (SELECT invoice_id FROM "transaction" GROUP BY merchant_id, branch_id, invoice_id HAVING COUNT(*) > 1)`);
    return { integrity: integrity[0]?.integrity_check, fk: fk.length, orphans: Number(orphans[0].n), dupes: Number(dupes[0].n) };
  });
  step('killed mid-operation, then relaunched', up && state.integrity === 'ok' && state.fk === 0 && state.orphans === 0 && state.dupes === 0,
    `serving=${up} integrity=${state.integrity} fk=${state.fk} orphanVouchers=${state.orphans} duplicateInvoices=${state.dupes}`);
}

// ── 10. Clean shutdown and restart — the reboot path ───────────────────────
{
  // The supervised stop signal: closing stdin, exactly as the service host does.
  child.stdin.end();
  const gone = await (async () => {
    const until = Date.now() + 20000;
    while (Date.now() < until) {
      try { await fetch(`${BASE}/health`); } catch { return true; }
      await sleep(300);
    }
    return false;
  })();
  hardKill(child.pid);
  await sleep(500);

  /*
    A clean shutdown checkpoints the WAL and truncates it, so one file is left rather
    than three and the next start has no log to replay. That is the whole point of
    `checkpointWal` on the shutdown path, and this is where it is observed.
  */
  const sidecars = ['-wal', '-shm'].filter((s) => existsSync(`${DB}${s}`));

  log = '';
  child = start();
  const up = await healthy(child);
  const after = await query(async (db) => ({
    customers: await db.customer.count(),
    transactions: await db.transaction.count(),
    vouchers: await db.voucher.count(),
  }));
  step('clean shutdown checkpoints the WAL, then restarts with the data intact',
    gone && up && after.customers >= before.customers && sidecars.length === 0,
    `stopped=${gone} restarted=${up} sidecarsLeft=[${sidecars.join(', ') || 'none'}] ` +
    `rows ${after.customers}/${after.transactions}/${after.vouchers}`);
}

// ── 11. Restore the backup into a clean directory and check the contents ───
{
  const target = `${ROOT}/restored/walaa.db`;
  rmSync(`${ROOT}/restored`, { recursive: true, force: true });
  mkdirSync(`${ROOT}/restored`, { recursive: true });

  let ok = false;
  let detail = '';
  try {
    execFileSync('npx', ['tsx', 'src/tools/restore-cli.ts', `${BACKUPS}/${archive}`, '--to', target],
      { cwd: 'E:/loyalty/apps/api', stdio: 'ignore', shell: true });
    const restored = await (async () => {
      const db = new PrismaClient({ datasourceUrl: `file:${target}` });
      try {
        return {
          customers: await db.customer.count(),
          transactions: await db.transaction.count(),
          vouchers: await db.voucher.count(),
          owner: await db.user.count({ where: { username: 'owner' } }),
          theSale: await db.transaction.count({ where: { invoiceId } }),
        };
      } finally { await db.$disconnect(); }
    })();
    ok = restored.customers === before.customers &&
         restored.transactions === before.transactions &&
         restored.vouchers === before.vouchers &&
         restored.owner === 1 && restored.theSale === 1;
    detail = `restored ${restored.customers}/${restored.transactions}/${restored.vouchers} ` +
      `vs backed-up ${before.customers}/${before.transactions}/${before.vouchers} · the matrix sale present=${restored.theSale === 1}`;
  } catch (error) {
    detail = String(error.message).slice(0, 200);
  }
  step('restore into a clean directory, contents correct', ok, detail);
}

hardKill(child.pid);

const failed = rows.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`}  (${rows.length} steps)\n`);
process.exit(failed.length === 0 ? 0 : 1);
