import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { prepareTestDatabase, TEST_DATABASE_URL } from './db';

/**
 * Runs once before the suite: loads the repo-root .env, then recreates the SQLite
 * test database and applies migrations to it.
 */
export default async function setup(): Promise<void> {
  loadDotenv({ path: fileURLToPath(new URL('../../../../../.env', import.meta.url)) });
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  prepareTestDatabase();
}
