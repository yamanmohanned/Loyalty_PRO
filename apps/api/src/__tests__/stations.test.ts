import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PAIRING_ALPHABET, PAIRING_CODE_LENGTH, normalisePairingCode } from '@loyalty-pro/shared-types';
import { API_PREFIX, buildApp } from '../app';
import { STATION_DEVICE_HEADER } from '../plugins/auth';
import { resetLastSeenThrottleForTests } from '../services/station.service';
import { resetDatabase } from './helpers/db';
import { createWorld, TEST_PASSWORD, type World } from './helpers/fixtures';

/**
 * Station provisioning (PRD §7, FND-03).
 *
 * The two acceptance criteria are what is actually being tested: a device paired
 * without anybody technical present, and a revoked device stopped on its next request
 * rather than on its next token refresh.
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
  resetLastSeenThrottleForTests();
  world = await createWorld(prisma);
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
  return response.json().tokens.accessToken as string;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function create(token: string, name = 'صندوق 1', type = 'LOYALTY') {
  return app.inject({
    method: 'POST',
    url: `${API_PREFIX}/stations`,
    headers: auth(token),
    payload: { name, type },
  });
}

async function pair(code: string, deviceLabel?: string) {
  return app.inject({
    method: 'POST',
    url: `${API_PREFIX}/stations/pair`,
    payload: deviceLabel ? { code, deviceLabel } : { code },
  });
}

describe('creating a station', () => {
  it('returns a pairing code and a URL, and starts it waiting to be paired', async () => {
    const owner = await tokenFor('owner');
    const response = await create(owner);

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.station.status).toBe('PENDING');
    expect(body.station.pairable).toBe(true);
    expect(body.pairing.url).toContain(encodeURIComponent(body.pairing.code));

    // Grouped for reading, and every character from the confusable-free alphabet.
    expect(body.pairing.code).toMatch(/^[^-]{4}-[^-]{4}-[^-]{4}$/);
    const bare = normalisePairingCode(body.pairing.code);
    expect(bare).toHaveLength(PAIRING_CODE_LENGTH);
    for (const character of bare) expect(PAIRING_ALPHABET).toContain(character);
  });

  /**
   * The code is what a QR carries and what somebody reads down a telephone. Storing it
   * in the clear would make a database copy — a backup, a support export — a set of
   * keys to every till waiting to be paired.
   */
  it('never stores the pairing code itself', async () => {
    const owner = await tokenFor('owner');
    const { pairing } = (await create(owner)).json();
    const bare = normalisePairingCode(pairing.code);

    const row = await prisma.station.findFirstOrThrow({ where: { merchantId: world.merchantId } });
    expect(row.pairingCodeHash).not.toBeNull();
    expect(row.pairingCodeHash).not.toContain(bare);
    expect(row.deviceTokenHash).toBeNull();
  });

  it('refuses a duplicate name, because names are how stations are told apart', async () => {
    const owner = await tokenFor('owner');
    expect((await create(owner, 'صندوق 1')).statusCode).toBe(201);

    const second = await create(owner, 'صندوق 1');
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('NAME_TAKEN');
  });

  it('refuses the station operator the ability to create one', async () => {
    const station = await tokenFor('station');
    expect((await create(station)).statusCode).toBe(403);
  });
});

describe('pairing a device', () => {
  it('exchanges the code for a device token, once', async () => {
    const owner = await tokenFor('owner');
    const { pairing } = (await create(owner)).json();

    const paired = await pair(pairing.code, 'لوحي الكاشير');
    expect(paired.statusCode).toBe(200);
    const token = paired.json().deviceToken as string;
    expect(token.length).toBeGreaterThan(40);

    // The same code a second time is refused: it was destroyed by the first use.
    const again = await pair(pairing.code);
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe('BAD_CODE');
  });

  it('accepts the code however it was typed', async () => {
    const owner = await tokenFor('owner');
    const { pairing } = (await create(owner)).json();
    const messy = ` ${normalisePairingCode(pairing.code).toLowerCase()} `;

    expect((await pair(messy)).statusCode).toBe(200);
  });

  it('stores only a digest of the device token', async () => {
    const owner = await tokenFor('owner');
    const { pairing } = (await create(owner)).json();
    const token = (await pair(pairing.code)).json().deviceToken as string;

    const row = await prisma.station.findFirstOrThrow({ where: { merchantId: world.merchantId } });
    expect(row.deviceTokenHash).not.toBe(token);
    expect(row.deviceTokenHash).toHaveLength(64);
    expect(row.status).toBe('ACTIVE');
    expect(row.deviceLabel).toBeNull();
    // The code is gone, so the QR on the manager's screen is now worth nothing.
    expect(row.pairingCodeHash).toBeNull();
  });

  it('refuses an expired code', async () => {
    const owner = await tokenFor('owner');
    const { pairing } = (await create(owner)).json();

    await prisma.station.updateMany({
      where: { merchantId: world.merchantId },
      data: { pairingExpiresAt: new Date(Date.now() - 1_000) },
    });

    expect((await pair(pairing.code)).statusCode).toBe(400);
  });

  it('refuses a code that was never issued', async () => {
    expect((await pair('ABCD-EFGH-JKMN')).statusCode).toBe(400);
  });

  it('issues a fresh code when the first expired before the tablet arrived', async () => {
    const owner = await tokenFor('owner');
    const created = (await create(owner)).json();

    const reissued = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/stations/${created.station.id}/pairing`,
      headers: auth(owner),
    });
    expect(reissued.statusCode).toBe(200);
    expect(reissued.json().pairing.code).not.toBe(created.pairing.code);

    // The first code stops working the moment a second is issued.
    expect((await pair(created.pairing.code)).statusCode).toBe(400);
    expect((await pair(reissued.json().pairing.code)).statusCode).toBe(200);
  });

  /**
   * Re-pairing a live till from the manager's screen, with no revocation in between,
   * would be a way to move a shop's register onto another device quietly.
   */
  it('refuses to re-issue a code for a station that is already paired', async () => {
    const owner = await tokenFor('owner');
    const created = (await create(owner)).json();
    await pair(created.pairing.code);

    const response = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/stations/${created.station.id}/pairing`,
      headers: auth(owner),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('ALREADY_PAIRED');
  });
});

describe('what a paired device can ask', () => {
  async function paired() {
    const owner = await tokenFor('owner');
    const created = (await create(owner)).json();
    const deviceToken = (await pair(created.pairing.code)).json().deviceToken as string;
    return { owner, stationId: created.station.id as string, deviceToken };
  }

  /**
   * Answered with no user session at all, because the question is asked on the lock
   * screen: a tablet that was revoked overnight must find out before somebody signs in
   * and starts a sale.
   */
  it('tells a device it is still a station, without anybody signing in', async () => {
    const { deviceToken, stationId } = await paired();

    const response = await app.inject({
      method: 'GET',
      url: `${API_PREFIX}/stations/me`,
      headers: { [STATION_DEVICE_HEADER]: deviceToken },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().station.id).toBe(stationId);
  });

  it('tells an unknown device that it is not one', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${API_PREFIX}/stations/me`,
      headers: { [STATION_DEVICE_HEADER]: 'not-a-real-token' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('STATION_UNKNOWN');
  });

  it('records when the device was last seen', async () => {
    const { deviceToken, stationId } = await paired();
    await prisma.station.update({ where: { id: stationId }, data: { lastSeenAt: null } });
    resetLastSeenThrottleForTests();

    await app.inject({
      method: 'GET',
      url: `${API_PREFIX}/stations/me`,
      headers: { [STATION_DEVICE_HEADER]: deviceToken },
    });

    const row = await prisma.station.findUniqueOrThrow({ where: { id: stationId } });
    expect(row.lastSeenAt).not.toBeNull();
  });
});

describe('revoking', () => {
  /** FND-03's second acceptance criterion, and the reason the token is checked per request. */
  it('stops the device on its very next request', async () => {
    const owner = await tokenFor('owner');
    const created = (await create(owner)).json();
    const deviceToken = (await pair(created.pairing.code)).json().deviceToken as string;

    const before = await app.inject({
      method: 'GET',
      url: `${API_PREFIX}/stations/me`,
      headers: { [STATION_DEVICE_HEADER]: deviceToken },
    });
    expect(before.statusCode).toBe(200);

    await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/stations/${created.station.id}/revoke`,
      headers: auth(owner),
    });

    const after = await app.inject({
      method: 'GET',
      url: `${API_PREFIX}/stations/me`,
      headers: { [STATION_DEVICE_HEADER]: deviceToken },
    });
    expect(after.statusCode).toBe(401);
  });

  /** Belt and brace: even a bug that forgot the status could not resolve the old token. */
  it('clears the stored token as well as the status', async () => {
    const owner = await tokenFor('owner');
    const created = (await create(owner)).json();
    await pair(created.pairing.code);

    await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/stations/${created.station.id}/revoke`,
      headers: auth(owner),
    });

    const row = await prisma.station.findUniqueOrThrow({ where: { id: created.station.id } });
    expect(row.status).toBe('REVOKED');
    expect(row.deviceTokenHash).toBeNull();
    expect(row.revokedByUserId).toBe(world.ownerId);
  });

  it('refuses to revoke the same station twice', async () => {
    const owner = await tokenFor('owner');
    const created = (await create(owner)).json();
    const url = `${API_PREFIX}/stations/${created.station.id}/revoke`;

    expect((await app.inject({ method: 'POST', url, headers: auth(owner) })).statusCode).toBe(200);
    const second = await app.inject({ method: 'POST', url, headers: auth(owner) });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('ALREADY_REVOKED');
  });

  it('never revokes another merchant’s station', async () => {
    const other = await prisma.merchant.create({ data: { name: 'متجر آخر' } });
    const theirs = await prisma.station.create({
      data: { merchantId: other.id, type: 'LOYALTY', name: 'صندوقهم', status: 'ACTIVE' },
    });

    const owner = await tokenFor('owner');
    const response = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/stations/${theirs.id}/revoke`,
      headers: auth(owner),
    });

    expect(response.statusCode).toBe(404);
    expect((await prisma.station.findUniqueOrThrow({ where: { id: theirs.id } })).status).toBe('ACTIVE');
  });

  it('shows only this merchant’s stations in the list', async () => {
    const other = await prisma.merchant.create({ data: { name: 'متجر آخر' } });
    await prisma.station.create({
      data: { merchantId: other.id, type: 'LOYALTY', name: 'صندوقهم' },
    });

    const owner = await tokenFor('owner');
    await create(owner, 'صندوقي');

    const response = await app.inject({
      method: 'GET',
      url: `${API_PREFIX}/stations`,
      headers: auth(owner),
    });
    const names = (response.json().stations as Array<{ name: string }>).map((s) => s.name);
    expect(names).toEqual(['صندوقي']);
  });
});

describe('requiring a paired device', () => {
  async function requirePairing(required: boolean) {
    await prisma.settingVersion.create({
      data: {
        merchantId: world.merchantId,
        scope: 'MERCHANT',
        scopeId: null,
        version: 1,
        values: JSON.stringify({ 'security.require_paired_station': required }),
      },
    });
  }

  /**
   * Off by default, and it has to be: the Station app does not pair yet, and turning it
   * on before it does would lock every existing till out of its own register.
   */
  it('lets an unpaired station work while the setting is off', async () => {
    const station = await tokenFor('station');
    const response = await app.inject({
      method: 'GET',
      url: `${API_PREFIX}/customers/search?query=Ali`,
      headers: auth(station),
    });
    expect(response.statusCode).toBe(200);
  });

  it('refuses an unpaired station once the merchant turns it on', async () => {
    await requirePairing(true);
    const station = await tokenFor('station');

    const response = await app.inject({
      method: 'GET',
      url: `${API_PREFIX}/customers/search?query=Ali`,
      headers: auth(station),
    });
    expect(response.statusCode).toBe(401);
  });

  it('lets a paired station through with its device token', async () => {
    await requirePairing(true);
    const owner = await tokenFor('owner');
    const created = (await create(owner)).json();
    const deviceToken = (await pair(created.pairing.code)).json().deviceToken as string;

    const station = await tokenFor('station');
    const response = await app.inject({
      method: 'GET',
      url: `${API_PREFIX}/customers/search?query=Ali`,
      headers: { ...auth(station), [STATION_DEVICE_HEADER]: deviceToken },
    });
    expect(response.statusCode).toBe(200);
  });

  /** The manager is not a station and must never be caught by a station's rule. */
  it('never applies to the manager', async () => {
    await requirePairing(true);
    const owner = await tokenFor('owner');
    const response = await app.inject({
      method: 'GET',
      url: `${API_PREFIX}/stations`,
      headers: auth(owner),
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('the trail', () => {
  it('records creation, pairing and revocation', async () => {
    const owner = await tokenFor('owner');
    const created = (await create(owner)).json();
    await pair(created.pairing.code, 'لوحي الكاشير');
    await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/stations/${created.station.id}/revoke`,
      headers: auth(owner),
    });

    const actions = (
      await prisma.auditLog.findMany({
        where: { merchantId: world.merchantId, entityType: 'station' },
        orderBy: { createdAt: 'asc' },
      })
    ).map((entry) => entry.action);

    expect(actions).toEqual(['station.created', 'station.paired', 'station.revoked']);
  });

  /** Pairing has no actor by design: the device had no account at that moment. */
  it('records the pairing with no actor and with the label the device gave', async () => {
    const owner = await tokenFor('owner');
    const created = (await create(owner)).json();
    await pair(created.pairing.code, 'لوحي الكاشير');

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { merchantId: world.merchantId, action: 'station.paired' },
    });
    expect(entry.actorUserId).toBeNull();
    expect(JSON.parse(entry.afterJson ?? '{}').deviceLabel).toBe('لوحي الكاشير');
  });
});
