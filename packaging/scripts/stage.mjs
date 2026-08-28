#!/usr/bin/env node
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
// Applied at first boot by the runtime migrator (apps/api/src/lib/migrate.ts), which
// is why the Prisma CLI does not need to exist on the merchant's machine.
cpSync(join(API, 'prisma', 'migrations'), join(STAGE, 'migrations'), { recursive: true });
const migrationCount = readdirSync(join(STAGE, 'migrations')).filter((name) =>
  statSync(join(STAGE, 'migrations', name)).isDirectory(),
).length;
note(`${migrationCount} migration(s)`);

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
if (existsSync(serviceExe)) {
  cpSync(serviceExe, join(STAGE, 'walaa-service.exe'));
  note(`service host (${mb(statSync(serviceExe).size)})`);
} else {
  console.warn(
    '  WARNING: walaa-service.exe not built — run `pnpm --filter @walaa/packaging service:build`.',
  );
  console.warn('           The staged runtime will not install as a Windows Service without it.');
}

// ── 6c. Post-reboot verification script ─────────────────────────────────────────
// Shipped with the runtime rather than kept in the repo: it is run on the merchant's
// machine, after a reboot, by whoever installed the software — who will not have a
// checkout in front of them.
cpSync(join(REPO, 'packaging', 'scripts', 'verify-install.ps1'), join(STAGE, 'verify-install.ps1'));
note('verify-install.ps1 (the five post-reboot checks)');

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
    'DATABASE_URL="file:{{DATA_DIR}}/walaa.db"',
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
