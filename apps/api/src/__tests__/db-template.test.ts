import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import {
  EXPECTED_MIGRATIONS_FINGERPRINT,
  EXPECTED_SCHEMA_HASH,
} from '../config/schema-fingerprint';
import { resolveMigrationsDir } from '../config/paths';
import {
  computeMigrationsFingerprint,
  computeSchemaHash,
  stampIdentity,
} from '../lib/db-identity';
import { stampDemoProvenance } from '../lib/demo-guard';
import { applyPendingMigrations } from '../lib/migrate';
import { applySqlitePragmas } from '../lib/prisma';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE COMMITTED FINGERPRINTS ARE DERIVED VALUES, AND ARE CHECKED LIKE ONE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── What went wrong, and why fixing it by hand was not a fix ─────────────────
 *
 * `EXPECTED_MIGRATIONS_FINGERPRINT` and `EXPECTED_SCHEMA_HASH` are compiled into the
 * service and decide whether it will open a database at all. They shipped once as
 * placeholder values that had never been generated — a guard that, in production,
 * would have refused every merchant's perfectly correct database on the grounds that
 * it did not match a constant nobody had computed.
 *
 * Running the generator by hand fixed that instance and left the mechanism intact: the
 * next migration added without remembering to regenerate does the same thing again,
 * and does it at a shop rather than here. A constant that must be kept in step with
 * something else by memory is a bomb with a long fuse.
 *
 * So they are treated as **derived**, and a derived value that is committed gets
 * checked the way a lockfile does. This recomputes both from the migrations on disk
 * and fails if the committed values disagree.
 *
 * ── Where else this runs ─────────────────────────────────────────────────────
 *
 * Here (so CI and `pnpm test` catch it), in `.githooks/pre-commit` (so a migration
 * cannot be committed without it), and at the head of `pnpm package:build` (so nothing
 * is staged for a merchant without it). Three gates because the three of them fail for
 * different people at different moments, and the cheapest one to notice is the earliest.
 *
 * ── Why the template's sha256 is deliberately NOT asserted ───────────────────
 *
 * Every build stamps a fresh installation id into the template, so its bytes change on
 * every run by design. Asserting them would fail on every rebuild and teach whoever
 * reads this to skip it — which is how a check stops being one. The two values here
 * are semantic: the schema the migrations produce, and the identity of the migration
 * set itself. Both are stable given the same inputs.
 */

const API_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratchDirs: string[] = [];

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/** Applies every committed migration to a throwaway database and hashes the result. */
async function schemaHashOfMigrations(directory: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'walaa-template-test-'));
  scratchDirs.push(dir);

  const path = join(dir, 'check.db').replace(/\\/g, '/');
  const client = new PrismaClient({ datasourceUrl: `file:${path}` });
  try {
    await applySqlitePragmas(client);
    await applyPendingMigrations({ client, directory, log: () => {} });
    return await computeSchemaHash(client);
  } finally {
    await client.$disconnect().catch(() => undefined);
  }
}

describe('the schema fingerprints compiled into this build', () => {
  const directory = resolveMigrationsDir(API_ROOT);

  it('finds the migrations directory at all', () => {
    expect(directory).toBeTruthy();
  });

  it('matches the migration set on disk', () => {
    const actual = computeMigrationsFingerprint(directory!);
    expect(
      actual,
      'EXPECTED_MIGRATIONS_FINGERPRINT is stale. Run `pnpm --filter @loyalty-pro/api db:template` ' +
        'and commit src/config/schema-fingerprint.ts and prisma/loyalty-pro-template.json.',
    ).toBe(EXPECTED_MIGRATIONS_FINGERPRINT);
  });

  it('matches the schema those migrations actually produce', async () => {
    const actual = await schemaHashOfMigrations(directory!);
    expect(
      actual,
      'EXPECTED_SCHEMA_HASH is stale. Run `pnpm --filter @loyalty-pro/api db:template` and commit ' +
        'src/config/schema-fingerprint.ts and prisma/loyalty-pro-template.json.',
    ).toBe(EXPECTED_SCHEMA_HASH);
  }, 60_000);

  /**
   * ── The exclusion list, checked by behaviour rather than by reading it ──────
   *
   * `computeSchemaHash` skips the tables the RUNTIME writes — `db_identity` and
   * `demo_provenance` — because including them would make the hash change the instant
   * it was first recorded: a check that invalidates itself on second boot.
   *
   * That skip list is hand-maintained, which makes it the same kind of bomb as the
   * fingerprints themselves. A fourth runtime-written table added without a line in
   * `HASH_EXCLUDED` changes every database's hash the first time it is created, and
   * every install then refuses to start — on its second launch, after appearing to
   * work perfectly on its first.
   *
   * Asserting the list's contents would just be a second copy of it to forget. So the
   * invariant is asserted instead: stamping everything the runtime stamps must not
   * move the hash. A new table breaks this the day it is written, here, rather than
   * the day after a shop installs it.
   */
  it('is unchanged by everything the runtime itself writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'walaa-runtime-tables-'));
    scratchDirs.push(dir);

    const path = join(dir, 'runtime.db').replace(/\\/g, '/');
    const client = new PrismaClient({ datasourceUrl: `file:${path}` });
    try {
      await applySqlitePragmas(client);
      await applyPendingMigrations({ client, directory: directory!, log: () => {} });

      const beforeRuntimeWrites = await computeSchemaHash(client);

      await stampIdentity({ client, createdBy: 'db-template.test' });
      await stampDemoProvenance('db-template.test', client);

      expect(
        await computeSchemaHash(client),
        'A table the runtime creates is being counted in the schema hash. It must be ' +
          'added to HASH_EXCLUDED in db-identity.ts, or every installation will refuse ' +
          'to start on its second launch.',
      ).toBe(beforeRuntimeWrites);
    } finally {
      await client.$disconnect().catch(() => undefined);
    }
  }, 60_000);

  /**
   * The record beside the shipped template has to agree with the compiled constants
   * too. `stage.mjs` refuses to ship a template whose bytes do not match this record,
   * so a record that disagrees with the binary is a release that fails late instead of
   * here.
   *
   * Skipped rather than failed when the template is absent: a fresh checkout has not
   * built one yet, and `package:build` builds it before anything is staged.
   */
  it('agrees with the record beside the shipped template', () => {
    const recordPath = join(API_ROOT, 'prisma', 'loyalty-pro-template.json');
    let record: { schemaHash?: string; migrationsFingerprint?: string };
    try {
      record = JSON.parse(readFileSync(recordPath, 'utf8')) as typeof record;
    } catch {
      return; // not built in this checkout yet
    }

    expect(record.migrationsFingerprint).toBe(EXPECTED_MIGRATIONS_FINGERPRINT);
    expect(record.schemaHash).toBe(EXPECTED_SCHEMA_HASH);
  });
});
