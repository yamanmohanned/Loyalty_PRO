import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
 *   prisma/walaa-template.db    the migrated, empty, identity-stamped database
 *   prisma/walaa-template.json  its sha256, its fingerprints, its migration list
 *   src/config/schema-fingerprint.ts   the two constants compiled into the binary
 *
 * The JSON is content-addressed on purpose, following `demo-credentials.json`: a
 * timestamp cannot say WHICH bytes were verified, and `stage.mjs` refuses to ship a
 * template whose hash does not match the record.
 *
 *   pnpm --filter @walaa/api db:template
 */

const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEMPLATE_PATH = join(API_ROOT, 'prisma', DB_TEMPLATE_FILENAME);
const RECORD_PATH = join(API_ROOT, 'prisma', 'walaa-template.json');
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

async function main(): Promise<void> {
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

    writeFileSync(
      CONSTANTS_PATH,
      constantsFile(migrationsFingerprint, schemaHash, generatedAt),
      'utf8',
    );

    say(`template     ${bytes.length} bytes  sha256 ${sha256}`);
    say(`schema hash  ${schemaHash}`);
    say(`migrations   ${migrationsFingerprint}`);
    say(`wrote ${RECORD_PATH}`);
    say(`wrote ${CONSTANTS_PATH}`);
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

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
