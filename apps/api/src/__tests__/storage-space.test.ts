import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { RealtimeEvent } from '@walaa/shared-types';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API_PREFIX, buildApp } from '../app';
import { AUDIT_ACTIONS } from '../services/audit.service';
import { resetSubscribers, subscribe } from '../services/realtime.service';
import {
  CRITICAL_FREE_BYTES,
  WARN_FREE_BYTES,
  classify,
  currentStorageStatus,
  monitoredPath,
  readFreeSpace,
  resetStorageState,
  sample,
} from '../services/storage.service';
import { resetDatabase } from './helpers/db';
import { createWorld, TEST_PASSWORD, type World } from './helpers/fixtures';

/**
 * Free space on the database volume (CLAUDE_v3.md §12.15).
 *
 * The feature exists because the failure is quiet: SQLite refuses writes cleanly and
 * keeps serving reads, so a full disk renders a perfectly healthy-looking dashboard
 * beside a till where every scan errors. The tests here pin the three properties that
 * decide whether the warning is worth having.
 *
 * **The hysteresis, because a flapping banner is a banner nobody reads.** Most of this
 * file is the state machine: it is pure, it has no natural failure signal in production
 * (a wrong margin looks like a slightly twitchy banner), and it is the part a later
 * tidy-up is most likely to "simplify" into a plain comparison.
 *
 * **UNKNOWN is not OK.** An unreadable volume reported as healthy is the same bug as an
 * agent reporting healthy while capturing nothing.
 *
 * **The endpoint needs a session.** Free space on the machine holding every sale this
 * business has recorded is not something an unauthenticated caller on the shop wifi is
 * owed, and `/health` — which is public — must not grow into a status page.
 */

const prisma = new PrismaClient();
let app: FastifyInstance;
let world: World;

const url = (path: string) => `${API_PREFIX}${path}`;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** A reader that always answers the same figure, standing in for a volume of that size. */
const reading = (freeBytes: number) => () => ({ freeBytes, totalBytes: 500 * 1024 ** 3 });

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
  resetSubscribers();
  // Hysteresis is remembered across calls by design, so a verdict left behind by one
  // case would silently change the next one's starting point.
  resetStorageState();
  world = await createWorld(prisma);
});

afterAll(async () => {
  resetStorageState();
  await app.close();
  await prisma.$disconnect();
});

const GIB = 1024 ** 3;

describe('the §12.15 thresholds', () => {
  it('places the edges where §12.15 put them', () => {
    expect(WARN_FREE_BYTES).toBe(5 * GIB);
    expect(CRITICAL_FREE_BYTES).toBe(2 * GIB);
  });

  it('reads a first sample at face value, with no history to be sticky about', () => {
    expect(classify(20 * GIB, 'UNKNOWN')).toBe('OK');
    expect(classify(4 * GIB, 'UNKNOWN')).toBe('WARN');
    expect(classify(1 * GIB, 'UNKNOWN')).toBe('CRITICAL');
  });
});

describe('hysteresis', () => {
  it('worsens immediately, with no margin to clear', () => {
    // The asymmetry that matters. A late alarm costs the outage; an alarm that lingers
    // costs a banner nobody minds.
    expect(classify(4.99 * GIB, 'OK')).toBe('WARN');
    expect(classify(1.99 * GIB, 'WARN')).toBe('CRITICAL');
    expect(classify(1.99 * GIB, 'OK')).toBe('CRITICAL');
  });

  it('holds WARN until the volume clears 20% above the 5 GB edge', () => {
    expect(classify(5.1 * GIB, 'WARN')).toBe('WARN');
    expect(classify(5.99 * GIB, 'WARN')).toBe('WARN');
    expect(classify(6 * GIB, 'WARN')).toBe('OK');
  });

  it('holds CRITICAL until the volume clears 20% above the 2 GB edge', () => {
    expect(classify(2.1 * GIB, 'CRITICAL')).toBe('CRITICAL');
    expect(classify(2.39 * GIB, 'CRITICAL')).toBe('CRITICAL');
    expect(classify(2.4 * GIB, 'CRITICAL')).toBe('WARN');
  });

  it('climbs two rungs in one sample when the volume clears both bars', () => {
    // Freeing 20 GB should not leave the banner sitting at WARN for another minute.
    expect(classify(20 * GIB, 'CRITICAL')).toBe('OK');
  });

  it('stops at the first bar not cleared when climbing from CRITICAL', () => {
    // Above the WARN edge but not 20% above it, so the verdict advances to WARN and no
    // further — the same reading from OK would also be WARN, which is the point: the
    // answer depends on the edge crossed, not on the direction of travel alone.
    expect(classify(5.5 * GIB, 'CRITICAL')).toBe('WARN');
  });

  it('does not flap for a volume oscillating on an edge', () => {
    // The scenario the margin exists for: Windows writing and deleting temporary files
    // around the 5 GB mark. Without hysteresis this sequence produces four transitions.
    let level = classify(4.9 * GIB, 'OK');
    expect(level).toBe('WARN');

    for (const free of [5.05, 4.95, 5.2, 4.8]) {
      level = classify(free * GIB, level);
      expect(level).toBe('WARN');
    }
  });
});

describe('sampling', () => {
  it('reports an unreadable volume as UNKNOWN rather than OK', async () => {
    const status = await sample({ path: join(monitoredPath(), 'no-such-directory-here') });

    expect(status.level).toBe('UNKNOWN');
    expect(status.freeBytes).toBeNull();
    expect(status.error).toBeTruthy();
  });

  it('measures the real volume holding the database', async () => {
    // Not a mocked reading: proves `monitoredPath` resolves to something `statfsSync`
    // can actually answer for, which is the one part no injected reader can vouch for.
    const space = readFreeSpace(monitoredPath());

    expect(space.freeBytes).toBeGreaterThan(0);
    expect(space.totalBytes).toBeGreaterThanOrEqual(space.freeBytes);
  });

  it('takes the next reading at face value after a failed one', async () => {
    await sample({ path: join(monitoredPath(), 'no-such-directory-here') });
    const recovered = await sample({ read: reading(1 * GIB) });

    // UNKNOWN carries no history, so this is CRITICAL immediately rather than being
    // held back by a re-arm bar it has no business clearing.
    expect(recovered.level).toBe('CRITICAL');
  });
});

describe('announcing a change', () => {
  it('pushes over the realtime channel when the verdict changes', async () => {
    const events: RealtimeEvent[] = [];
    subscribe(world.merchantId, (event) => events.push(event));

    await sample({ read: reading(20 * GIB) });
    await sample({ read: reading(1 * GIB) });

    const storage = events.filter((event) => event.type === 'STORAGE_LEVEL_CHANGED');
    expect(storage).toHaveLength(1);
    expect(storage[0]).toMatchObject({
      level: 'CRITICAL',
      previousLevel: 'OK',
      freeBytes: 1 * GIB,
    });
  });

  it('does not treat the first healthy reading after boot as news', async () => {
    const events: RealtimeEvent[] = [];
    subscribe(world.merchantId, (event) => events.push(event));

    await sample({ read: reading(20 * GIB) });

    // UNKNOWN → OK on every service start would put a row in the audit trail every time
    // the machine reboots, which is how a trail stops being read.
    expect(events).toHaveLength(0);
    const rows = await prisma.auditLog.findMany({
      where: { action: AUDIT_ACTIONS.STORAGE_LEVEL_CHANGED },
    });
    expect(rows).toHaveLength(0);
  });

  it('announces on the first reading when the machine boots already in trouble', async () => {
    const events: RealtimeEvent[] = [];
    subscribe(world.merchantId, (event) => events.push(event));

    await sample({ read: reading(1 * GIB) });

    expect(events.filter((event) => event.type === 'STORAGE_LEVEL_CHANGED')).toHaveLength(1);
  });

  it('says nothing while the verdict is unchanged', async () => {
    await sample({ read: reading(20 * GIB) });

    const events: RealtimeEvent[] = [];
    subscribe(world.merchantId, (event) => events.push(event));

    // A minute apart in production, and the disk has barely moved. Broadcasting each of
    // these would be a heartbeat nobody reads.
    await sample({ read: reading(19 * GIB) });
    await sample({ read: reading(18 * GIB) });

    expect(events).toHaveLength(0);
  });

  it('records the change, so a disk that filled overnight leaves a trace', async () => {
    await sample({ read: reading(20 * GIB) });
    await sample({ read: reading(1 * GIB) });

    const rows = await prisma.auditLog.findMany({
      where: { merchantId: world.merchantId, action: AUDIT_ACTIONS.STORAGE_LEVEL_CHANGED },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorUserId).toBeNull();
    expect(JSON.parse(rows[0]!.afterJson!)).toMatchObject({ level: 'CRITICAL' });
  });

  it('reports on a machine that has no merchant row yet', async () => {
    // The sampler's first pass runs moments after migrations, which on a fresh install
    // is before anybody has been provisioned. Assuming a merchant exists here would turn
    // the very first boot on a nearly-full disk into a crash instead of a warning.
    await resetDatabase(prisma);

    const status = await sample({ read: reading(1 * GIB) });
    expect(status.level).toBe('CRITICAL');
  });
});

describe('GET /system/storage', () => {
  it('refuses an unauthenticated caller', async () => {
    const response = await app.inject({ method: 'GET', url: url('/system/storage') });
    expect(response.statusCode).toBe(401);
  });

  it('refuses the Station', async () => {
    const station = await tokenFor('station');
    const response = await app.inject({
      method: 'GET',
      url: url('/system/storage'),
      headers: bearer(station),
    });
    expect(response.statusCode).toBe(403);
  });

  it('answers a manager with the current verdict and when it was taken', async () => {
    const manager = await tokenFor('manager');
    const response = await app.inject({
      method: 'GET',
      url: url('/system/storage'),
      headers: bearer(manager),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(['OK', 'WARN', 'CRITICAL', 'UNKNOWN']).toContain(body.level);
    expect(body.path).toBe(monitoredPath());
    expect(Date.parse(body.sampledAt)).not.toBeNaN();
  });

  it('serves the sampler reading rather than taking its own while it is fresh', async () => {
    const taken = await sample({ read: reading(1 * GIB) });
    const served = await currentStorageStatus();

    // One clock. If the endpoint re-measured on every request it would disagree with the
    // pushed events at exactly the boundary where disagreement is most confusing.
    expect(served).toEqual(taken);
  });

  it('leaves /health public and silent about the disk', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);

    /*
      Exhaustive on purpose, and worth keeping exhaustive.

      This is the only endpoint that answers without a token, so anything added to it
      is disclosed to anybody who can reach the port. An assertion that merely checked
      for the ABSENCE of disk keys would let the next field through unnoticed; matching
      the whole set means every addition has to be made here, deliberately, by someone
      who has read this comment.

      `version` and `demo` were added for «تغيير الخادم», which has to tell a wrong
      address from a wrong product from a wrong version — and cannot, from a response
      that only says "ok". Both are properties of the build, not of the machine or its
      data: neither names a path, a host, a size or a customer.
    */
    expect(Object.keys(response.json()).sort()).toEqual(
      ['demo', 'service', 'status', 'version'].sort(),
    );
  });
});
