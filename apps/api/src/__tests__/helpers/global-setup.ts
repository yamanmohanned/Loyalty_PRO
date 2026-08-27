import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { prepareTestDatabase, testDatabaseUrl } from './db';

/**
 * Runs once before the suite: loads the repo-root .env, creates `walaa_test` if
 * needed, and applies migrations to it.
 */
export default async function setup(): Promise<void> {
  loadDotenv({ path: fileURLToPath(new URL('../../../../../.env', import.meta.url)) });
  await prepareTestDatabase();
  // Every worker inherits this, so no test can accidentally reach the dev database.
  process.env.DATABASE_URL = testDatabaseUrl();
}
