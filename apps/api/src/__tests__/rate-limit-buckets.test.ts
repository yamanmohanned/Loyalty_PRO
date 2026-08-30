import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API_PREFIX, buildApp } from '../app';
import { resetDatabase } from './helpers/db';
import { createWorld, TEST_PASSWORD } from './helpers/fixtures';

/**
 * Whose budget a rate limit spends (CLAUDE.md §7.5).
 *
 * Its own file rather than a case in `rate-limit.test.ts`: the buckets live in process
 * memory for the lifetime of one `buildApp`, and that suite deliberately exhausts the
 * login bucket — which then denies this suite the two logins it needs. A separate file
 * gets a separate app and a clean store, which is also the honest reading of what the
 * two suites are: different subjects that happen to share a mechanism.
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

describe('who a bucket belongs to', () => {
  async function tokenFor(username: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/auth/login`,
      payload: { username, password: TEST_PASSWORD },
    });
    if (response.statusCode !== 200) throw new Error(`login failed for ${username}`);
    return response.json().tokens.accessToken as string;
  }

  it('gives each authenticated caller its own budget', async () => {
    // The claim `keyGenerator` makes: a busy register must not exhaust the budget for
    // everyone else behind the same address. On a shop LAN that is not hypothetical —
    // the Station, the Agent and the manager app can share one machine, and under
    // `app.inject` they all arrive from 127.0.0.1 exactly as they would from one NAT.
    //
    // Load-bearing beyond fairness: if the bucket were per address, one client
    // recovering from an outage would throttle the till mid-sale.
    const manager = await tokenFor('manager');
    const station = await tokenFor('station');

    // /customers/search allows 30 a minute.
    for (let i = 0; i < 31; i += 1) {
      await app.inject({
        method: 'GET',
        url: `${API_PREFIX}/customers/search?query=07701234567`,
        headers: { authorization: `Bearer ${manager}` },
      });
    }

    const exhausted = await app.inject({
      method: 'GET',
      url: `${API_PREFIX}/customers/search?query=07701234567`,
      headers: { authorization: `Bearer ${manager}` },
    });
    expect(exhausted.statusCode).toBe(429);

    const other = await app.inject({
      method: 'GET',
      url: `${API_PREFIX}/customers/search?query=07701234567`,
      headers: { authorization: `Bearer ${station}` },
    });
    expect(other.statusCode).not.toBe(429);
  });
});
