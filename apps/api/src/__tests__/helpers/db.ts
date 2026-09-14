import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '@prisma/client';

/**
 * Test database lifecycle (SQLite).
 *
 * Tests run against a **separate database file**, never the dev one. The suite
 * empties tables between cases, and pointing that at development data would
 * destroy it — the isolation is a safety property, not a convenience.
 *
 * SQLite makes this simpler than Postgres did: the "server" is a file, so setup is
 * deleting it and re-running migrations.
 *
 * **The file name is unique per run.** It used to be a fixed `walaa_test.db`, and two
 * concurrent `pnpm test` invocations — a developer running the suite while one is
 * already going in a terminal or an agent's background job — then truncated each other's
 * rows mid-assertion. The failures land in whichever test happened to be running, look
 * like flakes in unrelated code, and cost an afternoon before anyone suspects the
 * database. The name comes from `vitest.config.ts` so the workers, the migrator here and
 * the teardown all agree on it.
 */

const API_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TEST_DB_DIR = join(API_ROOT, 'prisma');

/** Set by `vitest.config.ts`; the fallback keeps a bare `vitest` invocation working. */
const TEST_DB_NAME = process.env.WALAA_TEST_DB_NAME ?? `walaa_test_${process.pid}.db`;
const TEST_DB_FILE = join(TEST_DB_DIR, TEST_DB_NAME);

/** Prisma resolves a relative file: URL from the schema directory. */
export const TEST_DATABASE_URL = `file:./${TEST_DB_NAME}`;

/**
 * Removes this run's database, its sidecars, and its backup staging directory.
 *
 * All of it here rather than in any one suite's `afterAll`: the backup directory is
 * created by whichever test file happens to run first and added to by several, so a
 * single file cleaning up leaves whatever the others wrote afterwards. Global teardown
 * is the only point that is definitively last.
 */
export function dropTestDatabase(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const path = `${TEST_DB_FILE}${suffix}`;
    if (existsSync(path)) rmSync(path, { force: true });
  }

  const backups = process.env.BACKUP_LOCAL_DIR;
  if (backups && existsSync(backups)) {
    rmSync(backups, { recursive: true, force: true });
  }

  const licenseDir = process.env.WALAA_LICENSE_DIR;
  if (licenseDir && existsSync(licenseDir)) {
    rmSync(licenseDir, { recursive: true, force: true });
  }

  // The run's own registry key (never `Software\Walaa`). Loaded here rather than at the
  // top: this file is also imported by global setup, before any licence exists.
  const registryKey = process.env.WALAA_LICENSE_REGISTRY_KEY;
  if (registryKey && registryKey !== 'Software\\Walaa') {
    process.env.VITEST ??= 'true';
    const native = createRequire(import.meta.url)('@walaa/license-native') as {
      deleteRegistryKeyForTests?: (subkey: string) => void;
    };
    native.deleteRegistryKeyForTests?.(registryKey);
  }
}

/**
 * Recreates the test database from scratch and applies migrations.
 *
 * Deletes the file first so every run starts from a known schema — a stale file
 * from an older migration state is the kind of failure that wastes an afternoon.
 * The `-wal` and `-shm` sidecars must go too, or SQLite will recover state from
 * them into the "fresh" database.
 */
export function prepareTestDatabase(): void {
  if (!existsSync(TEST_DB_DIR)) mkdirSync(TEST_DB_DIR, { recursive: true });

  for (const suffix of ['', '-wal', '-shm']) {
    const path = `${TEST_DB_FILE}${suffix}`;
    if (existsSync(path)) rmSync(path);
  }

  // `migrate deploy` applies committed migrations without prompting or authoring
  // new ones, which is what a test bootstrap wants.
  execSync('pnpm exec prisma migrate deploy', {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'pipe',
  });
}

/**
 * Empties every table between tests.
 *
 * SQLite has no `TRUNCATE ... CASCADE`, so this deletes in dependency order with
 * foreign keys momentarily off — faster than ordering perfectly, and the tables
 * are all repopulated by the next fixture anyway.
 *
 * ── The list must be complete, and it was not ────────────────────────────────
 *
 * `card` and `card_batch` were missing. With foreign keys turned off for the delete
 * the cascade from `customer` never fires, so every card ever created by a test
 * survived into the next one, pointing at a customer that no longer existed. A restore
 * taken part-way through the suite reported **16 `foreign_key_check` violations** in a
 * database that had just been "reset" — which is how this was found.
 *
 * Two costs, and neither is cosmetic. Any assertion about referential integrity is
 * unmakeable against a database that is quietly accumulating orphans; and stale rows in
 * `card` are live lookup material, so one suite's card numbers are visible to the next.
 *
 * The rule the list has to satisfy: **every table a migration creates, except the ones
 * the runtime owns.** `db_identity` and `demo_provenance` are deliberately absent —
 * they identify the file rather than hold a merchant's data, and deleting them would
 * make each test re-adopt the database it is already running on.
 *
 * ── And a licence ───────────────────────────────────────────────────────────────
 *
 * Every test before licensing assumed a shop that may trade. So the reset ends with a
 * perpetual, every-feature licence for this machine — signed with the test key and
 * checked by the real Rust verifier — and a clean set of clock anchors. A licensing
 * test that wants another state removes it (`removeLicenses`) and builds its own.
 */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$queryRawUnsafe('PRAGMA foreign_keys = OFF');
  const tables = [
    'license_activation',
    'installation_state',
    'audit_log',
    'notification_log',
    'voucher',
    'transaction',
    'card',
    'card_batch',
    'feature_flag',
    'discount_rule',
    'discount_settings',
    'customer',
    'refresh_token',
    'user',
    'branch',
    'merchant',
  ];
  for (const table of tables) {
    await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
  }
  await prisma.$queryRawUnsafe('PRAGMA foreign_keys = ON');

  const { resetLicensingForTests } = await import('../../services/license.service');
  const { installTestLicense } = await import('./license');
  resetLicensingForTests();
  await installTestLicense(prisma);
}
