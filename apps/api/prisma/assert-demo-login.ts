/**
 * Fails the build unless the demo seed can actually be logged into.
 *
 * ── The defect this exists to close ──────────────────────────────────────────
 *
 * A merchant was handed `owner` / `walaa2026`, typed it, and was refused. The
 * credentials were correct and the database was correct — but nobody had ever executed
 * the login. Every check that existed was structural: the seeding code ran, a user row
 * was present, the file had the right name and the right provenance marker. Not one of
 * them performed the single action the merchant would perform.
 *
 * A row existing is not a credential working. The hash could be of a different string,
 * the account could be inactive, the schema could reject the password's length, the
 * lookup could be case-sensitive in a way the documentation does not mention. All of
 * those pass a "the user exists" check and fail a login.
 *
 * ── Why it calls `login()` and not `verifyPassword()` ────────────────────────
 *
 * `verifyPassword` would test the hash. `login()` tests the hash **and** the lookup,
 * the active flag, the role parsing, the token issuance and the request schema's
 * constraints — the whole path the merchant's keystrokes travel. Testing the part you
 * suspect is how the last three of these were missed.
 *
 * ── It also writes the documentation's source ────────────────────────────────
 *
 * The verified strings are written to `demo-credentials.json`, and the merchant readme
 * is generated from that file. Documentation therefore cannot claim a credential the
 * build did not just execute — the two cannot drift, because only one of them is
 * written by hand.
 *
 *   pnpm --filter @loyalty-pro/api db:assert:login
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '../src/lib/prisma';
import { login } from '../src/services/auth.service';
import { DEMO_LOGINS } from '../src/lib/demo-credentials';
import { openDatabaseFile, readDemoProvenance } from '../src/lib/demo-guard';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  if (!/demo/i.test(url)) {
    throw new Error(`refusing to touch "${url}" — this only ever runs against a demo database`);
  }

  const file = await openDatabaseFile();
  const provenance = await readDemoProvenance();
  console.error(`  database:   ${file}`);
  console.error(`  seed id:    ${provenance?.seedId ?? '(none)'}`);

  const failures: string[] = [];
  const verified: Array<{ username: string; password: string; role: string; name: string; description: string; publish: boolean }> = [];

  for (const account of DEMO_LOGINS) {
    try {
      // The real thing. Exactly the strings that go into the merchant's instructions.
      const result = await login(account.username, account.password);
      verified.push({
        username: account.username,
        password: account.password,
        role: result.user.role,
        name: result.user.name,
        description: account.description,
        publish: account.publish,
      });
      console.error(`  ✓ ${account.username.padEnd(8)} → ${result.user.role}  (${result.user.name})`);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      failures.push(`${account.username} / ${account.password} — ${why}`);
      console.error(`  ✗ ${account.username.padEnd(8)} → ${why}`);
    }
  }

  if (failures.length > 0) {
    console.error('');
    console.error('  BUILD FAILED: the demo seed cannot be logged into with the credentials');
    console.error('  this build documents. Shipping it would hand the merchant a login form');
    console.error('  that refuses the password printed in his own instructions.');
    for (const f of failures) console.error(`    - ${f}`);
    console.error('');
    process.exitCode = 1;
    return;
  }

  /*
    Case tolerance, asserted rather than assumed.

    `Owner` was rejected while `owner` succeeded — same password, same database — and
    that is the likeliest way a shop owner loses an afternoon. The lookup now folds
    case; this proves it still does, because a fix nobody re-checks is a fix with a
    shelf life.
  */
  const primary = DEMO_LOGINS[0]!;
  for (const variant of [primary.username.toUpperCase(), capitalise(primary.username)]) {
    try {
      await login(variant, primary.password);
      console.error(`  ✓ ${variant.padEnd(8)} → accepted (case-insensitive lookup)`);
    } catch {
      console.error('');
      console.error(`  BUILD FAILED: "${variant}" is refused while "${primary.username}" is accepted.`);
      console.error('  A merchant whose keyboard capitalises the first letter cannot log in.');
      console.error('');
      process.exitCode = 1;
      return;
    }
  }

  /*
    ── Leave no sessions behind ────────────────────────────────────────────────

    Authenticating for real is the point of this script, and every real login writes a
    refresh token. Those rows are session artefacts of the build machine: shipping them
    means every merchant's demo starts carrying somebody else's sessions, and each run
    of this gate would add four more.

    Clearing them also lets the file settle, which the hash below depends on.
  */
  await prisma.refreshToken.deleteMany({});
  // WAL mode keeps recent writes in a sidecar until a checkpoint, so the .db file on
  // disk would not yet reflect that delete — and the hash has to describe the bytes
  // that actually ship.
  // `$queryRawUnsafe`, not `$executeRawUnsafe`: the pragma RETURNS a row, and Prisma
  // refuses a result set from an execute on SQLite.
  await prisma.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)');
  await prisma.$disconnect();

  /*
    ── The gate is content-addressed, not time-addressed ───────────────────────

    The first version of this compared modification times, and it could never pass:
    performing a login writes to the database, so the seed was always newer than the
    file recording that it had been verified. Worse, a timestamp only claims a check ran
    at some point — it cannot say WHICH bytes it ran against. A hash can, so `stage.mjs`
    refuses to ship a seed whose hash is not the one that was logged into.
  */
  const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');

  // `process.cwd()` rather than `__dirname`: this is ESM under tsx, and the pnpm script
  // always runs from apps/api.
  const out = join(process.cwd(), 'prisma', 'demo-credentials.json');
  const payload = {
    verifiedAt: new Date().toISOString(),
    database: file,
    sha256,
    seedId: provenance?.seedId ?? null,
    accounts: verified,
  };
  writeFileSync(out, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  console.error(`  seed sha256: ${sha256}`);
  console.error(`  wrote ${out}`);
  console.error(`  demo login: ${verified.length} account(s) verified by executing a real login`);
}

const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
