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
const CLEANROOM = join(process.env.LOYALTY_CLEANROOM_DIR ?? tmpdir(), 'loyalty-pro-cleanroom-service');
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

/** Any access entry that would let an ordinary local account read the data. */
/**
 * Does this icacls output grant access to an ordinary local account?
 *
 * Checked with plain string containment rather than a pattern: the entries of
 * interest read `BUILTIN\\Users:(I)(RX)`, and a regex for them needs escaped
 * backslashes, which is exactly the kind of literal that has silently lost a level of
 * escaping in this repository before now.
 */
function grantsGroupWideAccess(acl) {
  const upper = acl.toUpperCase();
  return (
    upper.includes('USERS:') || upper.includes('EVERYONE') || upper.includes('AUTHENTICATED USERS')
  );
}

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

if (!existsSync(join(STAGE, 'loyalty-pro-service.exe'))) {
  console.error('  loyalty-pro-service.exe not staged. Run `pnpm --filter @loyalty-pro/packaging stage`.\n');
  process.exit(1);
}

removeCleanroom();
mkdirSync(DATA, { recursive: true });
cpSync(STAGE, PROGRAM, { recursive: true });
const serviceExe = join(PROGRAM, 'loyalty-pro-service.exe');
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

// The data directory as a whole, not only the configuration file. Files created under
// `%PROGRAMDATA%` inherit `BUILTIN\\Users:(RX)` — measured on this machine, not
// assumed — so without the lockdown the database of customer names and phone numbers
// is readable by every local account.
const dataAcl = icacls([DATA]);
check(
  !grantsGroupWideAccess(dataAcl),
  'the data directory is locked to SYSTEM and Administrators',
  dataAcl.split('\n').filter(Boolean).slice(1, 4).join(' | ').slice(0, 160),
);

const envFile = join(DATA, 'loyalty-pro.env');

// Unreadable, and not merely absent: `existsSync` cannot be used as the gate here,
// because the directory lockdown removes traverse rights and a stat of the file fails
// the same way a missing file does.
let readBlocked = false;
try {
  readFileSync(envFile, 'utf8');
} catch (error) {
  readBlocked = error.code === 'EPERM' || error.code === 'EACCES';
}
check(readBlocked, 'the signing keys are unreadable to a user who is neither SYSTEM nor an admin');

// In production the service runs as SYSTEM and the installer runs elevated, so both
// keep Full control. This test is neither, so it uses the one right an owner always
// retains — rewriting the ACL — to inspect what the installer left behind.
const regrant = icacls([DATA, '/grant', `${USER}:(OI)(CI)(F)`, '/T', '/C', '/Q']);
// The configuration file needs its own re-grant: `install` disabled inheritance on it,
// so it does not pick up anything granted on the directory — belt and braces working as
// designed, and worth knowing before someone tries to fix a permissions problem by
// changing the folder alone.
icacls([envFile, '/grant', `${USER}:(R,W)`]);
check(
  existsSync(envFile),
  'the directory owner can re-grant itself access, and the configuration is there',
  regrant.split('\n').filter(Boolean).pop()?.trim().slice(0, 80),
);

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
  envText.includes(`DATABASE_URL="file:${DATA.replace(/\\/g, '/')}/loyalty-pro.db"`),
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

  // The database the service actually created, rather than the directory it was told
  // to create it in. The only non-inherited entry here is this test's own re-grant.
  const databaseAcl = icacls([join(DATA, 'loyalty-pro.db')]);
  check(
    existsSync(join(DATA, 'loyalty-pro.db')) && !grantsGroupWideAccess(databaseAcl),
    'the customer database is not readable by ordinary local accounts',
    databaseAcl.split('\n').filter(Boolean).slice(1, 4).join(' | ').slice(0, 160),
  );
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
