#!/usr/bin/env node
/**
 * Writes the `latest.json` that Tauri's updater reads, from a built bundle.
 *
 *   node packaging/scripts/make-update-feed.mjs <version> [--base <url>] [--notes "..."]
 *
 * The updater fetches this one file, compares its `version` against the running app's,
 * and if it is newer downloads the `url` and verifies it against the `signature` using
 * the public key compiled into the app. So three things have to agree — the version
 * string, the artefact and its `.sig` — and getting any of them by hand is how a
 * release quietly stops updating anybody. This produces all three from the bundle that
 * was actually built.
 *
 * `--base` is where the files will be reachable from. For a GitHub release that is
 * `https://github.com/<owner>/<repo>/releases/download/v<version>`; for the local
 * end-to-end test it is `http://127.0.0.1:8787`.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const BUNDLE = join(
  REPO,
  'apps',
  'manager-desktop',
  'src-tauri',
  'target',
  'release',
  'bundle',
  'nsis',
);
const OUT = join(REPO, 'packaging', 'dist', 'update');

const args = process.argv.slice(2);
const version = args[0];
const baseIndex = args.indexOf('--base');
const notesIndex = args.indexOf('--notes');
const base = baseIndex === -1 ? null : args[baseIndex + 1];
const notes = notesIndex === -1 ? 'تحسينات وإصلاحات.' : args[notesIndex + 1];

if (!version || !base) {
  console.error('usage: make-update-feed.mjs <version> --base <url> [--notes "..."]');
  process.exit(2);
}

// The bundle filename carries the Arabic product name. Read it rather than rebuild it:
// the exact bytes matter, because they end up in a URL the app has to resolve.
const setupName = `ولاء_${version}_x64-setup.exe`;
const setup = join(BUNDLE, setupName);
const sig = `${setup}.sig`;

for (const path of [setup, sig]) {
  if (!existsSync(path)) {
    console.error(`missing ${path}\n  build it first: pnpm --filter @loyalty-pro/manager-desktop tauri build`);
    process.exit(1);
  }
}

mkdirSync(OUT, { recursive: true });
copyFileSync(setup, join(OUT, setupName));

const feed = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature: readFileSync(sig, 'utf8').trim(),
      // Percent-encoded: the filename is Arabic, and an unencoded one is a URL that
      // works in a browser's address bar and fails from a Rust HTTP client.
      url: `${base.replace(/\/+$/, '')}/${encodeURIComponent(setupName)}`,
    },
  },
};

writeFileSync(join(OUT, 'latest.json'), `${JSON.stringify(feed, null, 2)}\n`);

console.log(`  latest.json      version ${version}`);
console.log(`  url              ${feed.platforms['windows-x86_64'].url}`);
console.log(`  signature        ${feed.platforms['windows-x86_64'].signature.slice(0, 24)}…`);
console.log(`  staged in        ${OUT}`);
