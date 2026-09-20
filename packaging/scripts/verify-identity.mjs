#!/usr/bin/env node
/**
 * Proves this build cannot be mistaken for — or collide with — the frozen «ولاء» line.
 *
 * ── The failure this closes ─────────────────────────────────────────────────
 *
 * `nsis/hooks.nsh` runs `loyalty-pro-service.exe uninstall` unconditionally on every
 * install, and that command deregisters a service **by name**, wherever its binary
 * lives (the rule is in `docs/legacy/CLAUDE_v3.md` §12.36). The name is a constant in
 * `packaging/service-host/src/main.rs`.
 *
 * So if one `SERVICE_NAME` were ever left reading `WalaaApi`, installing this product
 * on a merchant's machine would stop the OTHER product's live service, deregister it,
 * and register this binary in its place — silently, with no error, while the shop is
 * open. The same shape of failure hides behind every other string below: one shared
 * data directory, one shared database filename, one shared registry anchor, one
 * shared updater feed that would pull the other product's releases over this one.
 *
 * A rename is a hundred edits and a human reviewing a diff. This is the machine
 * checking the same thing every time, which is the only version that keeps holding
 * once somebody copies a file in from the old repo a year from now.
 *
 * `docs/legacy/` is exempt: those documents describe the frozen line and naming it is
 * exactly what they are for. Rewriting them would falsify the record.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SELF = 'packaging/scripts/verify-identity.mjs';

/** Each entry: a string that must not survive the fork, and what it would collide with. */
const FORBIDDEN = [
  ['WalaaApi', 'the frozen line\'s Windows service name — would deregister its live service'],
  ['Walaa Loyalty API', 'the frozen line\'s firewall rule — renaming orphans it, sharing it deletes theirs'],
  ['Software\\\\Walaa', 'the frozen line\'s licence clock anchor in HKCU'],
  ['ProgramData[\\\\/]Walaa(?![A-Za-z])', 'the frozen line\'s data directory — holds its database and backup key'],
  ['walaa\\.db', 'the frozen line\'s database filename'],
  ['walaa-demo\\.db', 'the frozen line\'s demo database filename'],
  ['walaa-template\\.db', 'the frozen line\'s shipped database template'],
  ['walaa\\.env', 'the frozen line\'s environment file'],
  // Deliberately not `@walaa/`. The staging scripts build the scope directory a path
  // segment at a time — join(STAGE, 'node_modules', '@walaa', 'license-native') — so the
  // trailing slash an earlier version of this pattern required was never there, and six
  // of those survived the rename: a staged runtime under a directory nothing would
  // install into, and `verify-license-key` reporting "no staged licensing module".
  ['@walaa(?![A-Za-z0-9-])', 'the frozen line\'s npm scope'],
  // The JWT issuer and, for the same reason, any bare use of the old product word as a
  // value. A token minted by one product must not validate in the other.
  ['(?<![\\w.-])["\']walaa["\'](?![\\w.-])', 'the frozen line\'s JWT issuer or a bare product identifier'],
  ['WALAA_[A-Z]', 'the frozen line\'s environment variable prefix'],
  ['com\\.walaa\\.manager', 'the frozen line\'s Tauri bundle identifier'],
  ["'walaa-api'", 'the frozen line\'s /health contract — already-paired stations key on it'],
  ['"walaa-api"', 'the frozen line\'s /health contract'],
  ['github\\.com/yamanmo/walaa', 'the frozen line\'s release feed — this product would update itself into that one'],
  ['localhost:4000', 'the frozen line\'s API port'],
  // A bare "Walaa" string literal. The .NET agent builds its data path a segment at a
  // time — Path.Combine(CommonApplicationData, "Walaa", "agent") — which the ProgramData
  // pattern above cannot see, and which had the agent's capture queue writing inside the
  // frozen line's data directory. Namespaces (`Walaa.Agent`) and prose are unaffected:
  // this matches only a complete quoted word.
  ['(?<![\\w.])["\']Walaa["\'](?![\\w.])', 'the frozen line\'s data directory, composed a segment at a time'],
];

/** Paths whose job is to describe the frozen line, or to check for it. */
const EXEMPT = [/^docs\/legacy\//, new RegExp(`^${SELF}$`), /^pnpm-lock\.yaml$/];

const files = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files'], { cwd: REPO, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((f) => !EXEMPT.some((rx) => rx.test(f)))
  .filter((f) => !/\.(png|jpe?g|ico|icns|db|node|ttf|woff2?|pdf|zip|bin)$/i.test(f));

const hits = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(join(REPO, file), 'utf8');
  } catch {
    continue; // unreadable or binary — nothing to assert about it
  }
  const lines = text.split('\n');
  for (const [pattern, why] of FORBIDDEN) {
    const rx = new RegExp(pattern);
    lines.forEach((line, i) => {
      // A line may opt out by naming itself. The only legitimate reason to write one of
      // these strings is to REFUSE it — the provenance guard in `lib/db-identity.ts` has
      // to spell the frozen line's database filenames in order to turn them away. The
      // marker is per line and shows up in review; a file-wide exemption would not.
      if (line.includes('identity-guard:allow')) return;
      // Tested twice: as written, and with backslashes stripped. A regex literal in a
      // test spelled the database as `/walaa\.db\.superseded-/`, where the backslash
      // between "walaa" and "db" meant no plain search for `walaa.db` could see it —
      // so the rename left the assertion behind while the file it names was renamed,
      // and the test went on passing against a filename that no longer exists.
      // Stripping backslashes costs nothing: every pattern that genuinely needs them
      // still matches the raw line.
      const bare = line.replace(/\\/g, '');
      if (rx.test(line) || rx.test(bare)) {
        hits.push({ file, line: i + 1, pattern, why, text: line.trim().slice(0, 100) });
      }
    });
  }
}

if (hits.length === 0) {
  console.log(`identity: clean — ${files.length} files carry no identifier of the frozen «ولاء» line`);
  process.exit(0);
}

console.error(`\nidentity: ${hits.length} identifier(s) of the frozen «ولاء» line survived the fork.\n`);
for (const h of hits) {
  console.error(`  ${h.file}:${h.line}`);
  console.error(`    matched /${h.pattern}/ — ${h.why}`);
  console.error(`    ${h.text}\n`);
}
console.error('Each of these collides with a product that may be installed on the same machine.');
process.exit(1);
