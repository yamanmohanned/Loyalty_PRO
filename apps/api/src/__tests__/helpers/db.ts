import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

/**
 * Test database lifecycle.
 *
 * Tests run against a **separate database** (`walaa_test`), never the dev one. The
 * suite truncates tables between tests, and pointing that at development data
 * would destroy it — the isolation here is a safety property, not a nicety.
 */

export const TEST_DATABASE_NAME = 'walaa_test';

/** The api package root, as a path `execSync` can use on Windows and POSIX alike. */
const API_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Rewrites the configured DATABASE_URL to point at the test database. */
export function testDatabaseUrl(): string {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL is not set — copy .env.example to .env');

  const url = new URL(base);
  url.pathname = `/${TEST_DATABASE_NAME}`;
  return url.toString();
}

/**
 * Creates the test database if absent and applies migrations. Runs once per suite.
 *
 * `migrate deploy`, not `migrate dev`: deploy applies committed migrations without
 * prompting or authoring new ones, which is exactly what a test bootstrap wants.
 */
export async function prepareTestDatabase(): Promise<void> {
  const configured = process.env.DATABASE_URL;
  if (!configured) throw new Error('DATABASE_URL is not set — copy .env.example to .env');

  // Connect to the maintenance database to issue CREATE DATABASE.
  const adminUrl = new URL(configured);
  adminUrl.pathname = '/postgres';
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });

  try {
    const existing = await admin.$queryRaw<Array<{ datname: string }>>`
      SELECT datname FROM pg_database WHERE datname = ${TEST_DATABASE_NAME}
    `;
    if (existing.length === 0) {
      // Identifier cannot be parameterised; the value is a module constant, not input.
      await admin.$executeRawUnsafe(`CREATE DATABASE "${TEST_DATABASE_NAME}"`);
    }
  } finally {
    await admin.$disconnect();
  }

  execSync('pnpm exec prisma migrate deploy', {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
    stdio: 'pipe',
  });
}

/**
 * Empties every table between tests.
 *
 * One TRUNCATE ... CASCADE rather than per-table deletes: dramatically faster, and
 * it sidesteps foreign-key ordering entirely.
 */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      audit_log,
      notification_log,
      balance_snapshot,
      coupon,
      transaction,
      customer_override_rule,
      loyalty_tier,
      loyalty_rule_set,
      customer,
      refresh_token,
      "user",
      branch,
      merchant
    RESTART IDENTITY CASCADE
  `);
}
