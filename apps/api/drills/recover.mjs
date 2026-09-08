#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  RECOVERY DRILL — the last line of defence, walked end to end
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   node drills/recover.mjs <baseUrl> <sourceDbPath> <backupDir> [apiLog]
 *
 * An untested backup is not a backup. Every other guarantee in this system — the
 * atomic sale, the conditional redemption, the integrity checks — is about not losing
 * data while the machine works. This is the one that matters when it does not.
 *
 * The drill is the whole path a shop walks after a disk fails:
 *
 *   1. take a real backup through the running API
 *   2. restore it into an EMPTY data directory, with the shipped CLI
 *   3. launch the service against it, in production mode
 *   4. log in
 *   5. and then the part that is usually skipped: **check the data is actually there
 *      and actually right** — not that the file opened and the login worked, but that
 *      every customer, invoice and voucher came back, with the same values.
 *
 * Step 5 is the point. A restore that produces a loginable database missing half the
 * customers passes steps 1–4 perfectly, and a merchant discovers it a week later.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('E:/loyalty/apps/api/package.json');
const { PrismaClient } = require('@prisma/client');

const BASE = process.argv[2] ?? 'http://127.0.0.1:4931';
const SOURCE_DB = process.argv[3] ?? 'E:/temp/claude/E--loyalty/f563cfe8-5fe9-4704-8ff7-20f7ac1e703d/scratchpad/prod-drill/walaa.db';
const BACKUP_DIR = process.argv[4] ?? 'E:/loyalty/.walaa-dev/backups';
const SCRATCH = 'E:/temp/claude/E--loyalty/f563cfe8-5fe9-4704-8ff7-20f7ac1e703d/scratchpad';
const ROOT = `${SCRATCH}/recoverdrill`;
const PORT = 4951;
const API = 'E:/loyalty/apps/api';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        ${detail}`);
};
const hardKill = (pid) => {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
};

/**
 * A fingerprint of what the shop actually has.
 *
 * Counts alone would pass a restore that brought back the right NUMBER of customers
 * with the wrong values in them, so every row's identifying fields go into a hash. It
 * is ordered explicitly because SQLite makes no promise about row order and a restored
 * file's page layout differs from its source by construction.
 */
async function fingerprint(dbPath) {
  const db = new PrismaClient({ datasourceUrl: `file:${dbPath}` });
  try {
    const customers = await db.customer.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, phone: true, name: true, category: true },
    });
    const transactions = await db.transaction.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, invoiceId: true, amountGross: true, discountValue: true, amountNet: true, customerId: true },
    });
    const vouchers = await db.voucher.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, code: true, value: true, status: true, customerId: true, transactionId: true },
    });
    const users = await db.user.findMany({ orderBy: { id: 'asc' }, select: { id: true, username: true, role: true } });

    const digest = (rows) =>
      createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16);

    return {
      counts: {
        customers: customers.length,
        transactions: transactions.length,
        vouchers: vouchers.length,
        users: users.length,
      },
      hashes: {
        customers: digest(customers),
        transactions: digest(transactions),
        vouchers: digest(vouchers),
        users: digest(users),
      },
      money: {
        gross: transactions.reduce((a, t) => a + t.amountGross, 0),
        discount: transactions.reduce((a, t) => a + t.discountValue, 0),
        vouchersIssued: vouchers.filter((v) => v.status === 'ISSUED').length,
        vouchersRedeemed: vouchers.filter((v) => v.status === 'REDEEMED').length,
      },
    };
  } finally {
    await db.$disconnect();
  }
}

/**
 * Completes the backup key ceremony (§12.19).
 *
 * A fresh installation refuses to back up until the encryption key has been generated,
 * revealed and typed back — deliberately, because an archive whose key nobody has
 * written down is an archive nobody can open. The first version of this drill did not
 * do it, so `POST /backup/run` correctly refused, no archive was ever written, and both
 * the mid-backup and mid-restore scenarios reported failures that were really the
 * product working as designed.
 *
 * Generating the precondition is the right fix. Skipping the test because the state was
 * inconvenient would have left the two scenarios that matter most unexercised while
 * still printing a result.
 */
async function completeCeremony(base, token) {
  /*
    `content-type` only when there is a body to describe.

    Fastify parses a request by its content-type, so declaring JSON on a body-less POST
    hands the parser an empty string and it answers 400 — for a request that is
    perfectly well formed. `lib/api.ts` carries the same note after the key ceremony
    failed for exactly this reason once already; the first version of this helper
    reproduced the bug, `generate` and `reveal` were refused, and the drill reported a
    backup failure that was its own doing.
  */
  const call = (path, body) =>
    fetch(`${base}/api/v1${path}`, {
      method: 'POST',
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        authorization: `Bearer ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  await call('/backup/key/generate');
  const revealed = await call('/backup/key/reveal');
  if (!revealed.ok) return { ok: false, detail: `reveal: ${revealed.status} ${await revealed.text()}` };
  const { key } = await revealed.json();
  const confirmed = await call('/backup/key/confirm', { key });
  return { ok: confirmed.ok, detail: confirmed.ok ? 'key generated, revealed and confirmed' : `confirm: ${confirmed.status} ${await confirmed.text()}` };
}

const login = async (base, username) => {
  const r = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'Walaa!Dev2026' }),
  });
  return { status: r.status, body: r.ok ? await r.json() : await r.text() };
};

console.log('\nrecovery drill — backup, restore into an empty directory, launch, log in, verify\n');

// ── 1. A real backup, through the running API ──────────────────────────────
let archive;
{
  const before = new Set(existsSync(BACKUP_DIR) ? readdirSync(BACKUP_DIR) : []);
  const auth = await login(BASE, 'owner');
  if (auth.status !== 200) {
    record('takes a backup through the API', false, `could not sign in: ${auth.status} ${auth.body}`);
    process.exit(1);
  }
  // The ceremony must be complete or a backup is refused — see `completeCeremony`.
  const ceremony = await completeCeremony(BASE, auth.body.tokens.accessToken);
  record('the backup key ceremony is complete', ceremony.ok, ceremony.detail);
  const r = await fetch(`${BASE}/api/v1/backup/run`, {
    method: 'POST', headers: { authorization: `Bearer ${auth.body.tokens.accessToken}` },
  });
  const run = await r.json();
  const added = readdirSync(BACKUP_DIR).filter((f) => !before.has(f) && f.endsWith('.walaabk'));
  archive = added.sort().pop() ?? run.name;
  record('takes a backup through the API', r.ok && run.ok === true && Boolean(archive),
    `${archive} · ${run.archiveBytes} bytes encrypted from ${run.snapshotBytes}`);
}

const source = await fingerprint(SOURCE_DB);
record('reads what the shop has, to compare against', true,
  `${source.counts.customers} customers · ${source.counts.transactions} invoices · ` +
  `${source.counts.vouchers} vouchers · ${source.money.gross.toLocaleString()} IQD gross`);

// ── 2. Restore into an EMPTY directory ─────────────────────────────────────
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
const DB = `${ROOT}/walaa.db`;

{
  let ok = false;
  let detail = '';
  try {
    const out = execFileSync(
      'npx',
      ['tsx', 'src/tools/restore-cli.ts', `${BACKUP_DIR}/${archive}`, '--to', DB],
      { cwd: API, encoding: 'utf8', shell: true },
    );
    ok = existsSync(DB);
    detail = (out.match(/فحص السلامة\s+(\S+)/)?.[0] ?? 'restored') + ` -> ${DB}`;
  } catch (error) {
    detail = String(error.stdout ?? error.message).slice(0, 300);
  }
  record('restores into an empty directory', ok, detail);
  if (!ok) process.exit(1);
}

// ── 3 & 4. Launch against it, in production mode, and sign in ──────────────
{
  writeFileSync(
    `${ROOT}/env`,
    readFileSync(`${SCRATCH}/prod-drill/env`, 'utf8')
      .split(/\r?\n/)
      .map((l) =>
        l.startsWith('DATABASE_URL=') ? `DATABASE_URL="file:${DB}"`
        : l.startsWith('API_PORT=') ? `API_PORT=${PORT}`
        : l)
      .join('\n'),
  );

  const child = spawn('npx', ['tsx', 'src/server.ts'], {
    cwd: API,
    env: { ...process.env, WALAA_ENV_FILE: `${ROOT}/env`, WALAA_DATA_DIR: ROOT },
    stdio: 'ignore', shell: true,
  });

  let up = false;
  const until = Date.now() + 50000;
  while (Date.now() < until) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) { up = true; break; } } catch { /* not yet */ }
    await sleep(300);
  }

  let reason = null;
  if (!up && existsSync(`${ROOT}/logs/startup-error.json`)) {
    try { reason = JSON.parse(readFileSync(`${ROOT}/logs/startup-error.json`, 'utf8').replace(/^\uFEFF/, '')).reason; } catch { /* none */ }
  }
  record('the service starts against the restored database, in production mode', up,
    up ? 'identity, integrity and migration set all verified on the restored file'
       : `did not start: ${reason ?? 'no reason recorded'}`);

  if (up) {
    const auth = await login(`http://127.0.0.1:${PORT}`, 'owner');
    record('a real login succeeds against it', auth.status === 200,
      auth.status === 200
        ? `${auth.body.user.name} — ${auth.body.user.role} at ${auth.body.user.merchantName}`
        : `${auth.status} ${String(auth.body).slice(0, 160)}`);
  }
  hardKill(child.pid);
  await sleep(500);
}

// ── 5. The part usually skipped: is the DATA right? ────────────────────────
{
  const restored = await fingerprint(DB);

  const countsMatch = JSON.stringify(source.counts) === JSON.stringify(restored.counts);
  record('every customer, invoice and voucher came back', countsMatch,
    `source ${JSON.stringify(source.counts)} · restored ${JSON.stringify(restored.counts)}`);

  const hashesMatch = JSON.stringify(source.hashes) === JSON.stringify(restored.hashes);
  record('and came back with the same values, row for row', hashesMatch,
    hashesMatch
      ? `identical content hashes for customers, invoices, vouchers and users`
      : `source ${JSON.stringify(source.hashes)} · restored ${JSON.stringify(restored.hashes)}`);

  const moneyMatch = JSON.stringify(source.money) === JSON.stringify(restored.money);
  record('the money adds up to the same total', moneyMatch,
    `gross ${restored.money.gross.toLocaleString()} · discounts ${restored.money.discount.toLocaleString()} · ` +
    `vouchers issued ${restored.money.vouchersIssued} redeemed ${restored.money.vouchersRedeemed}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`}  (${results.length} checks)\n`);
process.exit(failed.length === 0 ? 0 : 1);
