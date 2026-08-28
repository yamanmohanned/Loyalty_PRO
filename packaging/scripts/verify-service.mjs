#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Exercises the service host without a Service Control Manager.
 *
 * Registering a Windows Service needs `SeCreateServicePrivilege`, which a normal
 * developer shell does not have — so the SCM path is verified by hand from an
 * elevated prompt (see packaging/README.md). Everything that does NOT require
 * elevation is verified here, and that is most of the interesting behaviour:
 * per-installation secret generation, configuration hardening, log files,
 * supervision, crash recovery, and the stdin-close shutdown handshake.
 */

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const STAGE = join(REPO, 'packaging', 'dist', 'runtime');
const CLEANROOM = join(process.env.WALAA_CLEANROOM_DIR ?? tmpdir(), 'walaa-cleanroom-service');
const PROGRAM = join(CLEANROOM, 'program');
const DATA = join(CLEANROOM, 'data');
const PORT = 41235;
const USER = process.env.USERNAME ?? 'user';

let failures = 0;
const check = (ok, description, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${description}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** icacls, best effort — used both by the assertions and by the cleanup. */
function icacls(args) {
  try {
    return execFileSync('icacls', args, { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
}

/**
 * Removes a previous clean room.
 *
 * The configuration file from an earlier run has had inherited access stripped, so
 * an ordinary delete fails with EPERM. This is the correct behaviour under test, not
 * a bug — the owner re-grant is how the test tidies up after it.
 */
function removeCleanroom() {
  if (!existsSync(CLEANROOM)) return;
  icacls([CLEANROOM, '/grant', `${USER}:(F)`, '/T', '/C', '/Q']);
  rmSync(CLEANROOM, { recursive: true, force: true });
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  return false;
}

console.log('\nWalaa — service host verification (unelevated surface)\n');

if (!existsSync(join(STAGE, 'walaa-service.exe'))) {
  console.error('  walaa-service.exe not staged. Run `pnpm --filter @walaa/packaging stage`.\n');
  process.exit(1);
}

removeCleanroom();
mkdirSync(DATA, { recursive: true });
cpSync(STAGE, PROGRAM, { recursive: true });
const serviceExe = join(PROGRAM, 'walaa-service.exe');
console.log(`  clean room: ${CLEANROOM}`);

// ── Install, unelevated ─────────────────────────────────────────────────────────
// Expected to fail at the Service Control Manager — but only AFTER writing the
// configuration, which is the part testable without elevation.
let installOutput = '';
let installFailed = false;
try {
  installOutput = execFileSync(
    serviceExe,
    ['install', '--data-dir', DATA, '--port', String(PORT)],
    {
      encoding: 'utf8',
      stdio: 'pipe',
    },
  );
} catch (error) {
  installFailed = true;
  installOutput = `${error.stdout ?? ''}${error.stderr ?? ''}`;
}

check(
  installFailed && /Administrator/i.test(installOutput),
  'install refuses without elevation, and says why',
  installOutput.split('\n').filter(Boolean).pop()?.trim().slice(0, 100),
);

const envFile = join(DATA, 'walaa.env');
check(existsSync(envFile), 'a configuration file was generated for this installation');

// The hardening is proven by being inconvenient: this process created the file and
// can no longer read it, because `install` stripped inherited access down to SYSTEM
// (the service account) and Administrators. Ownership survives, so the test re-grants
// itself access to inspect the contents — which a plain user account could not do.
let readBlocked = false;
try {
  readFileSync(envFile, 'utf8');
} catch (error) {
  readBlocked = error.code === 'EPERM' || error.code === 'EACCES';
}
check(readBlocked, 'the signing keys are unreadable to a user who is neither SYSTEM nor an admin');

const aclBefore = icacls([envFile]);
check(
  !/BUILTIN\\Users|\bEveryone\b|Authenticated Users/i.test(aclBefore),
  'no group-wide access is left on the configuration file',
  aclBefore.split('\n').filter(Boolean).slice(1, 4).join(' | ').slice(0, 160),
);

icacls([envFile, '/grant', `${USER}:(R,W)`]);
const envText = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';

const secrets = [
  ...envText.matchAll(/^(JWT_ACCESS_SECRET|JWT_REFRESH_SECRET|QR_TOKEN_SECRET)=(.+)$/gm),
];
check(secrets.length === 3, 'all three secrets are present', `${secrets.length}/3`);
check(
  secrets.every(([, , value]) => /^[0-9a-f]{64}$/.test(value.trim())),
  'each secret is 32 bytes of randomness, not a shipped default',
);
check(
  new Set(secrets.map(([, , value]) => value)).size === 3,
  'the three secrets differ from each other',
);
check(
  envText.includes(`DATABASE_URL="file:${DATA.replace(/\\/g, '/')}/walaa.db"`),
  'the database is placed in the data directory, not under Program Files',
);
check(
  envText.includes(`API_PORT=${PORT}`),
  'the requested port was written into the configuration',
);

// ── Console mode: supervision, recovery, shutdown ───────────────────────────────
const host = spawn(serviceExe, ['console', '--data-dir', DATA], {
  cwd: PROGRAM,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
const hostOutput = [];
host.stdout.on('data', (c) => hostOutput.push(c.toString()));
host.stderr.on('data', (c) => hostOutput.push(c.toString()));

let hostExit = null;
host.on('exit', (code) => {
  hostExit = code;
});

const serviceLog = () => {
  const path = join(DATA, 'logs', 'service.log');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
};

try {
  check(await waitForHealth(45_000), 'the host starts the API and it answers /health');
  check(existsSync(join(DATA, 'logs', 'api.log')), 'API output is captured to logs/api.log');
  check(serviceLog().includes('api started'), 'the host keeps its own log');

  // Kill the API out from under the host. A shop must not need someone to notice.
  const children = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      // Filtered by name: Windows also attaches a conhost.exe child to a console
      // process, and it is not what we are counting.
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${host.pid} AND Name='node.exe'" | Select-Object -ExpandProperty ProcessId`,
    ],
    { encoding: 'utf8' },
  )
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);

  if (
    check(
      children.length === 1,
      'the host runs exactly one API process',
      `pids: ${children.join(', ')}`,
    )
  ) {
    execFileSync('taskkill', ['/PID', String(children[0]), '/F'], { stdio: 'pipe' });
    await sleep(1000);
    check(await waitForHealth(45_000), 'the API is restarted automatically after a crash');
    check(
      serviceLog().includes('api exited unexpectedly'),
      'the crash is recorded in the host log',
    );
  }

  // The stop handshake: closing the host's stdin is what the SCM stop path does.
  host.stdin.end();
  const stopDeadline = Date.now() + 40_000;
  while (hostExit === null && Date.now() < stopDeadline) await sleep(200);

  check(hostExit !== null, 'the host exits when asked to stop', `exit code ${hostExit}`);
  check(
    serviceLog().includes('api exited cleanly'),
    'the API shut down gracefully rather than being terminated',
  );
  check(!(await waitForHealth(2_000)), 'nothing is left listening on the port');
} catch (error) {
  check(false, 'console mode ran', error instanceof Error ? error.message : String(error));
  console.log(`\n--- host output ---\n${hostOutput.join('')}\n-------------------`);
  console.log(`--- service log ---\n${serviceLog()}\n-------------------`);
} finally {
  if (hostExit === null) host.kill();
}

console.log(
  failures === 0 ? '\n  all service-host checks passed\n' : `\n  ${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
