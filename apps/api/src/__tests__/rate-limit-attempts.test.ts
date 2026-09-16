import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API_PREFIX, buildApp } from '../app';
import { rateLimitedMessage } from '../lib/errors';
import { resetDatabase } from './helpers/db';
import { createWorld, TEST_PASSWORD } from './helpers/fixtures';

/**
 * A limit counts attempts at the operation it guards — never a request refused before it.
 *
 * Found on 2026-09-16 in a merchant-facing way: «ربط حساب Google» did nothing visible, was
 * pressed again, and after ten presses answered «عدد كبير من المحاولات» — the limiter had
 * counted presses that never reached Google. The same shape existed on every limited route:
 * the limiter ran at `onRequest`, before validation and before each route's preconditions,
 * so «نسخ احتياطي الآن» pressed before the key ceremony spent a six-an-hour budget.
 *
 * Its own file, so its buckets are its own (see `rate-limit-buckets.test.ts`).
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

async function tokenFor(username: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: `${API_PREFIX}/auth/login`,
    payload: { username, password: TEST_PASSWORD },
  });
  if (response.statusCode !== 200) throw new Error(`login failed for ${username}: ${response.statusCode}`);
  return response.json().tokens.accessToken as string;
}

describe('what a limit counts', () => {
  it('does not count a backup refused because it could not start', async () => {
    // No key ceremony in the fixture world: every press is refused before any work. The
    // route allows twenty real runs an hour; thirty refusals must spend none of them.
    const owner = await tokenFor('owner');
    const statuses: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      const response = await app.inject({
        method: 'POST',
        url: `${API_PREFIX}/backup/run`,
        headers: { authorization: `Bearer ${owner}` },
      });
      statuses.push(response.statusCode);
      if (i === 0) expect(response.json().error.code).toBe('BACKUP_BLOCKED');
    }
    expect(statuses).not.toContain(429);
    expect(new Set(statuses).size).toBe(1);
  });

  it('does not count a request refused by validation', async () => {
    // /backup/key/confirm allows ten an hour, because it is an oracle for the key. A body
    // that is not even the right shape never reaches the comparison.
    const owner = await tokenFor('owner');
    const statuses: number[] = [];
    for (let i = 0; i < 15; i += 1) {
      const response = await app.inject({
        method: 'POST',
        url: `${API_PREFIX}/backup/key/confirm`,
        headers: { authorization: `Bearer ${owner}` },
        payload: { key: '', unexpected: true },
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.every((status) => status === 400)).toBe(true);
  });

  it('lets «ربط حساب Google» be pressed as often as a person presses it', async () => {
    // No OAuth client in the fixture world, so each press is refused with its reason —
    // twenty of them, and not one is a throttle.
    const owner = await tokenFor('owner');
    for (let i = 0; i < 20; i += 1) {
      const response = await app.inject({
        method: 'POST',
        url: `${API_PREFIX}/backup/drive/connect`,
        headers: { authorization: `Bearer ${owner}` },
        payload: {},
      });
      expect(response.statusCode).not.toBe(429);
      expect(response.json().error.message).toBeTruthy();
    }
  });

  it('still counts every attempt that reaches the operation', async () => {
    // Last in the file: it exhausts the login bucket every other test signs in through.
    // A wrong password reaches the check — the thing the login limit is for.
    const responses = [];
    for (let i = 0; i < 12; i += 1) {
      responses.push(
        await app.inject({
          method: 'POST',
          url: `${API_PREFIX}/auth/login`,
          payload: { username: 'manager', password: 'wrong-password' },
        }),
      );
    }
    const throttled = responses.find((response) => response.statusCode === 429);
    expect(throttled).toBeDefined();
    // And the refusal says how long, in words a person can act on.
    const body = throttled!.json();
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.message).toMatch(/انتظر (دقيقة واحدة|دقيقتين|\d+ دقائق|\d+ دقيقة) ثم أعد المحاولة/);
    expect(body.error.details.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe('the throttle sentence', () => {
  it('names the wait in whole minutes', () => {
    expect(rateLimitedMessage(20)).toContain('انتظر دقيقة واحدة');
    expect(rateLimitedMessage(61)).toContain('انتظر دقيقتين');
    expect(rateLimitedMessage(9 * 60)).toContain('انتظر 9 دقائق');
    expect(rateLimitedMessage(3599)).toContain('انتظر 60 دقيقة');
    expect(rateLimitedMessage(null)).toContain('انتظر دقيقة');
  });
});
