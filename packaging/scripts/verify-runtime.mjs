#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Clean-room test of the staged runtime.
 *
 * The claim under test is narrow and worth stating exactly: **the staged directory
 * runs on a machine that has no repository, no pnpm store, no global Node and no
 * Prisma CLI, and provisions its own database on first boot.**
 *
 * Two details are what make this an honest test rather than a formality:
 *
 *   1. The runtime is COPIED OUT of the repository first. Left where it is staged,
 *      the development fallback in `config/paths.ts` would walk up and find the repo
 *      `.env`, and the run would pass for a reason that will not exist on a merchant's
 *      machine.
 *   2. The child process gets a CONSTRUCTED environment, not this one. Inheriting the
 *      shell would hand it `DATABASE_URL` and the JWT secrets from the developer's
 *      `.env`, which is precisely what the packaged service must not need.
 */

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const STAGE = join(REPO, 'packaging', 'dist', 'runtime');
// Outside the repository on purpose — see (1) above. `E:` because `C:` on this
// machine has no free space (docs/legacy/CLAUDE_v3.md §12.1).
const CLEANROOM = join(process.env.LOYALTY_CLEANROOM_DIR ?? tmpdir(), 'walaa-cleanroom');
const PROGRAM = join(CLEANROOM, 'program');
const DATA = join(CLEANROOM, 'data');
const PORT = 41234;

let failures = 0;
const check = (ok, description, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${description}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A licence code for the device the staged runtime reports, or null.
 *
 * `LOYALTY_VERIFY_LICENSE_CODE` wins: with the production key embedded, the provider
 * issues one for the build machine and passes it in. Otherwise, and only while the
 * staged module still embeds the DEVELOPMENT key, one is issued here with the committed
 * development issuer — whose codes that build, and no production build, accepts.
 */
function licenceCodeFor(deviceId) {
  if (process.env.LOYALTY_VERIFY_LICENSE_CODE) {
    return { code: process.env.LOYALTY_VERIFY_LICENSE_CODE, source: 'LOYALTY_VERIFY_LICENSE_CODE' };
  }
  delete process.env.VITEST;
  const staged = createRequire(import.meta.url)(join(STAGE, 'node_modules', '@loyalty-pro', 'license-native'));
  const key = staged.keyInfo();
  const issuer = join(REPO, 'tools', 'license-issuer', 'target', 'release', 'license-issuer.exe');
  if (key.kind !== 'development' || !deviceId || !existsSync(issuer)) {
    return { code: null, source: `${key.kind} key, no LOYALTY_VERIFY_LICENSE_CODE` };
  }
  /*
    A copy of the development key with an empty log, every run: `issue` is a device's
    first licence and refuses one this log has already licensed (a renewal is `renew`).
  */
  const home = mkdtempSync(join(tmpdir(), 'walaa-dev-issuer-'));
  copyFileSync(join(REPO, 'tools', 'license-issuer', 'dev-key', 'issuer-key.json'), join(home, 'issuer-key.json'));
  const output = execFileSync(
    issuer,
    ['--home', home, '--password-stdin', 'issue', '--device', deviceId, '--perpetual', '--note', 'verify-runtime'],
    { input: 'walaa-development-only-key\n', encoding: 'utf8' },
  );
  const marker = output.indexOf('Send the merchant this code');
  const code = marker < 0 ? null : output.slice(output.indexOf('\n', marker)).trim();
  return { code, source: 'development issuer' };
}

function secret() {
  return randomBytes(48).toString('base64url');
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt made';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (response.ok) return await response.json();
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`service never became healthy: ${lastError}`);
}

console.log('\nWalaa — clean-room verification of the staged runtime\n');

if (!existsSync(join(STAGE, 'loyalty-pro-api.cjs'))) {
  console.error('  staged runtime not found. Run `pnpm --filter @loyalty-pro/packaging stage` first.\n');
  process.exit(1);
}

// ── Set up the clean room ───────────────────────────────────────────────────────
rmSync(CLEANROOM, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
cpSync(STAGE, PROGRAM, { recursive: true });
console.log(`  clean room: ${CLEANROOM}`);

// The environment file the installer would have written, with per-installation
// secrets. Note there is no `.env` anywhere above this directory.
const envFile = join(DATA, 'loyalty-pro.env');
writeFileSync(
  envFile,
  readFileSync(join(PROGRAM, 'loyalty-pro.env.template'), 'utf8')
    // The database name differs by build kind — `loyalty-pro.db` for production,
    // `loyalty-pro-demo.db` for a demo — so the installer fills this in rather than the
    // template carrying one name that both would have to share. That sharing is what
    // let a demo silently adopt a database it had not placed. This is the production
    // path, so: loyalty-pro.db.
    .replace('{{DATABASE_FILE}}', join(DATA, 'loyalty-pro.db').replace(/\\/g, '/'))
    .replace('{{DATA_DIR}}', DATA.replace(/\\/g, '/'))
    .replace('{{JWT_ACCESS_SECRET}}', secret())
    .replace('{{JWT_REFRESH_SECRET}}', secret())
    .replace('{{QR_TOKEN_SECRET}}', secret())
    .replace('API_PORT=4100', `API_PORT=${PORT}`),
);

// ── Static checks ───────────────────────────────────────────────────────────────
const bundle = readFileSync(join(PROGRAM, 'loyalty-pro-api.cjs'), 'utf8');
check(
  !bundle.includes(REPO) && !bundle.toLowerCase().includes('e:\\\\loyalty'),
  'the bundle embeds no path back into the build machine',
);
check(
  !existsSync(join(PROGRAM, 'node_modules', 'prisma')),
  'the Prisma CLI is not shipped',
  'first-boot migration is done by the service itself',
);

// ── Boot it ─────────────────────────────────────────────────────────────────────
// A constructed environment — see (2) above. `SystemRoot` is required by Windows
// sockets; without it Winsock initialisation fails with a misleading error.
const childEnv = {
  SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
  windir: process.env.windir ?? 'C:\\Windows',
  TEMP: process.env.TEMP ?? CLEANROOM,
  TMP: process.env.TMP ?? CLEANROOM,
  PATH: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
  LOYALTY_DATA_DIR: DATA,
  LOYALTY_ENV_FILE: envFile,
  LOYALTY_MIGRATIONS_DIR: join(PROGRAM, 'migrations'),
};

const output = [];
const child = spawn(join(PROGRAM, 'node.exe'), ['loyalty-pro-api.cjs'], {
  cwd: PROGRAM,
  env: childEnv,
  windowsHide: true,
});
child.stdout.on('data', (chunk) => output.push(chunk.toString()));
child.stderr.on('data', (chunk) => output.push(chunk.toString()));

let exitInfo = null;
child.on('exit', (code, signal) => {
  exitInfo = { code, signal };
});

try {
  const health = await waitForHealth(45_000);
  check(
    health.status === 'ok',
    'GET /health answers ok on a machine-local port',
    JSON.stringify(health),
  );

  check(existsSync(join(DATA, 'loyalty-pro.db')), 'the database file was created in the data directory');
  check(
    existsSync(join(DATA, 'loyalty-pro.db-wal')),
    'WAL mode is active',
    'the -wal sidecar exists (§12.5)',
  );
  /*
    ── The check that used to assert the opposite ────────────────────────────

    This read `includes('database migrations applied')` — first boot was expected to
    migrate, and the check existed to prove the runtime migrator worked without the
    Prisma CLI. That contract is now inverted deliberately: a merchant's machine must
    never migrate. It installs the pre-migrated template the installer ships and then
    verifies it.

    So the assertion is inverted too, and it is the automated guard for the headline
    requirement. Left as it was, it would go green on exactly the behaviour that is no
    longer allowed.
  */
  const firstBoot = output.join('');
  check(
    !firstBoot.includes('database migrations applied'),
    'first boot applied NO migration — the shipped schema is used as-is',
  );
  check(
    firstBoot.includes('installed the shipped database template'),
    'first boot installed the pre-migrated template the installer ships',
  );
  check(
    firstBoot.includes('migration set verified'),
    'the migrations beside the binary are the ones it was built against',
  );
  check(
    firstBoot.includes('database identity verified'),
    'the database that was actually opened was identified and accepted',
  );
  check(
    firstBoot.includes('database integrity verified'),
    'integrity and foreign keys were checked before the first request',
  );

  // The Loyalty Station, served by the API on its own port (§12.3). This is what the
  // tablet browses to; if it 404s, the shop has a station with nothing to open.
  const page = await fetch(`http://127.0.0.1:${PORT}/`);
  const html = page.ok ? await page.text() : '';
  check(
    page.ok && html.includes('<div id="root">'),
    'the API serves the Loyalty Station at /',
    `HTTP ${page.status}`,
  );

  const assetMatch = /\/assets\/([A-Za-z0-9._-]+\.js)/.exec(html);
  if (assetMatch) {
    const asset = await fetch(`http://127.0.0.1:${PORT}/assets/${assetMatch[1]}`);
    check(
      asset.ok,
      'its bundled assets are served too',
      `${assetMatch[1]} -> HTTP ${asset.status}`,
    );
  } else {
    check(false, 'the served page references a bundled asset', 'no /assets/*.js in the HTML');
  }

  // Fonts must be part of that bundle: a shop LAN has no outbound internet (§7.1),
  // and a CDN font tag would silently fall back to a system face on the tablet.
  check(
    !html.includes('fonts.googleapis.com') && !html.includes('fonts.gstatic.com'),
    'the station requests no fonts from the internet',
  );

  // Path traversal through the asset route must not escape the bundle.
  const traversal = await fetch(`http://127.0.0.1:${PORT}/assets/..%2Fmanifest.json`);
  check(
    !traversal.ok,
    'the asset route refuses to escape its directory',
    `HTTP ${traversal.status}`,
  );

  // A protected route must still be protected — the packaged build is not a
  // differently-configured build.
  const unauthorized = await fetch(`http://127.0.0.1:${PORT}/api/v1/customers`);
  check(
    unauthorized.status === 401,
    'auth is enforced in the packaged build',
    `HTTP ${unauthorized.status}`,
  );

  // The native Argon2 addon, exercised through the staged copy rather than assumed
  // from a successful boot.
  const argon2Check = spawn(
    join(PROGRAM, 'node.exe'),
    [
      '-e',
      "const a=require('@node-rs/argon2');" +
        "const h=a.hashSync('kلمة-السر');" +
        "if(!a.verifySync(h,'kلمة-السر')) throw new Error('verify failed');" +
        "if(a.verifySync(h,'wrong')) throw new Error('verified a wrong password');" +
        "console.log('argon2 ok');",
    ],
    { cwd: PROGRAM, env: childEnv, windowsHide: true },
  );
  const argon2Output = await new Promise((resolveOutput) => {
    let text = '';
    argon2Check.stdout.on('data', (c) => (text += c.toString()));
    argon2Check.stderr.on('data', (c) => (text += c.toString()));
    argon2Check.on('exit', () => resolveOutput(text));
  });
  check(
    argon2Output.includes('argon2 ok'),
    'the native Argon2 addon loads and round-trips',
    argon2Output.trim().slice(0, 120),
  );

  /*
    ── Can the staged runtime be SET UP, and can it TRADE? ──────────────────────

    Every check above asks whether the runtime boots correctly. None asked whether a
    merchant can use what booted, and that gap is where three blockers lived: the
    till's account, the capture agent's account and the shop's discount settings were
    all created by `prisma/seed.ts` and by nothing in the product, so the first sale of
    every installation was a 500 while this script printed "all clean-room checks
    passed". A clean boot was standing in for a working shop.

    So the shipped bundle is now driven through the endpoints a merchant's screens and
    the agent call — setup, staff accounts, a customer, a captured invoice, the scan —
    against the database the installer ships. Nothing here writes to SQLite directly.
  */
  {
    const base = `http://127.0.0.1:${PORT}/api/v1`;
    const call = async (method, path, body, token) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await response.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* not JSON */
      }
      return { status: response.status, json, text };
    };
    const signIn = async (username, password) =>
      (await call('POST', '/auth/login', { username, password })).json?.tokens?.accessToken ?? null;

    const setup = await call('POST', '/auth/bootstrap', {
      merchantName: 'متجر فحص التثبيت',
      branchName: 'الفرع الرئيسي',
      branchCode: 'CLN-01',
      ownerName: 'مالك الفحص',
      username: 'cleanowner',
      password: 'Clean-room!2026',
    });
    check(setup.status === 201, 'a new installation can be set up from its first-run screen', `HTTP ${setup.status}`);

    const owner = await signIn('cleanowner', 'Clean-room!2026');
    const staff = owner ? await call('GET', '/users', undefined, owner) : { json: null };
    const branchId = staff.json?.branches?.[0]?.id ?? null;

    const till = await call(
      'POST',
      '/users',
      { name: 'محطة', username: 'station', password: 'Till!2026', role: 'STATION', branchId },
      owner,
    );
    const agentAccount = await call(
      'POST',
      '/users',
      { name: 'التقاط', username: 'agent', password: 'Capture!2026', role: 'AGENT', branchId },
      owner,
    );
    check(
      till.status === 201 && agentAccount.status === 201,
      'the owner can create the till and capture-agent accounts',
      `station ${till.status} · agent ${agentAccount.status}`,
    );

    const station = await signIn('station', 'Till!2026');
    const agent = await signIn('agent', 'Capture!2026');

    // ── Licensing: a new installation is read-only until a code is activated ──
    const licence = await call('GET', '/license', undefined, owner);
    check(
      licence.json?.status === 'UNLICENSED' && licence.json?.readOnly === true && /^WL-/.test(licence.json?.deviceId ?? ''),
      'a new installation starts unlicensed and read-only, and names its device ID',
      `status ${licence.json?.status} · device ${licence.json?.deviceId}`,
    );
    const refused = await call('POST', '/customers', { name: 'زبون الفحص', phone: '07701234567' }, station);
    check(
      refused.status === 423 &&
        refused.json?.error?.code === 'LICENSE_READ_ONLY' &&
        !/[A-Za-z]/.test(refused.json?.error?.message ?? 'x'),
      'an unlicensed till refuses a new customer, with an Arabic sentence',
      `HTTP ${refused.status}`,
    );

    const { code, source } = licenceCodeFor(licence.json?.deviceId);
    if (!code) {
      check(false, 'a licence code for this machine was available to activate', source);
    } else {
      const activation = await call('POST', '/license/activate', { code }, owner);
      check(
        activation.status === 200 && activation.json?.state?.readOnly === false,
        'the owner can activate a licence code, and the installation trades at once',
        `HTTP ${activation.status} · ${activation.json?.state?.status ?? activation.text.slice(0, 160)} · code from ${source}`,
      );
    }

    const customer = await call('POST', '/customers', { name: 'زبون الفحص', phone: '07701234567' }, station);
    const cardNumber = customer.json?.customer?.cardNumber ?? null;
    check(
      customer.status === 201 && Boolean(cardNumber),
      'the till can register a customer and issue a card',
      `HTTP ${customer.status}`,
    );

    const now = new Date().toISOString();
    const capture = await call(
      'POST',
      '/ingest/invoice',
      {
        agentId: 'verify-runtime',
        invoice: {
          invoice_id: 'INV-CLEAN-1',
          amount_gross: 50000,
          currency: 'IQD',
          branch_id: 'CLN-01',
          occurred_at: now,
          captured_at: now,
          capture_mode: 'SPOOL_WATCH',
        },
      },
      agent,
    );
    check(capture.status === 201, 'the capture agent can deliver an invoice', `HTTP ${capture.status}`);

    const identify = await call('POST', '/scan/identify', { barcodeToken: cardNumber }, station);
    const sale = await call(
      'POST',
      '/scan/card',
      { barcodeToken: cardNumber, invoiceId: 'INV-CLEAN-1' },
      station,
    );
    check(
      identify.status === 200 && sale.status < 300,
      'the first sale of a new installation is attributed, not refused',
      `identify ${identify.status} · scan ${sale.status} ${sale.status >= 300 ? sale.text.slice(0, 160) : ''}`,
    );
  }

  // Second boot: the migrator must find nothing to do.
  child.kill();
  await sleep(1500);
  const second = spawn(join(PROGRAM, 'node.exe'), ['loyalty-pro-api.cjs'], {
    cwd: PROGRAM,
    env: childEnv,
    windowsHide: true,
  });
  const secondOutput = [];
  second.stdout.on('data', (chunk) => secondOutput.push(chunk.toString()));
  second.stderr.on('data', (chunk) => secondOutput.push(chunk.toString()));
  await waitForHealth(45_000);
  check(
    !secondOutput.join('').includes('database migrations applied') &&
      !secondOutput.join('').includes('installed the shipped database template'),
    'a restart neither migrates nor re-installs the template',
  );
  second.kill();
  await sleep(1500);

  await recoveryDrill();
} catch (error) {
  check(false, 'the staged runtime booted', error instanceof Error ? error.message : String(error));
  console.log('\n--- service output ---\n' + output.join('') + '\n----------------------');
} finally {
  child.kill();
}

/*
  ── The recovery drill: a paying shop whose licence is destroyed ─────────────

  The operator's first requirement: nothing ordinary may stop a shop that has paid. This
  runs it for real, on the production-mode install above, with nothing but the shipped
  program and the provider's issuer:

    1. destroy the licence — its database rows deleted, the mirror file overwritten;
    2. restart: the shop must be read-only (so the drill is not passing vacuously);
    3. the provider issues a phone code; it is typed in as heard — lower case, spaces;
    4. the very next sale must be recorded, with no restart;
    5. then delete the licensing module itself and restart: the service must start, and
       the shop must keep trading on the last status it recorded.
*/
async function bootService(label) {
  const lines = [];
  const proc = spawn(join(PROGRAM, 'node.exe'), ['loyalty-pro-api.cjs'], { cwd: PROGRAM, env: childEnv, windowsHide: true });
  proc.stdout.on('data', (chunk) => lines.push(chunk.toString()));
  proc.stderr.on('data', (chunk) => lines.push(chunk.toString()));
  try {
    await waitForHealth(45_000);
  } catch (error) {
    console.log(`\n--- ${label} output ---\n${lines.join('')}\n----------------------`);
    throw error;
  }
  return { proc, lines };
}

async function api(method, path, body, token) {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/v1${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: response.status, json, text };
}

// Function declarations throughout, not `const` arrows: the drill is called from the
// main flow above, before any `const` below it has been evaluated.
async function tokenFor(username, password) {
  return (await api('POST', '/auth/login', { username, password })).json?.tokens?.accessToken ?? null;
}

/** A phone code for `deviceId`: from LOYALTY_VERIFY_UNLOCK_CODE, or the development issuer. */
function phoneCodeFor(deviceId) {
  if (process.env.LOYALTY_VERIFY_UNLOCK_CODE) {
    return { code: process.env.LOYALTY_VERIFY_UNLOCK_CODE, source: 'LOYALTY_VERIFY_UNLOCK_CODE' };
  }
  delete process.env.VITEST;
  const key = createRequire(import.meta.url)(join(STAGE, 'node_modules', '@loyalty-pro', 'license-native')).keyInfo();
  const issuer = join(REPO, 'tools', 'license-issuer', 'target', 'release', 'license-issuer.exe');
  if (key.kind !== 'development' || !existsSync(issuer)) {
    return { code: null, source: `${key.kind} key, no LOYALTY_VERIFY_UNLOCK_CODE` };
  }
  const output = execFileSync(
    issuer,
    ['--home', join(REPO, 'tools', 'license-issuer', 'dev-key'), '--password-stdin', 'unlock', '--device', deviceId, '--days', '7', '--note', 'verify-runtime recovery drill'],
    { input: 'walaa-development-only-key\n', encoding: 'utf8' },
  );
  return { code: /\b([2-9A-HJKMNP-TV-Z]{5}-[2-9A-HJKMNP-TV-Z]{5}-[2-9A-HJKMNP-TV-Z]{5})\b/.exec(output)?.[1] ?? null, source: 'development issuer' };
}

/** One sale end to end: a new customer's card, a captured invoice, the scan. */
async function sellOnce(invoiceId, phone) {
  const station = await tokenFor('station', 'Till!2026');
  const agent = await tokenFor('agent', 'Capture!2026');
  const customer = await api('POST', '/customers', { name: 'زبون الاستعادة', phone }, station);
  const card = customer.json?.customer?.cardNumber;
  const now = new Date().toISOString();
  await api(
    'POST',
    '/ingest/invoice',
    {
      agentId: 'verify-runtime',
      invoice: { invoice_id: invoiceId, amount_gross: 30000, currency: 'IQD', branch_id: 'CLN-01', occurred_at: now, captured_at: now, capture_mode: 'SPOOL_WATCH' },
    },
    agent,
  );
  const sale = card ? await api('POST', '/scan/card', { barcodeToken: card, invoiceId }, station) : customer;
  return { customer: customer.status, sale: sale.status, text: sale.text.slice(0, 160) };
}

async function recoveryDrill() {
  // 1. Destroy the licence while the service is stopped.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(DATA, 'loyalty-pro.db'));
  db.exec('DELETE FROM license_activation; DELETE FROM license_unlock;');
  db.close();
  writeFileSync(join(DATA, 'license-codes.json'), '   destroyed');

  // 2. The shop must now be read-only — or the drill proves nothing.
  const third = await bootService('recovery drill');
  const owner = await tokenFor('cleanowner', 'Clean-room!2026');
  const destroyed = await api('GET', '/license', undefined, owner);
  const deviceId = destroyed.json?.deviceId;
  check(
    destroyed.json?.readOnly === true,
    'drill: with its licence destroyed, the shop is read-only',
    `status ${destroyed.json?.status}`,
  );
  const refused = await sellOnce('INV-DRILL-0', '07701230000');
  check(refused.customer === 423, 'drill: and refuses a sale', `HTTP ${refused.customer}`);

  // 3. The phone call.
  const { code, source } = phoneCodeFor(deviceId);
  if (!code) {
    check(false, 'drill: a phone code for this machine was available', source);
    third.proc.kill();
    return;
  }
  // With the production key the provider supplies this machine's code in the environment,
  // and `phoneCodeFor` would hand back that same code for any device — accepted, because it
  // IS this machine's. Another shop's code has to be issued for another shop.
  const other = process.env.LOYALTY_VERIFY_UNLOCK_CODE
    ? (process.env.LOYALTY_VERIFY_OTHER_UNLOCK_CODE ?? null)
    : phoneCodeFor('WL-2222-2222').code;
  const wrongShop = other ? await api('POST', '/license/unlock', { code: other }, owner) : { status: 0, json: null };
  check(
    wrongShop.status === 422 && wrongShop.json?.error?.details?.reason === 'NOT_VALID',
    'drill: a phone code for another shop is refused',
    `HTTP ${wrongShop.status}`,
  );
  const spoken = code.toLowerCase().replace(/-/g, ' ');
  const entered = await api('POST', '/license/unlock', { code: spoken }, owner);
  check(
    entered.status === 200 && entered.json?.state?.status === 'EMERGENCY' && entered.json?.state?.readOnly === false,
    'drill: the phone code, typed as heard, restores full operation',
    `HTTP ${entered.status} · ${entered.json?.state?.status ?? entered.text.slice(0, 160)} · "${spoken}" from ${source}`,
  );

  // 4. No restart.
  const restored = await sellOnce('INV-DRILL-1', '07701230001');
  check(
    restored.customer === 201 && restored.sale < 300,
    'drill: the very next sale is recorded, with no restart',
    `customer ${restored.customer} · scan ${restored.sale} ${restored.sale >= 300 ? restored.text : ''}`,
  );
  const events = existsSync(join(DATA, 'license-events.log')) ? readFileSync(join(DATA, 'license-events.log'), 'utf8') : '';
  check(
    events.includes('license.unlock_entered') && events.includes('license.unlock_failed'),
    'drill: both phone-code attempts are in the licence events file',
  );
  third.proc.kill();
  await sleep(1500);

  // 5. A broken installation: the licensing module itself is gone.
  rmSync(join(PROGRAM, 'node_modules', '@loyalty-pro', 'license-native', 'loyalty-pro-license.node'), { force: true });
  const fourth = await bootService('missing licensing module');
  const degraded = await api('GET', '/license', undefined, await tokenFor('cleanowner', 'Clean-room!2026'));
  check(
    degraded.json?.degraded === true && degraded.json?.readOnly === false,
    'drill: with the licensing module deleted, the service still starts and the shop still trades',
    `status ${degraded.json?.status} · degraded ${degraded.json?.degraded}`,
  );
  const stillSelling = await sellOnce('INV-DRILL-2', '07701230002');
  check(
    stillSelling.customer === 201 && stillSelling.sale < 300,
    'drill: a sale is recorded on the last recorded status',
    `customer ${stillSelling.customer} · scan ${stillSelling.sale}`,
  );
  fourth.proc.kill();
  await sleep(500);
}


/*
  ── A configuration failure must leave a readable reason ─────────────────────

  Configuration is resolved while the module graph is being evaluated, so a missing
  `loyalty-pro.env` throws before `main` runs. `server.ts` defers the application behind a
  dynamic import specifically so that throw is catchable and gets written down — and
  that only works if the bundler keeps the import lazy rather than hoisting it.

  "esbuild currently wraps lazily-imported modules in an initialiser" is a claim about
  a build tool's behaviour under a configuration nobody re-checks. It was already false
  once in spirit: the recorder sat inside `main().catch`, covered nothing in front of
  it, and a demo install died with `exit code: 1` and no cause. So the property is
  checked against the built artefact, not the source.
*/
{
  const failDir = join(CLEANROOM, 'bootfail');
  mkdirSync(join(failDir, 'logs'), { recursive: true });

  const dead = spawn(join(PROGRAM, 'node.exe'), ['loyalty-pro-api.cjs'], {
    cwd: PROGRAM,
    env: {
      ...childEnv,
      LOYALTY_DATA_DIR: failDir,
      LOYALTY_ENV_FILE: join(failDir, 'no-such-file.env'),
    },
    windowsHide: true,
  });
  await new Promise((done) => dead.on('exit', done));

  const recorded = join(failDir, 'logs', 'startup-error.json');
  check(existsSync(recorded), 'a module-load failure still records why it could not start');

  if (existsSync(recorded)) {
    const reason = JSON.parse(readFileSync(recorded, 'utf8').replace(/^﻿/, '')).reason ?? '';
    /*
      This asserted `reason.includes('LOYALTY_ENV_FILE')` — that the sentence the merchant
      reads contained an English environment-variable name. A check that REQUIRES the
      leak is the clearest kind of proxy: it measured "the message is specific" by the
      presence of a token nobody at the counter can read, and it would have failed the
      moment the sentence was fixed.

      What is actually wanted: the reason names the real cause in Arabic, and carries no
      variable name and no Windows path.
    */
    check(
      reason.includes('ملف إعدادات البرنامج') &&
        !/LOYALTY_|[A-Za-z]:[\\/]/.test(reason),
      'the recorded reason names the real cause in Arabic, with no variable name or path',
      reason,
    );
    // The merchant reads this file through the dashboard. A BOM-less UTF-8 file is
    // read as ANSI by PowerShell 5.1 and Notepad, which turns the Arabic to mojibake.
    check(
      readFileSync(recorded, 'utf8').charCodeAt(0) === 0xfeff,
      'the reason file carries a BOM so Arabic survives Notepad and Get-Content',
    );
  }
}

if (exitInfo && exitInfo.code !== null && exitInfo.code !== 0 && failures === 0) {
  check(false, 'the service exited cleanly', JSON.stringify(exitInfo));
}

console.log(
  failures === 0 ? '\n  all clean-room checks passed\n' : `\n  ${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
