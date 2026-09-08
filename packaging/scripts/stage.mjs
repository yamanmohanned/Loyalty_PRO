#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/**
 * Stages everything the API service needs to run on a machine that has no Node, no
 * pnpm, no repository and no Prisma CLI (CLAUDE_v3.md §12.3).
 *
 * The output directory is what the NSIS installer ships as `runtime/`. Nothing in it
 * may point back at this repository or at the developer's global installs — that is
 * the property the whole spike exists to establish, and `verify-runtime.mjs` proves
 * it by running the staged bundle from a copy with the workspace made unreachable.
 *
 * Three things are deliberately NOT bundled:
 *
 *   - `@prisma/client` and the generated client, because the query engine is a
 *     21 MB native `.node` the bundler cannot inline and the client loads by path.
 *   - `@node-rs/argon2`, same reason — a native addon per platform.
 *   - `pino-pretty`, which is a development-only log transport that pino resolves by
 *     name at runtime; production logs are JSON and never load it.
 *
 * Everything else — Fastify, its plugins, Zod, jose, the shared packages — is inlined
 * into one file.
 */

const require = createRequire(import.meta.url);
const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const API = join(REPO, 'apps', 'api');
const STAGE = join(REPO, 'packaging', 'dist', 'runtime');

/** Resolution anchored in apps/api so pnpm's isolated store is followed correctly. */
const fromApi = createRequire(join(API, 'package.json'));

const steps = [];
const note = (message) => {
  steps.push(message);
  console.log(`  ${message}`);
};

function directorySize(path) {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? directorySize(child) : statSync(child).size;
  }
  return total;
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Copies an allowlist of files from a package, preserving relative layout. */
function copyAllowlist(sourceDir, targetDir, files) {
  for (const file of files) {
    const source = join(sourceDir, file);
    if (!existsSync(source)) {
      throw new Error(`missing expected file: ${source}`);
    }
    const target = join(targetDir, file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target);
  }
}

console.log('\nWalaa — staging the API runtime for Windows distribution\n');

// ── 1. Clean ────────────────────────────────────────────────────────────────────
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
note(`staging directory: ${relative(REPO, STAGE)}`);

// ── 2. Bundle the service ───────────────────────────────────────────────────────
// CJS, not ESM. The Prisma client is CommonJS, and `import { PrismaClient } from
// '@prisma/client'` in a pure-ESM bundle depends on Node's named-export detection
// working on a package whose entry point spreads a `require()` — which it does not.
// A CJS bundle requires it the way Prisma itself expects to be loaded.
const bundleFile = join(STAGE, 'walaa-api.cjs');
const result = await build({
  entryPoints: [join(API, 'src', 'server.ts')],
  outfile: bundleFile,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: false,
  minify: false, // A readable stack trace in a shop's log file is worth the kilobytes.
  legalComments: 'none',
  external: ['@prisma/client', '.prisma/client', '@node-rs/argon2', 'pino-pretty'],
  logLevel: 'warning',
  metafile: true,
});
note(
  `bundled ${Object.keys(result.metafile.inputs).length} modules → walaa-api.cjs (${mb(statSync(bundleFile).size)})`,
);

/*
  ── 2b. The restore command ────────────────────────────────────────────────────

  Ships beside the service because a `.walaabk` archive is AES-256-GCM over gzip and
  **nothing outside this codebase can open one**. Without it the recovery a merchant is
  actually promised — the archives in Drive, the key written down during the ceremony
  (§12.19) — has no last step, and every failure message that says «استعد أحدث نسخة
  احتياطية» is asking for something that cannot be done.

  Its own bundle rather than a flag on the service: it must run with the service
  **stopped** (§12.18 — restoring over a live database is not offered), and an entry
  point that cannot start a server cannot be talked into starting one.

  Run on the merchant's machine as:
      node.exe walaa-restore.cjs --list
      node.exe walaa-restore.cjs <archive> --to <output.db> [--key <printed key>]
*/
const restoreFile = join(STAGE, 'walaa-restore.cjs');
const restoreResult = await build({
  entryPoints: [join(API, 'src', 'tools', 'restore-cli.ts')],
  outfile: restoreFile,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  external: ['@prisma/client', '.prisma/client', '@node-rs/argon2', 'pino-pretty'],
  logLevel: 'warning',
  metafile: true,
});
note(
  `bundled ${Object.keys(restoreResult.metafile.inputs).length} modules → walaa-restore.cjs (${mb(statSync(restoreFile).size)})`,
);

// ── 3. Prisma client + query engine ─────────────────────────────────────────────
const prismaClientDir = dirname(fromApi.resolve('@prisma/client/package.json'));
const generatedClientDir = join(dirname(dirname(prismaClientDir)), '.prisma', 'client');
if (!existsSync(generatedClientDir)) {
  throw new Error(
    `generated Prisma client not found at ${generatedClientDir} — run \`pnpm db:generate\` first`,
  );
}

// An allowlist, not a copy of the package. The full @prisma/client is 74 MB, almost
// all of it WASM engines for Postgres, MySQL, CockroachDB and the edge runtimes, plus
// source maps. This installation talks to SQLite from Node and needs none of it.
copyAllowlist(prismaClientDir, join(STAGE, 'node_modules', '@prisma', 'client'), [
  'package.json',
  'index.js',
  'default.js',
  join('runtime', 'library.js'),
]);
copyAllowlist(generatedClientDir, join(STAGE, 'node_modules', '.prisma', 'client'), [
  'package.json',
  'index.js',
  'default.js',
  'client.js',
  'schema.prisma',
  'query_engine-windows.dll.node',
]);
note(
  `prisma client + windows query engine (${mb(directorySize(join(STAGE, 'node_modules', '.prisma')))})`,
);

// ── 4. Argon2 native addon ──────────────────────────────────────────────────────
const argon2Dir = dirname(fromApi.resolve('@node-rs/argon2'));
const fromArgon2 = createRequire(join(argon2Dir, 'package.json'));
const argon2NativeDir = dirname(fromArgon2.resolve('@node-rs/argon2-win32-x64-msvc/package.json'));

copyAllowlist(argon2Dir, join(STAGE, 'node_modules', '@node-rs', 'argon2'), [
  'package.json',
  'index.js',
]);
copyAllowlist(argon2NativeDir, join(STAGE, 'node_modules', '@node-rs', 'argon2-win32-x64-msvc'), [
  'package.json',
  'argon2.win32-x64-msvc.node',
]);
note('argon2 native addon (win32-x64-msvc)');

// ── 5. Migrations ───────────────────────────────────────────────────────────────
// Shipped for verification rather than for application. A merchant's machine no
// longer migrates: it installs the pre-migrated template below and then checks that
// the migration set beside the binary is the one the binary was built against
// (`assertMigrationsMatchBuild`). The files have to be present for that check.
cpSync(join(API, 'prisma', 'migrations'), join(STAGE, 'migrations'), { recursive: true });
const migrationCount = readdirSync(join(STAGE, 'migrations')).filter((name) =>
  statSync(join(STAGE, 'migrations', name)).isDirectory(),
).length;
note(`${migrationCount} migration(s)`);

// ── 5a. The pre-migrated database template ──────────────────────────────────────
/*
  ── Why a database is an installer artefact ───────────────────────────────────

  A first launch used to create an empty file and run every migration against it: a
  write, on a machine nobody had ever run this software on, before any backup existed,
  with a shop about to open. `apps/api/prisma/build-db-template.ts` does that work here
  instead, where a developer is standing in front of it, and the merchant's machine
  only copies and verifies.

  **The hash is checked, not trusted.** `walaa-template.json` records the sha256 of the
  bytes that were built and verified. Shipping a template that does not match it would
  ship a database nobody checked — and, because `EXPECTED_SCHEMA_HASH` is compiled into
  the binary from the same run, a mismatch here means every install refuses to start
  with a schema error that points at the merchant's machine instead of at this build.
  Refusing to stage is how that stays a build-time failure.
*/
const templateSource = join(API, 'prisma', 'walaa-template.db');
const templateRecordPath = join(API, 'prisma', 'walaa-template.json');

if (!existsSync(templateSource) || !existsSync(templateRecordPath)) {
  throw new Error(
    'the database template is missing — run `pnpm --filter @walaa/api db:template` before staging',
  );
}

const templateRecord = JSON.parse(readFileSync(templateRecordPath, 'utf8'));
const templateBytes = readFileSync(templateSource);
const templateSha = createHash('sha256').update(templateBytes).digest('hex');

if (templateSha !== templateRecord.sha256) {
  throw new Error(
    `the database template does not match its record.
` +
      `  built:  ${templateRecord.sha256}
` +
      `  on disk: ${templateSha}
` +
      'Re-run `pnpm --filter @walaa/api db:template` — the template, its record and the ' +
      'fingerprints compiled into the binary are written together and must ship together.',
  );
}

cpSync(templateSource, join(STAGE, 'walaa-template.db'));
note(
  `database template (${mb(templateBytes.length)}, schema ${String(templateRecord.schemaHash).slice(0, 12)})`,
);

// ── 6. Node runtime ─────────────────────────────────────────────────────────────
// The exact interpreter this was built and tested against, copied in. Node is MIT
// licensed and redistributable; its licence travels with it.
cpSync(process.execPath, join(STAGE, 'node.exe'));
const nodeLicense = join(dirname(process.execPath), 'LICENSE');
if (existsSync(nodeLicense)) cpSync(nodeLicense, join(STAGE, 'NODE-LICENSE.txt'));
note(`node ${process.version} runtime (${mb(statSync(join(STAGE, 'node.exe')).size)})`);

// ── 5b. The Loyalty Station ─────────────────────────────────────────────────────
// Served by the API on its own port (§12.3), so the tablet browses to the manager
// machine and there is no second web server to install. Staged as `station/`, which
// is where `resolveStationDir` looks when the runtime directory is the working
// directory.
const stationDist = join(REPO, 'apps', 'station', 'dist');
if (existsSync(join(stationDist, 'index.html')) && existsSync(join(stationDist, 'assets'))) {
  cpSync(stationDist, join(STAGE, 'station'), { recursive: true });
  note(`loyalty station bundle (${mb(directorySize(join(STAGE, 'station')))})`);
} else {
  console.warn(
    '  WARNING: the Loyalty Station is not built — run `pnpm --filter @walaa/station build`.',
  );
  console.warn(
    '           The installer will ship without it and the tablet will have nothing to open.',
  );
}

// ── 6b. Service host ────────────────────────────────────────────────────────────
// The shim that lets the Service Control Manager start Node at all, and that keeps
// it running. Staged beside the runtime so one installer resource covers everything.
const serviceExe = join(
  REPO,
  'packaging',
  'service-host',
  'target',
  'release',
  'walaa-service.exe',
);
if (!existsSync(serviceExe)) {
  console.error(
    [
      '',
      '  ERROR: walaa-service.exe has not been built.',
      '         Run `pnpm --filter @walaa/packaging service:build` first.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

/*
  ── The binary must be newer than its source ─────────────────────────────────

  This used to be a `warn` on absence and nothing else, which quietly permitted the
  worse case: a binary that EXISTS and is stale. `cargo check` compiles without
  emitting one, so an afternoon of edits that were only type-checked left the previous
  build sitting in `target/release`, and staging copied it without comment.

  The installer that came out of that was internally inconsistent — a new API bundle
  expecting an environment file that the old service host did not write — and it
  failed on a clean machine in a way that looked like an application bug rather than a
  build one. It cost a full install-and-diagnose cycle to find, and it would have cost
  a merchant a broken product.

  A warning would not have helped: this scrolls past inside a longer build. It is an
  error, and it names the offending file.
*/
const newestSource = readdirSync(join(REPO, 'packaging', 'service-host', 'src'))
  .map((entry) => statSync(join(REPO, 'packaging', 'service-host', 'src', entry)).mtimeMs)
  .reduce((a, b) => Math.max(a, b), 0);

if (statSync(serviceExe).mtimeMs < newestSource) {
  console.error(
    [
      '',
      '  ERROR: walaa-service.exe is OLDER than its source.',
      `         binary  ${new Date(statSync(serviceExe).mtimeMs).toISOString()}`,
      `         source  ${new Date(newestSource).toISOString()}`,
      '',
      '         `cargo check` does not produce a binary. Run:',
      '           pnpm --filter @walaa/packaging service:build',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

cpSync(serviceExe, join(STAGE, 'walaa-service.exe'));
note(`service host (${mb(statSync(serviceExe).size)})`);

// ── 6c. Post-reboot verification script ─────────────────────────────────────────
// Shipped with the runtime rather than kept in the repo: it is run on the merchant's
// machine, after a reboot, by whoever installed the software — who will not have a
// checkout in front of them.
cpSync(join(REPO, 'packaging', 'scripts', 'verify-install.ps1'), join(STAGE, 'verify-install.ps1'));
note('verify-install.ps1 (the five post-reboot checks)');

// ── 6b. The demo shop ───────────────────────────────────────────────────────────
//
// `WALAA_DEMO=1` stages the pre-seeded database beside the service. Its PRESENCE is
// what puts the installed app into demo mode — `walaa-service.exe` looks for this file
// and sets `WALAA_DEMO` for the API accordingly — so there is no separate flag that can
// fall out of step with the data, and a production stage has no such file to find.
//
// Seeded at build time rather than on first launch: replaying six months through the
// real services takes about half a minute, and a merchant double-clicking a shortcut
// should not watch that happen.
if (process.env.WALAA_DEMO === '1') {
  const demoDb = join(API, 'prisma', 'walaa-demo.db');
  if (!existsSync(demoDb)) {
    console.error(
      [
        '',
        '  ERROR: WALAA_DEMO=1 but apps/api/prisma/walaa-demo.db does not exist.',
        '         Run `pnpm --filter @walaa/api db:seed:demo` first.',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
  cpSync(demoDb, join(STAGE, 'walaa-demo.db'));
  note(`demo database (${mb(statSync(demoDb).size)})`);

  /*
    The seed must be loginable, and the readme must be generated from what was proved.

    Staging a demo whose published credentials are refused is the failure that sent a
    merchant hunting a problem that did not exist. `db:assert:login` performs a real
    `login()` for every account and writes what worked; `make-readme.mjs` renders the
    instructions from that file. Both run here so the gate cannot be skipped by
    building without remembering to run them.
  */
  const credentials = join(API, 'prisma', 'demo-credentials.json');
  if (!existsSync(credentials)) {
    console.error(
      [
        '',
        '  ERROR: the demo seed has not been login-verified.',
        '         Run `pnpm --filter @walaa/api db:assert:login` first.',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
  /*
    Content-addressed, not time-addressed.

    Comparing modification times could never work: the assertion performs real logins,
    which write to the database, so the seed is always newer than the record of its
    verification. And a timestamp cannot say WHICH bytes were verified. The hash can.
  */
  const proof = JSON.parse(readFileSync(credentials, 'utf8'));
  const actual = createHash('sha256').update(readFileSync(demoDb)).digest('hex');
  if (proof.sha256 !== actual) {
    console.error(
      [
        '',
        '  ERROR: the demo database is not the one that was login-verified.',
        `         shipping  ${actual}`,
        `         verified  ${proof.sha256 ?? '(no hash recorded)'}`,
        '',
        '         Run `pnpm --filter @walaa/api db:assert:login`.',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
  note('demo credentials verified by a real login');
} else {
  // A stale demo database left over from a previous demo stage would silently turn a
  // production build into a demo one, which is the exact failure the presence-as-flag
  // design has to be defended against.
  const stray = join(STAGE, 'walaa-demo.db');
  if (existsSync(stray)) {
    rmSync(stray);
    note('removed a stale demo database from the stage');
  }
}

// ── 7. Configuration template ───────────────────────────────────────────────────
// Not a working configuration: the secrets are generated per installation by
// `walaa-service.exe install`, so no two shops share a JWT signing key and no secret
// is ever committed to this repository.
writeFileSync(
  join(STAGE, 'walaa.env.template'),
  [
    '# ولاء — إعدادات الخدمة. يُنشأ هذا الملف تلقائياً عند التثبيت.',
    '# Generated per installation by `walaa-service.exe install`. Do not commit a filled copy.',
    '',
    'NODE_ENV=production',
    // Filled in by `walaa-service.exe install` with the name THIS build opens:
    // walaa.db for production, walaa-demo.db for a demo. The two never share a file.
    'DATABASE_URL="file:{{DATABASE_FILE}}"',
    'API_PORT=4000',
    'API_HOST=0.0.0.0',
    'LOG_LEVEL=info',
    '',
    '# Generated at install time — 48 random bytes each.',
    'JWT_ACCESS_SECRET={{JWT_ACCESS_SECRET}}',
    'JWT_REFRESH_SECRET={{JWT_REFRESH_SECRET}}',
    'QR_TOKEN_SECRET={{QR_TOKEN_SECRET}}',
    '',
    'MERCHANT_TIMEZONE=Asia/Baghdad',
    'MERCHANT_CURRENCY=IQD',
    'NOTIFICATION_PROVIDER=stub',
    '',
    '# The Tauri webview, plus the LAN address the Loyalty Station browses to.',
    '# The installer appends the machine address; add others by hand if a second',
    '# station is set up on a different subnet.',
    'API_CORS_ORIGINS="http://tauri.localhost,https://tauri.localhost,http://localhost:4000"',
    '',
  ].join('\n'),
);
note('walaa.env.template');

// ── 8. Manifest ─────────────────────────────────────────────────────────────────
// Recorded so a support call can establish what is actually installed on a machine
// without asking the shop owner to read file dates aloud.
const apiPackage = JSON.parse(readFileSync(join(API, 'package.json'), 'utf8'));
writeFileSync(
  join(STAGE, 'manifest.json'),
  `${JSON.stringify(
    {
      product: 'walaa-api',
      version: apiPackage.version,
      node: process.version,
      platform: 'win32-x64',
      stagedAt: new Date().toISOString(),
      migrations: readdirSync(join(STAGE, 'migrations'))
        .filter((name) => statSync(join(STAGE, 'migrations', name)).isDirectory())
        .sort(),
      // The database that ships, by content. A support call can compare these three
      // values against what a machine reports at boot without reading file dates aloud.
      databaseTemplate: {
        sha256: templateRecord.sha256,
        schemaHash: templateRecord.schemaHash,
        migrationsFingerprint: templateRecord.migrationsFingerprint,
      },
    },
    null,
    2,
  )}\n`,
);

const total = directorySize(STAGE);
console.log(`\n  staged runtime: ${mb(total)} in ${relative(REPO, STAGE)}`);
console.log(
  `  (node.exe is ${mb(statSync(join(STAGE, 'node.exe')).size)} of that; NSIS compresses it)\n`,
);
