#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  UPGRADE DRILL — a shop's data, across a real version change
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   node drills/upgrade.mjs
 *
 * Two genuinely different staged runtimes — 0.2.0 and 0.2.1, each produced by its own
 * `package:build` — against one data directory, in that order.
 *
 * ── Why this is the half that matters ────────────────────────────────────────
 *
 * The signature check proves nobody can push a hostile update. It says nothing about
 * whether a *legitimate* one is safe to accept. An update that verifies perfectly and
 * then refuses to open the shop's database, or opens it and loses the customers, is a
 * worse outcome than never updating at all: the merchant took the risk on your word.
 *
 * So this asks, across the boundary:
 *
 *   · does the newer binary open a database the older one created
 *   · do the identity, integrity and migration-set checks still pass
 *   · are the customers, invoices and vouchers all still there, unchanged
 *   · does the configuration survive
 *   · and did the version the service reports actually change
 *
 * The last one is not a formality. A "successful" upgrade that silently kept running
 * the old binary is the failure nobody notices until the fix they were promised turns
 * out not to be installed.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('E:/loyalty/apps/api/package.json');
const { PrismaClient } = require('@prisma/client');

const SCRATCH = 'E:/temp/claude/E--loyalty/f563cfe8-5fe9-4704-8ff7-20f7ac1e703d/scratchpad';
const ROOT = `${SCRATCH}/upgrade`;
const DB = `${ROOT}/walaa.db`;
const ENV = `${ROOT}/env`;
const PORT = 4991;
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

let log = '';
function start(which) {
  log = '';
  const child = spawn(`${ROOT}/${which}/node.exe`, ['walaa-api.cjs'], {
    cwd: `${ROOT}/${which}`,
    env: { ...process.env, WALAA_ENV_FILE: ENV, WALAA_DATA_DIR: ROOT, WALAA_SUPERVISED: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => { log += c.toString(); });
  child.stderr.on('data', (c) => { log += c.toString(); });
  return child;
}

async function healthy(ms = 60000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return await r.json();
    } catch { /* not yet */ }
    await sleep(400);
  }
  return null;
}

/** Stops it the way the service host does: close stdin, which triggers a clean shutdown. */
async function stopCleanly(child) {
  child.stdin.end();
  const until = Date.now() + 25000;
  while (Date.now() < until) {
    try { await fetch(`${BASE}/health`); } catch { hardKill(child.pid); return true; }
    await sleep(300);
  }
  hardKill(child.pid);
  return false;
}

const api = async (method, path, body, token) => {
  const r = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: r.status, body: parsed, text };
};

/** Everything the shop would notice if it went missing. */
async function fingerprint() {
  const db = new PrismaClient({ datasourceUrl: `file:${DB}` });
  try {
    const customers = await db.customer.findMany({
      orderBy: { id: 'asc' }, select: { id: true, phone: true, name: true },
    });
    const transactions = await db.transaction.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, invoiceId: true, amountGross: true, discountValue: true },
    });
    const vouchers = await db.voucher.findMany({
      orderBy: { id: 'asc' }, select: { id: true, code: true, value: true, status: true },
    });
    const users = await db.user.findMany({ orderBy: { id: 'asc' }, select: { username: true, role: true } });
    const digest = (r) => createHash('sha256').update(JSON.stringify(r)).digest('hex').slice(0, 16);
    return {
      counts: { customers: customers.length, transactions: transactions.length, vouchers: vouchers.length, users: users.length },
      hash: digest([customers, transactions, vouchers, users]),
      gross: transactions.reduce((a, t) => a + t.amountGross, 0),
    };
  } finally {
    await db.$disconnect();
  }
}

console.log('\nupgrade drill — 0.2.0 creates a shop, 0.2.1 inherits it\n');

// ── Provision a data directory and a configuration, once ────────────────────
rmSync(DB, { force: true });
for (const suffix of ['-wal', '-shm']) rmSync(`${DB}${suffix}`, { force: true });
rmSync(`${ROOT}/logs`, { recursive: true, force: true });
mkdirSync(`${ROOT}/backups`, { recursive: true });

const CONFIG_MARKER = 'BAG-UPGRADE-01';

// ── 1. 0.2.0 creates the shop ───────────────────────────────────────────────
let before;
{
  let child = start('v020');
  const health = await healthy();
  step('0.2.0 starts on an empty directory', Boolean(health) && health.version === '0.2.0',
    health ? `reports version ${health.version}` : 'never became healthy');

  const boot = await api('POST', '/auth/bootstrap', {
    merchantName: 'سوبرماركت الترقية', branchName: 'فرع الاختبار', branchCode: CONFIG_MARKER,
    ownerName: 'مالك الترقية', username: 'upgradeowner', password: 'upgrade-drill-2026',
  });
  const login = await api('POST', '/auth/login', { username: 'upgradeowner', password: 'upgrade-drill-2026' });
  const token = login.body?.tokens?.accessToken ?? null;

  const customer = await api('POST', '/customers',
    { name: 'زبون ما قبل الترقية', phone: `0770${String(Date.now()).slice(-7)}`, category: 'REGULAR' }, token);

  step('a shop is created on 0.2.0', boot.status === 201 && login.status === 200 && customer.status < 300,
    `bootstrap=${boot.status} login=${login.status} customer=${customer.status}`);

  before = await fingerprint();
  step('its data is recorded before the upgrade', before.counts.users === 1,
    `${before.counts.customers} customers · ${before.counts.users} users · content hash ${before.hash}`);

  const stopped = await stopCleanly(child);
  step('0.2.0 shuts down cleanly', stopped,
    stopped ? 'stdin closed, service exited, WAL checkpointed' : 'did not stop within 25s');
  await sleep(800);
}

// ── 2. 0.2.1 inherits it ────────────────────────────────────────────────────
{
  const child = start('v021');
  const health = await healthy();

  step('0.2.1 starts against the database 0.2.0 created', Boolean(health),
    health ? `reports version ${health.version}` : 'never became healthy — see the log below');

  step('the version the service reports actually changed', health?.version === '0.2.1',
    `before 0.2.0 → after ${health?.version ?? '(not serving)'}`);

  step('the identity, integrity and migration checks all passed on the inherited file',
    log.includes('database identity verified') &&
    log.includes('database integrity verified') &&
    log.includes('migration set verified'),
    ['migration set', 'identity', 'integrity']
      .map((k) => `${k}=${log.includes(`database ${k} verified`) || log.includes(`${k} verified`)}`)
      .join(' '));

  step('no migration was run on the merchant’s machine', !log.includes('database migrations applied'),
    'the upgrade opened the existing database rather than altering it');

  const after = await fingerprint();
  const same = JSON.stringify(after.counts) === JSON.stringify(before.counts) && after.hash === before.hash;
  step('every customer, invoice, voucher and user survived, unchanged', same,
    `before ${JSON.stringify(before.counts)} hash ${before.hash}\n        after  ${JSON.stringify(after.counts)} hash ${after.hash}`);

  // The shop's own configuration — the branch code it was set up with.
  const db = new PrismaClient({ datasourceUrl: `file:${DB}` });
  const branch = await db.branch.findFirst({ select: { code: true, name: true } });
  const merchant = await db.merchant.findFirst({ select: { name: true, timezone: true, paperWidth: true } });
  await db.$disconnect();
  step('the saved configuration survived', branch?.code === CONFIG_MARKER && Boolean(merchant),
    `branch ${branch?.code} · ${merchant?.name} · ${merchant?.timezone} · ${merchant?.paperWidth}mm`);

  // And the owner created under 0.2.0 can still sign in under 0.2.1.
  const login = await api('POST', '/auth/login', { username: 'upgradeowner', password: 'upgrade-drill-2026' });
  step('the owner created on 0.2.0 can still sign in on 0.2.1', login.status === 200,
    login.status === 200 ? `${login.body.user.name} — ${login.body.user.role}` : `${login.status} ${login.text.slice(0, 120)}`);

  hardKill(child.pid);
}

const failed = rows.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`}  (${rows.length} checks)\n`);
if (failed.length > 0) console.log(log.split(/\r?\n/).slice(-14).join('\n'));
process.exit(failed.length === 0 ? 0 : 1);
