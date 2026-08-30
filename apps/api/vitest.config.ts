import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'vitest/config';

loadDotenv({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

// One database per run, named here so the workers, the migrator and the teardown all
// agree. A fixed name let two concurrent `pnpm test` invocations truncate each other's
// rows mid-assertion, which surfaces as a flake in whatever test was unlucky rather than
// as the collision it is.
const runId = `${process.pid}`;
const testDbName = `walaa_test_${runId}.db`;

// Relative file: URLs resolve from the Prisma schema directory.
const testUrl = `file:./${testDbName}`;

const testBackupDir = fileURLToPath(new URL(`./prisma/test-backups-${runId}`, import.meta.url));

// The `env` block below reaches the test WORKERS. Global setup and teardown run in this
// process, so the path has to be here too — without it the teardown had nothing to
// delete and every run left a staging directory behind.
process.env.BACKUP_LOCAL_DIR = testBackupDir;

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globalSetup: ['./src/__tests__/helpers/global-setup.ts'],
    // Serial. These tests share one database and truncate between cases, so
    // parallel files would delete each other's rows mid-assertion.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: testUrl,
      WALAA_TEST_DB_NAME: testDbName,
      // A fixed key so backup tests are deterministic. Real installations generate
      // their own (see `services/backup/key.ts`); this one exists only here.
      BACKUP_KEY: 'd2FsYWEtdGVzdC1iYWNrdXAta2V5LTMyLWJ5dGVzISE=',
      // Keeps snapshots, archives and staging out of the developer's data directory.
      // Per run for the same reason as the database: two suites sharing one staging
      // directory would delete each other's snapshots mid-backup.
      BACKUP_LOCAL_DIR: testBackupDir,
    },
  },
});
