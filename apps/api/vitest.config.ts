import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'vitest/config';

loadDotenv({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

// Point every worker at the SQLite test database file before any module loads a
// Prisma client. Relative file: URLs resolve from the schema directory.
const testUrl = 'file:./walaa_test.db';

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
      // A fixed key so backup tests are deterministic. Real installations generate
      // their own (see `services/backup/key.ts`); this one exists only here.
      BACKUP_KEY: 'd2FsYWEtdGVzdC1iYWNrdXAta2V5LTMyLWJ5dGVzISE=',
      // Keeps snapshots, archives and staging out of the developer's data directory.
      BACKUP_LOCAL_DIR: fileURLToPath(new URL('./prisma/test-backups', import.meta.url)),
    },
  },
});
