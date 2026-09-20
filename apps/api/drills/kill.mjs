#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  KILL DRILL — what a power cut looks like, at each moment it could happen
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   node drills/kill.mjs [rounds]
 *
 * Every kill here is `taskkill /T /F` — TerminateProcess on the whole tree. No signal
 * handler runs, nothing is flushed, nothing is unwound. That is the closest thing to
 * pulling the plug that can be arranged from software, and it is what happens in a shop
 * when the power goes.
 *
 * ── Run in production mode, against a production-provisioned database ────────
 *
 * The drill provisions its own data directory the way an installer does — an empty
 * folder, booted once so the shipped template is installed and stamped — then seeds it.
 * `NODE_ENV=production`, so the identity and integrity gates are ENFORCING rather than
 * merely logging, which is the configuration whose behaviour is actually in question.
 *
 * ── What is asked after each kill ────────────────────────────────────────────
 *
 * Does the file open at all; `PRAGMA integrity_check`; `PRAGMA foreign_key_check`; and
 * then the three shapes this schema can be corrupted into that a page check would call
 * perfectly healthy:
 *
 *   - a voucher whose transaction is gone
 *   - a discounted sale with no voucher to explain the discount
 *   - the same invoice recorded twice
 *
 * A half-recorded sale is the worst outcome this system can produce, so the drill
 * reports the state it found rather than a verdict alone.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('E:/loyalty/apps/api/package.json');
const { PrismaClient } = require('@prisma/client');

const ROUNDS = Number(process.argv[2] ?? 4);
const PORT = 4941;
const SCRATCH = 'E:/temp/claude/E--loyalty/f563cfe8-5fe9-4704-8ff7-20f7ac1e703d/scratchpad';
const ROOT = `${SCRATCH}/killdrill`;
const DB = `${ROOT}/loyalty-pro.db`;
const ENV = `${ROOT}/env`;
const BACKUPS = `${ROOT}/backups`;
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

const start = (extraEnv = {}) =>
  spawn('npx', ['tsx', 'src/server.ts'], {
    cwd: API,
    env: { ...process.env, LOYALTY_ENV_FILE: ENV, LOYALTY_DATA_DIR: ROOT, ...extraEnv },
    stdio: 'ignore',
    shell: true,
  });

const healthy = async (ms = 45000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return true; } catch { /* not yet */ }
    await sleep(300);
  }
  return false;
};

const TOKENS = `${ROOT}/tokens.json`;
const login = async (username) => {
  let cache = {};
  if (existsSync(TOKENS)) { try { cache = JSON.parse(readFileSync(TOKENS, 'utf8')); } catch { cache = {}; } }
  if (cache[username]) {
    const probe = await fetch(`http://127.0.0.1:${PORT}/api/v1/backup/drive/connect/status`, {
      headers: { authorization: `Bearer ${cache[username]}` },
    });
    if (probe.status !== 401) return cache[username];
  }
  const r = await fetch(`http://127.0.0.1:${PORT}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'Walaa!Dev2026' }),
  });
  if (!r.ok) throw new Error(`login ${username}: ${r.status} ${await r.text()}`);
  const token = (await r.json()).tokens.accessToken;
  cache[username] = token;
  writeFileSync(TOKENS, JSON.stringify(cache), 'utf8');
  return token;
};

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

/** Everything the file could be wrong in, including the ways a page check cannot see. */
async function inspect() {
  if (!existsSync(DB)) return { opened: false };
  const db = new PrismaClient({ datasourceUrl: `file:${DB}` });
  try {
    const integrity = await db.$queryRawUnsafe('PRAGMA integrity_check');
    const fk = await db.$queryRawUnsafe('PRAGMA foreign_key_check');
    const orphanVouchers = await db.$queryRawUnsafe(
      `SELECT COUNT(*) AS n FROM voucher v
         LEFT JOIN "transaction" t ON t.id = v.transaction_id WHERE t.id IS NULL`,
    );
    const discountNoVoucher = await db.$queryRawUnsafe(
      `SELECT COUNT(*) AS n FROM "transaction" t
         LEFT JOIN voucher v ON v.transaction_id = t.id
        WHERE t.discount_value > 0 AND v.id IS NULL`,
    );
    const duplicateInvoices = await db.$queryRawUnsafe(
      `SELECT COUNT(*) AS n FROM (
         SELECT invoice_id FROM "transaction" GROUP BY merchant_id, branch_id, invoice_id HAVING COUNT(*) > 1)`,
    );
    return {
      opened: true,
      integrity: integrity[0]?.integrity_check ?? '?',
      fkViolations: fk.length,
      orphanVouchers: Number(orphanVouchers[0].n),
      discountWithoutVoucher: Number(discountNoVoucher[0].n),
      duplicateInvoices: Number(duplicateInvoices[0].n),
      transactions: await db.transaction.count(),
      vouchers: await db.voucher.count(),
      customers: await db.customer.count(),
    };
  } finally {
    await db.$disconnect();
  }
}

const clean = (s) =>
  s.opened &&
  s.integrity === 'ok' &&
  s.fkViolations === 0 &&
  s.orphanVouchers === 0 &&
  s.discountWithoutVoucher === 0 &&
  s.duplicateInvoices === 0;

const describe = (s) =>
  s.opened
    ? `integrity=${s.integrity} fk=${s.fkViolations} orphanVouchers=${s.orphanVouchers} ` +
      `discountWithoutVoucher=${s.discountWithoutVoucher} duplicateInvoices=${s.duplicateInvoices} ` +
      `rows=${s.transactions}/${s.vouchers}/${s.customers}`
    : 'the database file could not be opened';

// ── Provision, the way the installer does ──────────────────────────────────
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

console.log(`\nkill drill — production mode, ${ROUNDS} rounds per point\n`);

{
  const boot = start();
  const up = await healthy();
  hardKill(boot.pid);
  await sleep(600);
  record('provisions itself the way the installer does', up,
    up ? 'template installed and identity stamped on an empty directory' : 'first boot never became healthy');
  if (!up) process.exit(1);
}

execFileSync('npx', ['dotenv', '-e', '../../.env', '-v', `DATABASE_URL=file:${DB}`, '--', 'tsx', 'prisma/seed.ts'],
  { cwd: API, stdio: 'ignore', shell: true });
record('seeded', true, describe(await inspect()));

{
  const child = start();
  const up = await healthy();
  let outcome = { ok: false, detail: 'the API did not start for the ceremony' };
  if (up) outcome = await completeCeremony(`http://127.0.0.1:${PORT}`, await login('owner'));
  hardKill(child.pid);
  await sleep(500);
  record('completes the backup key ceremony, so backups are permitted', outcome.ok, outcome.detail);
}

// ── 1 & 2. Killed mid-ingest, and killed mid-redeem ────────────────────────
for (const scenario of ['ingest', 'redeem']) {
  let worst = null;
  let rounds = 0;

  for (let round = 1; round <= ROUNDS; round += 1) {
    const child = start();
    if (!(await healthy())) { worst = 'the API did not restart'; hardKill(child.pid); break; }

    const agent = await login(scenario === 'ingest' ? 'agent' : 'owner');
    const db = new PrismaClient({ datasourceUrl: `file:${DB}` });
    const branch = await db.branch.findFirst({ select: { id: true, code: true } });
    const merchant = await db.merchant.findFirst({ select: { id: true } });
    const customer = await db.customer.findFirst({ select: { id: true } });

    let stop = false;
    const firing = (async () => {
      let n = 0;
      while (!stop) {
        n += 1;
        if (scenario === 'ingest') {
          const now = new Date().toISOString();
          fetch(`http://127.0.0.1:${PORT}/api/v1/ingest/invoice`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${agent}` },
            body: JSON.stringify({
              invoice: {
                invoice_id: `KILL-${scenario}-${round}-${n}-${Date.now()}`,
                amount_gross: 150000, currency: 'IQD', branch_id: branch.code,
                occurred_at: now, captured_at: now, capture_mode: 'SPOOL_WATCH',
              },
            }),
          }).catch(() => {});
        } else {
          // A fresh voucher each time, so the kill lands inside a redemption rather
          // than inside a refusal of an already-redeemed one.
          const tx = await db.transaction.create({
            data: {
              merchantId: merchant.id, branchId: branch.id, customerId: customer.id,
              invoiceId: `KILL-V-${round}-${n}-${Date.now()}`,
              amountGross: 100000, discountValue: 3000, amountNet: 97000, currency: 'IQD',
              occurredAt: new Date(), captureMode: 'SPOOL_WATCH', capturedAt: new Date(),
            },
          }).catch(() => null);
          if (tx) {
            const v = await db.voucher.create({
              data: {
                merchantId: merchant.id, transactionId: tx.id, customerId: customer.id,
                code: `KIL${round}${n}${Date.now().toString(36).toUpperCase()}`,
                value: 3000, settlementStrategy: 'MERCHANT_DEFINED', status: 'ISSUED',
              }, select: { id: true },
            }).catch(() => null);
            if (v) {
              fetch(`http://127.0.0.1:${PORT}/api/v1/vouchers/${v.id}/redeem`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${agent}` },
                body: '{}',
              }).catch(() => {});
            }
          }
        }
        await sleep(scenario === 'ingest' ? 6 : 40);
      }
    })();

    await sleep(900 + Math.floor(Math.random() * 900));
    hardKill(child.pid);
    stop = true;
    await firing.catch(() => {});
    await db.$disconnect().catch(() => {});
    await sleep(600);

    const state = await inspect();
    rounds += 1;
    console.log(`    round ${round}: ${describe(state)}`);
    if (!clean(state)) worst = describe(state);
  }

  record(`killed mid-${scenario} (${rounds} rounds)`, worst === null,
    worst ?? 'every round left the database sound');
}

// ── 3. Killed mid-backup ───────────────────────────────────────────────────
{
  const before = new Set(readdirSync(BACKUPS).filter((f) => f.endsWith('.walaabk')));
  const child = start();
  const up = await healthy();
  let detail = 'the API did not start';
  let ok = false;

  if (up) {
    const token = await login('owner');
    let stop = false;
    const loop = (async () => {
      while (!stop) {
        await fetch(`http://127.0.0.1:${PORT}/api/v1/backup/run`, {
          method: 'POST', headers: { authorization: `Bearer ${token}` },
        }).catch(() => {});
      }
    })();
    await sleep(700);
    hardKill(child.pid);
    stop = true;
    await loop.catch(() => {});
    await sleep(700);

    /*
      Archives only. The destination keeps a `.staging` DIRECTORY beside them, and an
      earlier version of this check measured its size — directories report 0 — and
      reported a truncated backup that did not exist. A drill that cries wolf about the
      thing it is guarding is worse than no drill.
    */
    const after = readdirSync(BACKUPS);
    const archives = after.filter((f) => f.endsWith('.walaabk'));
    const added = archives.filter((f) => !before.has(f));
    const partials = after.filter((f) => f.includes('.partial') || f.includes('.tmp'));
    const tiny = added.filter((f) => statSync(`${BACKUPS}/${f}`).size < 1024);
    const state = await inspect();

    const revived = start();
    const back = await healthy();
    let nextOk = false;
    if (back) {
      const t2 = await login('owner');
      const r = await fetch(`http://127.0.0.1:${PORT}/api/v1/backup/run`, {
        method: 'POST', headers: { authorization: `Bearer ${t2}` },
      });
      nextOk = r.ok && (await r.json()).ok === true;
    }
    hardKill(revived.pid);
    await sleep(400);

    ok = partials.length === 0 && tiny.length === 0 && back && nextOk && clean(state);
    detail = `archives=${added.length} partials=${partials.length} truncated=${tiny.length} ` +
      `restarts=${back ? 'yes' : 'no'} nextBackup=${nextOk ? 'ok' : 'no'} · ${describe(state)}`;
  } else {
    hardKill(child.pid);
  }
  record('killed mid-backup', ok, detail);
}

// ── 4. Killed mid-restore ──────────────────────────────────────────────────
{
  const archive = readdirSync(BACKUPS).filter((f) => f.endsWith('.walaabk')).sort().pop();
  const target = `${ROOT}/restored.db`;
  writeFileSync(target, 'SENTINEL-NOT-A-DATABASE');
  const before = readFileSync(target, 'utf8');

  const rc = spawn('npx', ['tsx', 'src/tools/restore-cli.ts', `${BACKUPS}/${archive}`, '--to', target, '--force'],
    { cwd: API, stdio: 'ignore', shell: true });
  await sleep(1300);
  hardKill(rc.pid);
  await sleep(500);

  const after = existsSync(target) ? readFileSync(target, 'utf8') : '(gone)';
  const partials = readdirSync(ROOT).filter((f) => f.includes('.partial'));
  let later = false;
  try {
    execFileSync('npx', ['tsx', 'src/tools/restore-cli.ts', `${BACKUPS}/${archive}`, '--to', target, '--force'],
      { cwd: API, stdio: 'ignore', shell: true });
    later = statSync(target).size > 100000;
  } catch { later = false; }

  record('killed mid-restore', after === before && partials.length === 0 && later,
    `destination unchanged=${after === before} partialsLeft=${partials.length} laterRestoreWorks=${later}`);
}

// ── 5. Mid-migration ───────────────────────────────────────────────────────
//
// Production does not migrate at all — it installs a pre-migrated template and refuses
// if anything is pending — so the interesting question is not "what does a kill do to a
// migration" but "can a migration happen here at all". Both are answered.
{
  const db = new PrismaClient({ datasourceUrl: `file:${DB}` });
  const victim = (await db.$queryRawUnsafe(
    'SELECT migration_name FROM "_prisma_migrations" ORDER BY migration_name DESC LIMIT 1'))[0].migration_name;
  await db.$executeRawUnsafe(
    'UPDATE "_prisma_migrations" SET finished_at = NULL WHERE migration_name = ?', victim);
  await db.$disconnect();

  const child = start();
  const up = await healthy(25000);
  hardKill(child.pid);
  await sleep(400);

  let reason = null;
  const errPath = `${ROOT}/logs/startup-error.json`;
  if (existsSync(errPath)) {
    try { reason = JSON.parse(readFileSync(errPath, 'utf8').replace(/^\uFEFF/, '')).reason; } catch { /* none */ }
  }
  const refused = !up && Boolean(reason);
  record('a half-applied migration is refused, not ignored', refused,
    refused ? String(reason).slice(0, 190) : `service came up=${up} reason=${reason ?? 'none recorded'}`);

  // Put it back, so the drill leaves a usable database behind.
  const fix = new PrismaClient({ datasourceUrl: `file:${DB}` });
  await fix.$executeRawUnsafe(
    'UPDATE "_prisma_migrations" SET finished_at = CURRENT_TIMESTAMP WHERE migration_name = ?', victim);
  await fix.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`}  (${results.length} checks)\n`);
process.exit(failed.length === 0 ? 0 : 1);
