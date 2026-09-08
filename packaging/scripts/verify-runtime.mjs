#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
// machine has no free space (CLAUDE_v3.md §12.1).
const CLEANROOM = join(process.env.WALAA_CLEANROOM_DIR ?? tmpdir(), 'walaa-cleanroom');
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

if (!existsSync(join(STAGE, 'walaa-api.cjs'))) {
  console.error('  staged runtime not found. Run `pnpm --filter @walaa/packaging stage` first.\n');
  process.exit(1);
}

// ── Set up the clean room ───────────────────────────────────────────────────────
rmSync(CLEANROOM, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
cpSync(STAGE, PROGRAM, { recursive: true });
console.log(`  clean room: ${CLEANROOM}`);

// The environment file the installer would have written, with per-installation
// secrets. Note there is no `.env` anywhere above this directory.
const envFile = join(DATA, 'walaa.env');
writeFileSync(
  envFile,
  readFileSync(join(PROGRAM, 'walaa.env.template'), 'utf8')
    // The database name differs by build kind — `walaa.db` for production,
    // `walaa-demo.db` for a demo — so the installer fills this in rather than the
    // template carrying one name that both would have to share. That sharing is what
    // let a demo silently adopt a database it had not placed. This is the production
    // path, so: walaa.db.
    .replace('{{DATABASE_FILE}}', join(DATA, 'walaa.db').replace(/\\/g, '/'))
    .replace('{{DATA_DIR}}', DATA.replace(/\\/g, '/'))
    .replace('{{JWT_ACCESS_SECRET}}', secret())
    .replace('{{JWT_REFRESH_SECRET}}', secret())
    .replace('{{QR_TOKEN_SECRET}}', secret())
    .replace('API_PORT=4000', `API_PORT=${PORT}`),
);

// ── Static checks ───────────────────────────────────────────────────────────────
const bundle = readFileSync(join(PROGRAM, 'walaa-api.cjs'), 'utf8');
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
  WALAA_DATA_DIR: DATA,
  WALAA_ENV_FILE: envFile,
  WALAA_MIGRATIONS_DIR: join(PROGRAM, 'migrations'),
};

const output = [];
const child = spawn(join(PROGRAM, 'node.exe'), ['walaa-api.cjs'], {
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

  check(existsSync(join(DATA, 'walaa.db')), 'the database file was created in the data directory');
  check(
    existsSync(join(DATA, 'walaa.db-wal')),
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

  // Second boot: the migrator must find nothing to do.
  child.kill();
  await sleep(1500);
  const second = spawn(join(PROGRAM, 'node.exe'), ['walaa-api.cjs'], {
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
  await sleep(500);
} catch (error) {
  check(false, 'the staged runtime booted', error instanceof Error ? error.message : String(error));
  console.log('\n--- service output ---\n' + output.join('') + '\n----------------------');
} finally {
  child.kill();
}

/*
  ── A configuration failure must leave a readable reason ─────────────────────

  Configuration is resolved while the module graph is being evaluated, so a missing
  `walaa.env` throws before `main` runs. `server.ts` defers the application behind a
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

  const dead = spawn(join(PROGRAM, 'node.exe'), ['walaa-api.cjs'], {
    cwd: PROGRAM,
    env: {
      ...childEnv,
      WALAA_DATA_DIR: failDir,
      WALAA_ENV_FILE: join(failDir, 'no-such-file.env'),
    },
    windowsHide: true,
  });
  await new Promise((done) => dead.on('exit', done));

  const recorded = join(failDir, 'logs', 'startup-error.json');
  check(existsSync(recorded), 'a module-load failure still records why it could not start');

  if (existsSync(recorded)) {
    const reason = JSON.parse(readFileSync(recorded, 'utf8').replace(/^﻿/, '')).reason ?? '';
    check(
      reason.includes('WALAA_ENV_FILE'),
      'the recorded reason is the real one, not a generic failure',
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
