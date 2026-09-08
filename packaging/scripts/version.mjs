#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ONE PRODUCT VERSION, DERIVED EVERYWHERE ELSE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── The failure this prevents, which appears in the shop ─────────────────────
 *
 * The dashboard refuses a server whose `/health` reports a different `major.minor`,
 * and says «خادم ولاء على هذا العنوان بإصدار مختلف». That check is correct and worth
 * having — a dashboard talking to an incompatible API produces unexplained empty
 * screens rather than an error.
 *
 * It is also only as good as the two numbers it compares, and those numbers lived in
 * five hand-maintained places holding three different values: `0.1.0` in the API and
 * the root, `0.1.1-preview` in the desktop app and its Tauri config, `1.0.0` in the
 * Station. Nothing had broken yet only because two of them happen to round to `0.1`.
 *
 * The first release that moves the desktop app to `0.2` while the API's literal stays
 * at `0.1` produces a manager and a station **from the same installer** refusing each
 * other over a version difference that does not exist. And it does not happen here: it
 * happens when the till is connected, in the shop, on the day.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────
 *
 * The version in the ROOT `package.json` is the product version. It is the only one
 * anybody edits. Every other version string in the repository is derived from it, and
 * this script either writes them (`--write`) or refuses when they disagree (default).
 *
 * The root was chosen over `tauri.conf.json` — which is Tauri's file and Tauri's
 * schema — and over the API's, which is one of several consumers rather than the
 * product. Everything shipped in one installer carries one number.
 *
 *   node packaging/scripts/version.mjs           # assert; exit 1 on drift
 *   node packaging/scripts/version.mjs --write   # bring every file into line
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const write = process.argv.includes('--write');

const rootPackage = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
const VERSION = rootPackage.version;

if (typeof VERSION !== 'string' || VERSION.length === 0) {
  console.error('the root package.json has no version — there is nothing to derive from');
  process.exit(1);
}

/**
 * A place a version string lives, with how to read and rewrite it.
 *
 * Targeted text replacement rather than parse-and-reserialise: `tauri.conf.json` is
 * Tauri's file and reformatting it would produce a diff nobody asked for, in a file
 * whose diffs matter.
 */
const targets = [
  ...['apps/api', 'apps/manager-desktop', 'apps/station', 'packages/shared-types', 'packages/ui', 'packages/config', 'packaging'].map(
    (pkg) => ({
      file: `${pkg}/package.json`,
      // The top-level "version" key, which npm writes at two-space indent.
      pattern: /^(\s*"version":\s*")([^"]*)(")/m,
      optional: true,
    }),
  ),
  {
    file: 'apps/manager-desktop/src-tauri/tauri.conf.json',
    pattern: /^(\s*"version":\s*")([^"]*)(")/m,
  },
  {
    file: 'apps/manager-desktop/src-tauri/Cargo.toml',
    pattern: /^(version\s*=\s*")([^"]*)(")/m,
    optional: true,
  },
  {
    // The API's wire version, compiled in because the shipped bundle has no
    // package.json beside it to read at runtime.
    file: 'apps/api/src/config/version.ts',
    pattern: /^(export const API_VERSION = ')([^']*)(')/m,
  },
];

const problems = [];
const rewritten = [];

for (const target of targets) {
  const path = join(REPO, target.file);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    if (target.optional) continue;
    problems.push(`${target.file}: missing`);
    continue;
  }

  const match = target.pattern.exec(text);
  if (!match) {
    if (target.optional) continue;
    problems.push(`${target.file}: no version string found`);
    continue;
  }

  const found = match[2];
  if (found === VERSION) continue;

  if (write) {
    writeFileSync(path, text.replace(target.pattern, `$1${VERSION}$3`), 'utf8');
    rewritten.push(`${target.file}: ${found} -> ${VERSION}`);
  } else {
    problems.push(`${target.file}: ${found}  (product version is ${VERSION})`);
  }
}

if (write) {
  console.log(`  product version ${VERSION}`);
  for (const line of rewritten) console.log(`  ${line}`);
  if (rewritten.length === 0) console.log('  every version string already matches');
  process.exit(0);
}

if (problems.length > 0) {
  console.error(
    [
      '',
      `  Version strings disagree with the product version (${VERSION}):`,
      '',
      ...problems.map((p) => `    ${p}`),
      '',
      '  A manager and a station from the same installer can refuse each other over',
      '  this, and the refusal appears in the shop rather than here.',
      '',
      '  Fix:  node packaging/scripts/version.mjs --write',
      `        (edit only ${relative(REPO, join(REPO, 'package.json'))} to change the version)`,
      '',
    ].join('\n'),
  );
  process.exit(1);
}

console.log(`  every version string matches the product version (${VERSION})`);
