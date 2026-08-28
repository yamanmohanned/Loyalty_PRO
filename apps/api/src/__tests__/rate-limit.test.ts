import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API_PREFIX, buildApp } from '../app';
import { resetDatabase } from './helpers/db';
import { createWorld, TEST_PASSWORD } from './helpers/fixtures';

/**
 * Rate limiting (CLAUDE.md §7.5).
 *
 * Its own file, with limiting left ON — the other HTTP suites disable it so their
 * assertions are not knocked over by a shared bucket.
 */

const prisma = new PrismaClient();
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ rateLimit: true });
  await app.ready();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  await createWorld(prisma);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('login throttling', () => {
  it('answers 429 with the shared envelope once the limit is passed', async () => {
    // /auth/login allows 10 a minute; brute-forcing credentials is the whole
    // reason this endpoint is capped tighter than the rest of the API.
    const responses = [];
    for (let i = 0; i < 14; i += 1) {
      responses.push(
        await app.inject({
          method: 'POST',
          url: `${API_PREFIX}/auth/login`,
          payload: { username: 'manager', password: 'wrong-password' },
        }),
      );
    }

    const throttled = responses.filter((r) => r.statusCode === 429);
    expect(throttled.length).toBeGreaterThan(0);

    // The status matters as much as the refusal: a client needs 429 to know to
    // back off. Answering 500 here would look like a server fault and invite a retry.
    const body = throttled[0]?.json();
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.message).toBeTruthy();
    expect(body.error).toHaveProperty('requestId');
  });

  it('never answers 500 when throttling', async () => {
    const responses = [];
    for (let i = 0; i < 14; i += 1) {
      responses.push(
        await app.inject({
          method: 'POST',
          url: `${API_PREFIX}/auth/login`,
          payload: { username: 'manager', password: TEST_PASSWORD },
        }),
      );
    }
    expect(responses.some((r) => r.statusCode === 500)).toBe(false);
  });
});
