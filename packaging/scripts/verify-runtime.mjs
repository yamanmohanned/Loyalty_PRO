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
  check(
    output.join('').includes('database migrations applied'),
    'migrations were applied at first boot, without the Prisma CLI',
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
    !secondOutput.join('').includes('database migrations applied'),
    'a restart applies nothing — the migrator is idempotent',
  );
  second.kill();
  await sleep(500);
} catch (error) {
  check(false, 'the staged runtime booted', error instanceof Error ? error.message : String(error));
  console.log('\n--- service output ---\n' + output.join('') + '\n----------------------');
} finally {
  child.kill();
}

if (exitInfo && exitInfo.code !== null && exitInfo.code !== 0 && failures === 0) {
  check(false, 'the service exited cleanly', JSON.stringify(exitInfo));
}

console.log(
  failures === 0 ? '\n  all clean-room checks passed\n' : `\n  ${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
