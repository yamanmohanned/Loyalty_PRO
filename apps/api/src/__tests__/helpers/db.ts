import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
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
 */

const API_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TEST_DB_DIR = join(API_ROOT, 'prisma');
const TEST_DB_FILE = join(TEST_DB_DIR, 'walaa_test.db');

/** Prisma resolves a relative file: URL from the schema directory. */
export const TEST_DATABASE_URL = 'file:./walaa_test.db';

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
 */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$queryRawUnsafe('PRAGMA foreign_keys = OFF');
  const tables = [
    'audit_log',
    'notification_log',
    'voucher',
    'transaction',
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
}
