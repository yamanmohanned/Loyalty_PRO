/**
 * Proves the two demo-isolation claims against built artefacts.
 *
 * Both claims are about code that is *absent*, and absence is exactly the kind of
 * property that quietly stops being true. `demo.ts` asserts that a production bundle
 * contains no demo branches because `__DEMO_MODE__` is a compile-time literal and
 * Rollup drops the dead code — a claim about a bundler's behaviour under a
 * configuration nobody re-checks. This re-checks it.
 *
 *   node packaging/scripts/verify-demo-isolation.mjs <dist-dir> --expect demo|production
 *
 * Exits non-zero on any failure, so it can gate a release rather than inform one.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [, , distDir, ...rest] = process.argv;
const expectFlag = rest.indexOf('--expect');
const expect = expectFlag === -1 ? null : rest[expectFlag + 1];

if (!distDir || (expect !== 'demo' && expect !== 'production')) {
  console.error('usage: verify-demo-isolation.mjs <dist-dir> --expect demo|production');
  process.exit(2);
}

/**
 * Strings that exist ONLY inside a demo-guarded branch.
 *
 * Arabic literals rather than identifiers: a minifier renames `IS_DEMO` and inlines
 * `DemoResetCard`, but it cannot rewrite the text of a string that is rendered. If any
 * of these survive into a production bundle, the branch survived with them.
 */
const DEMO_MARKERS = [
  'نسخة تجريبية',
  'إعادة تعيين البيانات التجريبية',
  'أهلاً بك في النسخة التجريبية',
  '/system/demo/reset',
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(js|css|html)$/i.test(entry)) out.push(full);
  }
  return out;
}

const files = walk(distDir);
if (files.length === 0) {
  console.error(`no bundle files under ${distDir} — did the build run?`);
  process.exit(2);
}

const found = new Map();
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const marker of DEMO_MARKERS) {
    if (text.includes(marker)) {
      if (!found.has(marker)) found.set(marker, []);
      found.get(marker).push(file);
    }
  }
}

const missing = DEMO_MARKERS.filter((m) => !found.has(m));
let failed = false;

if (expect === 'production') {
  if (found.size > 0) {
    failed = true;
    console.error('✗ production bundle still contains demo-only code:');
    for (const [marker, where] of found) {
      console.error(`    "${marker}" in ${where.map((f) => f.replace(distDir, '')).join(', ')}`);
    }
  } else {
    console.log(`✓ production bundle is clean — none of the ${DEMO_MARKERS.length} demo markers present`);
  }
} else {
  if (missing.length > 0) {
    failed = true;
    console.error('✗ demo bundle is missing demo-only code — was WALAA_DEMO=1 set?');
    for (const marker of missing) console.error(`    "${marker}" not found`);
  } else {
    console.log(`✓ demo bundle carries all ${DEMO_MARKERS.length} demo markers`);
  }
}

process.exit(failed ? 1 : 0);
