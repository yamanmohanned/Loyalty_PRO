import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API_PREFIX, buildApp } from '../app';
import {
  afterFailedAttempt,
  isLocked,
  minutesRemaining,
  type LockState,
} from '../services/lockout.service';
import { resetDatabase } from './helpers/db';
import { createWorld, TEST_PASSWORD, type World } from './helpers/fixtures';

/**
 * Temporary account lockout (PRD FND-01), and the settings that govern it.
 *
 * Two things are being proved. That the lock works — five wrong passwords close the
 * account and the right one is then refused. And that it is always a *temporary* lock
 * with a way out, because the failure this feature can cause is a till that cannot sign
 * in with a queue in front of it, and that is a worse day for the merchant than the
 * attack the lock prevents.
 */

const prisma = new PrismaClient();
let app: FastifyInstance;
let world: World;

beforeAll(async () => {
  app = await buildApp({ rateLimit: false });
  await app.ready();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  world = await createWorld(prisma);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

function login(username: string, password: string) {
  return app.inject({
    method: 'POST',
    url: `${API_PREFIX}/auth/login`,
    payload: { username, password },
  });
}

const WRONG = 'definitely-not-the-password';

async function failTimes(username: string, times: number) {
  const responses = [];
  for (let i = 0; i < times; i += 1) responses.push(await login(username, WRONG));
  return responses;
}

/** Publishes merchant settings directly — the engine's own routes are tested elsewhere. */
async function setLimits(merchantId: string, attempts: number, minutes: number) {
  await prisma.settingVersion.create({
    data: {
      merchantId,
      scope: 'MERCHANT',
      scopeId: null,
      version: 1,
      values: JSON.stringify({
        'security.login_attempts': attempts,
        'security.lockout_minutes': minutes,
      }),
    },
  });
}

describe('FND-01: the rules, without a database', () => {
  const limits = { maxAttempts: 3, lockMinutes: 5 };
  const now = new Date('2026-09-20T10:00:00Z');

  it('counts up to the limit and then locks', () => {
    let state = { failedAttempts: 0, lockedUntil: null as Date | null };
    state = afterFailedAttempt(state, limits, now);
    expect(state).toMatchObject({ failedAttempts: 1, lockedUntil: null });
    state = afterFailedAttempt(state, limits, now);
    expect(state).toMatchObject({ failedAttempts: 2, lockedUntil: null });

    const locked = afterFailedAttempt(state, limits, now);
    expect(locked.justLocked).toBe(true);
    expect(locked.lockedUntil).toEqual(new Date('2026-09-20T10:05:00Z'));
  });

  /**
   * The denial-of-service guard. Anybody can guess `station`, so anybody could hold the
   * till closed all evening if every further attempt pushed the end of the lock out.
   */
  it('does not extend a lock that is already in force, however hard it is hammered', () => {
    const locked = { failedAttempts: 3, lockedUntil: new Date('2026-09-20T10:05:00Z') };
    let state: LockState = locked;
    for (let i = 0; i < 50; i += 1) state = afterFailedAttempt(state, limits, now);
    expect(state.lockedUntil).toEqual(locked.lockedUntil);
    expect(state.failedAttempts).toBe(3);
  });

  /**
   * Otherwise waiting out a five-minute lock buys one attempt: the counter would still
   * be at the ceiling, so the next typo would re-lock instantly.
   */
  it('starts counting again once a lock has lapsed', () => {
    const lapsed = { failedAttempts: 3, lockedUntil: new Date('2026-09-20T09:55:00Z') };
    const next = afterFailedAttempt(lapsed, limits, now);
    expect(next).toMatchObject({ failedAttempts: 1, lockedUntil: null, justLocked: false });
  });

  it('rounds the remaining wait up, so nobody is told to wait zero minutes', () => {
    const state = { failedAttempts: 3, lockedUntil: new Date(now.getTime() + 10_000) };
    expect(isLocked(state, now)).toBe(true);
    expect(minutesRemaining(state, now)).toBe(1);
  });
});

describe('FND-01: signing in', () => {
  it('locks the account on the configured attempt, and says so on that attempt', async () => {
    await setLimits(world.merchantId, 3, 5);

    const [first, second, third] = await failTimes('station', 3);
    expect(first?.statusCode).toBe(401);
    expect(first?.json().error.message).toContain('اسم المستخدم أو كلمة المرور');
    expect(second?.json().error.message).toContain('اسم المستخدم أو كلمة المرور');
    // The attempt that trips it says so, rather than leaving it to be discovered next time.
    expect(third?.json().error.message).toContain('مقفل مؤقتاً');
  });

  /** The whole point: after the lock, the RIGHT password is refused too. */
  it('refuses the correct password while the lock is in force', async () => {
    await setLimits(world.merchantId, 3, 5);
    await failTimes('station', 3);

    const response = await login('station', TEST_PASSWORD);
    expect(response.statusCode).toBe(401);
    expect(response.json().error.message).toContain('مقفل مؤقتاً');
    expect(response.json().error.message).toContain('المدير');
  });

  it('lets the account straight back in once the lock has passed', async () => {
    await setLimits(world.merchantId, 3, 5);
    await failTimes('station', 3);

    await prisma.user.update({
      where: { id: world.stationUserId },
      data: { lockedUntil: new Date(Date.now() - 1_000) },
    });

    const response = await login('station', TEST_PASSWORD);
    expect(response.statusCode).toBe(200);
  });

  it('forgets the failures after a successful sign-in', async () => {
    await setLimits(world.merchantId, 3, 5);
    await failTimes('station', 2);
    expect((await login('station', TEST_PASSWORD)).statusCode).toBe(200);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: world.stationUserId } });
    expect(user.failedAttempts).toBe(0);
    expect(user.lockedUntil).toBeNull();
  });

  /** Locking one account must not close the shop. */
  it('locks only the account that failed', async () => {
    await setLimits(world.merchantId, 3, 5);
    await failTimes('station', 3);

    expect((await login('station', TEST_PASSWORD)).statusCode).toBe(401);
    expect((await login('owner', TEST_PASSWORD)).statusCode).toBe(200);
  });

  /**
   * The count comes from the settings engine, so this is also the proof that a setting
   * declared in the registry is a setting something actually reads.
   */
  it("obeys the merchant's configured attempt count rather than the default", async () => {
    await setLimits(world.merchantId, 8, 5);
    const responses = await failTimes('station', 5);
    for (const response of responses) {
      expect(response.json().error.message).toContain('اسم المستخدم أو كلمة المرور');
    }
    expect((await login('station', TEST_PASSWORD)).statusCode).toBe(200);
  });

  it('never locks a username that does not exist', async () => {
    await setLimits(world.merchantId, 3, 5);
    const responses = await failTimes('nobody-by-that-name', 6);
    for (const response of responses) {
      expect(response.statusCode).toBe(401);
      expect(response.json().error.message).not.toContain('مقفل');
    }
  });
});

describe('FND-01: getting back in without waiting', () => {
  /**
   * The lock's worst case is a till stuck mid-queue, so the remedy has to be somebody
   * already in the shop. A manager, not only the owner — the owner may be elsewhere.
   */
  it('lets a manager lift the lock immediately', async () => {
    await setLimits(world.merchantId, 3, 60);
    await failTimes('station', 3);
    expect((await login('station', TEST_PASSWORD)).statusCode).toBe(401);

    const manager = (await login('manager', TEST_PASSWORD)).json().tokens.accessToken as string;
    const unlocked = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/users/${world.stationUserId}/unlock`,
      headers: { authorization: `Bearer ${manager}` },
    });

    expect(unlocked.statusCode).toBe(200);
    expect((await login('station', TEST_PASSWORD)).statusCode).toBe(200);
  });

  it('refuses the station operator the ability to unlock anybody', async () => {
    const station = (await login('station', TEST_PASSWORD)).json().tokens.accessToken as string;
    const response = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/users/${world.stationUserId}/unlock`,
      headers: { authorization: `Bearer ${station}` },
    });
    expect(response.statusCode).toBe(403);
  });

  it('never unlocks an account belonging to another merchant', async () => {
    const other = await prisma.merchant.create({ data: { name: 'متجر آخر' } });
    const stranger = await prisma.user.create({
      data: {
        merchantId: other.id,
        name: 'غريب',
        username: 'stranger',
        passwordHash: 'x',
        role: 'STATION',
        failedAttempts: 9,
        lockedUntil: new Date(Date.now() + 3_600_000),
      },
    });

    const owner = (await login('owner', TEST_PASSWORD)).json().tokens.accessToken as string;
    const response = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/users/${stranger.id}/unlock`,
      headers: { authorization: `Bearer ${owner}` },
    });

    expect(response.statusCode).toBe(404);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: stranger.id } });
    expect(after.lockedUntil).not.toBeNull();
  });
});

describe('FND-01: the trail', () => {
  /**
   * One row per lock, not one per wrong password. The question asked later is «why could
   * the till not sign in on Thursday evening», and a row per attempt buries its answer.
   */
  it('records the lock once, however many attempts followed it', async () => {
    await setLimits(world.merchantId, 3, 60);
    await failTimes('station', 7);

    const locks = await prisma.auditLog.findMany({
      where: { merchantId: world.merchantId, action: 'staff.locked' },
    });
    expect(locks).toHaveLength(1);
    expect(locks[0]?.entityId).toBe(world.stationUserId);
    expect(locks[0]?.actorUserId).toBeNull();
  });

  it('records who lifted a lock', async () => {
    await setLimits(world.merchantId, 3, 60);
    await failTimes('station', 3);

    const manager = (await login('manager', TEST_PASSWORD)).json().tokens.accessToken as string;
    await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/users/${world.stationUserId}/unlock`,
      headers: { authorization: `Bearer ${manager}` },
    });

    const entries = await prisma.auditLog.findMany({
      where: { merchantId: world.merchantId, action: 'staff.unlocked' },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actorUserId).toBe(world.managerId);
    expect(entries[0]?.entityId).toBe(world.stationUserId);
  });
});
