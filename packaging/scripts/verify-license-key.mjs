#!/usr/bin/env node
/**
 * Refuses to build an installer whose licensing module embeds anything but the
 * provider's PRODUCTION public key (packaging/LICENSING.md).
 *
 * Until the provider runs `license-issuer keygen`, the repository embeds a development
 * key whose private half — and its password — are committed in
 * `tools/license-issuer/dev-key`. Codes signed with it are free to anyone who reads the
 * repository. That is correct for tests and for `package:verify`, and a disaster in a
 * shop, so the one command that produces something a merchant installs checks the key
 * the STAGED runtime will actually load — the file that ships, not the source.
 *
 * Usage: node packaging/scripts/verify-license-key.mjs   (run by `pnpm package:installer`)
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STAGED = join(REPO, 'packaging', 'dist', 'runtime', 'node_modules', '@loyalty-pro', 'license-native');

function fail(message) {
  console.error(`\n  verify-license-key: ${message}\n`);
  process.exit(1);
}

if (!existsSync(join(STAGED, 'loyalty-pro-license.node'))) {
  fail(`no staged licensing module at ${STAGED} — run \`pnpm package:build\` first`);
}
if (existsSync(join(STAGED, 'loyalty-pro-license.test.node'))) {
  fail('the TEST build of the licensing module is in the staged runtime; it can sign codes and must never ship');
}

// The test build is chosen only under VITEST; make certain this process cannot ask for it.
delete process.env.VITEST;
const native = createRequire(import.meta.url)(STAGED);
const key = native.keyInfo();

// The frozen «ولاء» line's production key. Inherited by the fork and still compiled in
// until the provider runs `license-issuer keygen` here. It is a PRODUCTION key, so the
// check below waves it through — and a licence sold for one product would then activate
// the other, and one phone-read emergency code would unlock both.
const FROZEN_LINE_FINGERPRINT = 'FCA66207230B90CA';

if (key.fingerprint === FROZEN_LINE_FINGERPRINT) {
  fail(
    [
      `the staged licensing module embeds the FROZEN «ولاء» line's key (${key.fingerprint}).`,
      '  Loyalty Pro is sold separately (PRD §5, G6). Sharing a key means a code sold for one',
      '  product activates the other, and one emergency unlock code opens both.',
      '',
      '  Generate this product\'s own keypair, once, on the provider\'s machine:',
      '      tools/license-issuer/target/release/license-issuer.exe keygen',
      '  which rewrites crates/loyalty-pro-license/src/public_key.rs. Commit it, then',
      '  `pnpm package:build` and run this again. See packaging/LICENSING.md.',
    ].join('\n'),
  );
}

if (key.kind !== 'production') {
  fail(
    [
      `the staged licensing module embeds a ${key.kind.toUpperCase()} key (fingerprint ${key.fingerprint}).`,
      '  Codes for that key can be signed by anyone with this repository. An installer built',
      '  from it would give every shop a free licence.',
      '',
      '  The provider generates the production key once, on their own machine:',
      '      tools/license-issuer/target/release/license-issuer.exe keygen',
      '  which writes crates/loyalty-pro-license/src/public_key.rs. Commit that file, then run',
      '  `pnpm package:build` and this command again. See packaging/LICENSING.md.',
    ].join('\n'),
  );
}

console.log(`  verify-license-key: production key ${key.fingerprint} — ok`);
