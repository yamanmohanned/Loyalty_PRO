import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { dropTestDatabase, prepareTestDatabase, TEST_DATABASE_URL } from './db';

/**
 * Runs once before the suite: loads the repo-root .env, then recreates the SQLite
 * test database and applies migrations to it.
 *
 * The returned teardown deletes the run's database. Without it, per-run naming would
 * leave one file per invocation accumulating in `prisma/` — trading a concurrency bug
 * for a litter problem on the drive §12.15 is about.
 */
export default async function setup(): Promise<() => void> {
  loadDotenv({ path: fileURLToPath(new URL('../../../../../.env', import.meta.url)) });
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  prepareTestDatabase();

  return () => dropTestDatabase();
}
