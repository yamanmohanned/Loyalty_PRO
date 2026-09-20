import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { API_VERSION } from '../src/config/version';
import { resolveMigrationsDir, DB_TEMPLATE_FILENAME } from '../src/config/paths';
import { applyPendingMigrations, listPendingMigrations } from '../src/lib/migrate';
import { applySqlitePragmas, checkpointWal } from '../src/lib/prisma';
import {
  computeMigrationsFingerprint,
  computeSchemaHash,
  readIdentity,
  stampIdentity,
} from '../src/lib/db-identity';
import {
  EXPECTED_MIGRATIONS_FINGERPRINT,
  EXPECTED_SCHEMA_HASH,
} from '../src/config/schema-fingerprint';

/**
 * Builds the fully-migrated database the installer ships, and writes down what it is.
 *
 * ── Why the product ships a database instead of making one ───────────────────
 *
 * A merchant's first launch used to create an empty file and run every migration
 * against it. That is a write — seven of them — on a machine nobody has ever run this
 * software on, before any backup exists, with a shop about to open. It is also how a
 * total outage happened once already: the pre-migration snapshot's free-space guard
 * refused, the API exited 1, and the supervisor retried it every thirty seconds
 * forever.
 *
 * The build has a developer standing in front of it and infinite time. The merchant's
 * machine has neither. So the migrating happens here, and the first launch only copies
 * and verifies.
 *
 * ── What this writes ─────────────────────────────────────────────────────────
 *
 *   prisma/loyalty-pro-template.db    the migrated, empty, identity-stamped database
 *   prisma/loyalty-pro-template.json  its sha256, its fingerprints, its migration list
 *   src/config/schema-fingerprint.ts   the two constants compiled into the binary
 *
 * The JSON is content-addressed on purpose, following `demo-credentials.json`: a
 * timestamp cannot say WHICH bytes were verified, and `stage.mjs` refuses to ship a
 * template whose hash does not match the record.
 *
 *   pnpm --filter @loyalty-pro/api db:template
 */

const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEMPLATE_PATH = join(API_ROOT, 'prisma', DB_TEMPLATE_FILENAME);
const RECORD_PATH = join(API_ROOT, 'prisma', 'loyalty-pro-template.json');
const CONSTANTS_PATH = join(API_ROOT, 'src', 'config', 'schema-fingerprint.ts');

const say = (message: string): void => {
  console.error(`  ${message}`);
};

function constantsFile(
  migrationsFingerprint: string,
  schemaHash: string,
  generatedAt: string,
): string {
  const header = readFileSync(CONSTANTS_PATH, 'utf8').split('export const')[0] ?? '';
  return (
    `${header.trimEnd()}\n\n` +
    `export const EXPECTED_MIGRATIONS_FINGERPRINT =\n  '${migrationsFingerprint}';\n\n` +
    `export const EXPECTED_SCHEMA_HASH =\n  '${schemaHash}';\n\n` +
    `/** When the two values above were generated, for a support call reading a log. */\n` +
    `export const SCHEMA_FINGERPRINT_GENERATED_AT = '${generatedAt}';\n`
  );
}

async function buildTemplate(): Promise<void> {
  const migrationsDir = resolveMigrationsDir(API_ROOT);
  if (!migrationsDir) throw new Error('could not find the migrations directory');

  // From scratch, every time. A template built on top of a previous one inherits
  // whatever that one had — including rows a merchant would then find on his first
  // launch, and including a schema left over from a migration that has since been
  // rewritten. The sidecars go too, or SQLite recovers the old file into the new one.
  for (const suffix of ['', '-wal', '-shm']) {
    const path = `${TEMPLATE_PATH}${suffix}`;
    if (existsSync(path)) rmSync(path, { force: true });
  }
  say(`building ${TEMPLATE_PATH}`);

  const client = new PrismaClient({
    datasourceUrl: `file:${TEMPLATE_PATH.replace(/\\/g, '/')}`,
  });

  try {
    await applySqlitePragmas(client);

    const outcome = await applyPendingMigrations({
      client,
      directory: migrationsDir,
      log: (message) => say(message),
    });
    say(`applied ${outcome.applied.length} migration(s) from ${outcome.directory}`);

    const pending = await listPendingMigrations({ client, directory: migrationsDir });
    if (pending.length > 0) {
      throw new Error(`the freshly built template still reports pending: ${pending.join(', ')}`);
    }

    const identity = await stampIdentity({
      client,
      createdBy: `build-db-template@${API_VERSION}`,
    });

    const schemaHash = await computeSchemaHash(client);
    const migrationsFingerprint = computeMigrationsFingerprint(migrationsDir);

    // Fold the WAL in and remove the sidecars, so the shipped artefact is exactly one
    // file. A template copied without its `-wal` would otherwise be a template missing
    // whatever the last statement wrote — the §12.17 loss, at build time.
    const checkpoint = await checkpointWal(client);
    say(`wal checkpoint: ${checkpoint.detail}`);
    await client.$disconnect();

    for (const suffix of ['-wal', '-shm']) {
      const path = `${TEMPLATE_PATH}${suffix}`;
      if (existsSync(path)) rmSync(path, { force: true });
    }

    const bytes = readFileSync(TEMPLATE_PATH);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const generatedAt = new Date().toISOString();

    writeFileSync(
      RECORD_PATH,
      `${JSON.stringify(
        {
          file: DB_TEMPLATE_FILENAME,
          bytes: bytes.length,
          sha256,
          productVersion: API_VERSION,
          installationId: identity.installationId,
          schemaHash,
          migrationsFingerprint,
          migrations: outcome.applied,
          builtAt: generatedAt,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    /*
      ── Rewritten only when a value actually changed ─────────────────────────

      The generator is deterministic in the two things that matter — the same
      migrations always produce the same schema hash and the same fingerprint — but the
      timestamp is not, so writing unconditionally produced a one-line diff on every
      build. `package:build` runs this, so every build dirtied the tree.

      That is worse than untidy. This file is the one whose diffs must be read: it is
      the record of the schema the binary will refuse to open a database without. A file
      that changes on every build is a file whose diff everybody learns to skip, and the
      day it changes for a real reason nobody looks.

      So the timestamp now means "when these values last changed", which is also the
      more useful thing for a support call to know.
    */
    const existingConstants = readFileSync(CONSTANTS_PATH, 'utf8');
    const unchanged =
      existingConstants.includes(`'${migrationsFingerprint}'`) &&
      existingConstants.includes(`'${schemaHash}'`);

    if (unchanged) {
      say('fingerprints unchanged — left as they are');
    } else {
      writeFileSync(
        CONSTANTS_PATH,
        constantsFile(migrationsFingerprint, schemaHash, generatedAt),
        'utf8',
      );
      say(`wrote ${CONSTANTS_PATH}`);
    }

    say(`template     ${bytes.length} bytes  sha256 ${sha256}`);
    say(`schema hash  ${schemaHash}`);
    say(`migrations   ${migrationsFingerprint}`);
    say(`wrote ${RECORD_PATH}`);
  } finally {
    await client.$disconnect().catch(() => undefined);
  }

  // Read back through the same reader the runtime uses, so the file is proved to carry
  // what was just claimed rather than assumed to.
  const verify = new PrismaClient({
    datasourceUrl: `file:${TEMPLATE_PATH.replace(/\\/g, '/')}`,
  });
  try {
    const identity = await readIdentity(verify);
    if (!identity) throw new Error('the template carries no identity row after stamping');
    say(`identity     ${identity.installationId} (${identity.createdBy})`);
  } finally {
    await verify.$disconnect();
    for (const suffix of ['-wal', '-shm']) {
      const path = `${TEMPLATE_PATH}${suffix}`;
      if (existsSync(path)) rmSync(path, { force: true });
    }
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  --check — the guard that makes the constants unable to go quietly stale
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * **The trap this closes.** `EXPECTED_MIGRATIONS_FINGERPRINT` and
 * `EXPECTED_SCHEMA_HASH` shipped once as placeholder values that had never been
 * generated — a guard that would have refused every merchant's perfectly correct
 * database. Running the generator by hand fixed that instance and recreated the trap
 * exactly: the next migration added without remembering to regenerate bricks every
 * production install, and it fails at the shop rather than here.
 *
 * So the values are treated as **derived**, and a derived value that is committed has
 * to be checked like a lockfile. This recomputes both from the migrations on disk and
 * refuses if the committed constants disagree.
 *
 * It builds into a temporary file rather than the committed template, so a check never
 * mutates the artefact it is checking — and it compares the two SEMANTIC values only.
 * The template's sha256 deliberately changes on every build (each carries a fresh
 * installation id), so comparing bytes would fail every time and teach everyone to
 * ignore it.
 *
 * Three places run this, covering the three ways a stale value escapes:
 *
 *   - `pnpm test` / CI — `src/__tests__/db-template.test.ts`
 *   - `.githooks/pre-commit` — before a migration can be committed without it
 *   - `pnpm package:build` — before anything is staged for a merchant
 */
async function checkTemplate(): Promise<void> {
  const migrationsDir = resolveMigrationsDir(API_ROOT);
  if (!migrationsDir) throw new Error('could not find the migrations directory');

  const migrationsFingerprint = computeMigrationsFingerprint(migrationsDir);

  // A scratch database, removed whatever happens. The schema hash can only be read off
  // a real SQLite file, so there is no cheaper way to answer the question honestly.
  const scratch = join(mkdtempSync(join(tmpdir(), 'walaa-fingerprint-')), 'check.db');
  const client = new PrismaClient({ datasourceUrl: `file:${scratch.replace(/\\/g, '/')}` });

  let schemaHash: string;
  try {
    await applySqlitePragmas(client);
    await applyPendingMigrations({ client, directory: migrationsDir, log: () => {} });
    schemaHash = await computeSchemaHash(client);
  } finally {
    await client.$disconnect().catch(() => undefined);
    rmSync(dirname(scratch), { recursive: true, force: true });
  }

  /*
    Built as lines and joined, rather than as one string full of escapes. The message
    is read by a developer at a terminal at the moment they have broken something, and
    the shape of it on screen is the whole point.
  */
  const drift: string[][] = [];
  if (migrationsFingerprint !== EXPECTED_MIGRATIONS_FINGERPRINT) {
    drift.push([
      '  EXPECTED_MIGRATIONS_FINGERPRINT',
      `    committed: ${EXPECTED_MIGRATIONS_FINGERPRINT}`,
      `    on disk:   ${migrationsFingerprint}`,
    ]);
  }
  if (schemaHash !== EXPECTED_SCHEMA_HASH) {
    drift.push([
      '  EXPECTED_SCHEMA_HASH',
      `    committed: ${EXPECTED_SCHEMA_HASH}`,
      `    on disk:   ${schemaHash}`,
    ]);
  }

  if (drift.length > 0) {
    throw new Error(
      [
        'the committed schema fingerprints do not match the migrations on disk.',
        '',
        ...drift.flat(),
        '',
        'A migration was added or edited without regenerating them. Shipping this would',
        'make every production install refuse to start with a schema error that points at',
        "the merchant's database instead of at this build.",
        '',
        '  Fix:  pnpm --filter @loyalty-pro/api db:template',
        '        git add apps/api/src/config/schema-fingerprint.ts apps/api/prisma/loyalty-pro-template.json',
        '',
      ].join('\n'),
    );
  }

  say(`schema fingerprints match the migrations on disk (${migrationsFingerprint.slice(0, 12)})`);
}

async function main(): Promise<void> {
  if (process.argv.includes('--check')) return checkTemplate();
  return buildTemplate();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
