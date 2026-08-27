import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'vitest/config';

loadDotenv({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

// Point every worker at the test database before any module loads a Prisma client.
const testUrl = (() => {
  const base = process.env.DATABASE_URL;
  if (!base) return undefined;
  const url = new URL(base);
  url.pathname = '/walaa_test';
  return url.toString();
})();

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
      ...(testUrl ? { DATABASE_URL: testUrl } : {}),
    },
  },
});
