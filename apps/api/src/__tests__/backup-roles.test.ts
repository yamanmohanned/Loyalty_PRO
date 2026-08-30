import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API_PREFIX, buildApp } from '../app';
import { loadEnv } from '../config/env';
import { resetDatabase } from './helpers/db';
import { createWorld, TEST_PASSWORD } from './helpers/fixtures';

/**
 * Who may do what in the backup key ceremony (CLAUDE_v3.md §12.19).
 *
 * ## Why this suite exists
 *
 * The first operator to open the ceremony was locked out of the product. The gate
 * blocked every dashboard role, but generating and revealing the key were OWNER-only —
 * so a manager logging in first met a wall with no means past it: they could not reveal
 * the key, therefore could not type it back, therefore could not reach the dashboard, on
 * that login or any later one. Logout was the only exit, and the wall was waiting again.
 *
 * The split is now deliberate and is pinned here, because it is exactly the kind of rule
 * that gets "simplified" back into a single DASHBOARD_ROLES by someone tidying up:
 *
 *  - **generate and reveal are the OWNER's.** They produce and display the one secret
 *    that makes every archive readable, and a manager who could generate but not reveal
 *    would mint a key nobody has ever seen.
 *  - **confirm is open to any dashboard role.** Whoever is holding the printed key can
 *    complete the ceremony — which is the point of printing it.
 *  - **The client wall follows the same line.** A role that cannot perform the ceremony
 *    is never shown it.
 */

const prisma = new PrismaClient();
let app: FastifyInstance;

const url = (path: string) => `${API_PREFIX}${path}`;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function tokenFor(username: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: url('/auth/login'),
    payload: { username, password: TEST_PASSWORD },
  });
  if (response.statusCode !== 200) throw new Error(`login failed for ${username}`);
  return response.json().tokens.accessToken as string;
}

beforeAll(async () => {
  app = await buildApp({ rateLimit: false });
  await app.ready();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  // The suite asserts on roles, not on the world it needs one to exist in.
  await createWorld(prisma);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('generating and revealing the key', () => {
  it('is refused to a manager', async () => {
    const manager = await tokenFor('manager');

    const generate = await app.inject({
      method: 'POST',
      url: url('/backup/key/generate'),
      headers: bearer(manager),
    });
    const reveal = await app.inject({
      method: 'POST',
      url: url('/backup/key/reveal'),
      headers: bearer(manager),
    });

    expect(generate.statusCode).toBe(403);
    expect(reveal.statusCode).toBe(403);
  });

  it('is refused to the Station outright', async () => {
    const station = await tokenFor('station');
    const response = await app.inject({
      method: 'POST',
      url: url('/backup/key/reveal'),
      headers: bearer(station),
    });
    expect(response.statusCode).toBe(403);
  });

  it('is allowed to the owner', async () => {
    const owner = await tokenFor('owner');
    const response = await app.inject({
      method: 'POST',
      url: url('/backup/key/reveal'),
      headers: bearer(owner),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().key).toBe(loadEnv().BACKUP_KEY);
  });
});

describe('reading the key status', () => {
  it('is open to a manager, so the banner can explain the situation', async () => {
    // A manager must be able to LEARN that backups are off — otherwise the standing
    // banner cannot say anything, and the state is invisible to the person most likely
    // to be looking at the dashboard all day.
    const manager = await tokenFor('manager');
    const response = await app.inject({
      method: 'GET',
      url: url('/backup/key'),
      headers: bearer(manager),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ configured: true, everConfirmed: false });
  });

  it('is refused to the Station', async () => {
    const station = await tokenFor('station');
    const response = await app.inject({
      method: 'GET',
      url: url('/backup/key'),
      headers: bearer(station),
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('confirming the key', () => {
  it('is allowed to a manager holding the printed key', async () => {
    // The ceremony prints the key so it can leave the machine. Refusing the confirmation
    // to the person holding that paper would make the printing pointless.
    const manager = await tokenFor('manager');
    const response = await app.inject({
      method: 'POST',
      url: url('/backup/key/confirm'),
      headers: bearer(manager),
      payload: { key: loadEnv().BACKUP_KEY },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ confirmed: true, backupsEnabled: true });
  });

  it('rejects a wrong key without saying how it was wrong', async () => {
    const owner = await tokenFor('owner');
    const response = await app.inject({
      method: 'POST',
      url: url('/backup/key/confirm'),
      headers: bearer(owner),
      payload: { key: Buffer.alloc(32, 9).toString('base64') },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('a manager is never stranded', () => {
  it('can reach the dashboard’s data while the ceremony is outstanding', async () => {
    // The lockout in full: with the ceremony outstanding, a manager must still be able
    // to load the app. If this ever 403s or the client walls them again, the product is
    // unusable for that role until the owner appears.
    const manager = await tokenFor('manager');

    const overview = await app.inject({
      method: 'GET',
      url: url('/backup'),
      headers: bearer(manager),
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().key.backupsEnabled).toBe(false);
  });

  it('still cannot cause a backup to run', async () => {
    // Not stranded is not the same as unblocked. Backups stay off until the key is
    // confirmed, whoever is asking.
    const manager = await tokenFor('manager');
    const response = await app.inject({
      method: 'POST',
      url: url('/backup/run'),
      headers: bearer(manager),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('BACKUP_BLOCKED');
  });
});
