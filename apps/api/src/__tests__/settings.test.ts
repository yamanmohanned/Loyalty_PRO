import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API_PREFIX, buildApp } from '../app';
import { resetDatabase } from './helpers/db';
import { createWorld, TEST_PASSWORD, type World } from './helpers/fixtures';

/**
 * The settings engine over HTTP (PRD §4, FND-04).
 *
 * `packages/shared-types/src/__tests__/settings.test.ts` owns the registry's own
 * promises — bounds, scopes, resolution. What is asserted here is everything that only
 * exists once values are persisted: that a draft governs nothing until it is published,
 * that publishing is the single moment the shop's behaviour changes, that a rollback
 * adds to the history instead of rewriting it, and that both leave a trail.
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

async function tokenFor(username: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: `${API_PREFIX}/auth/login`,
    payload: { username, password: TEST_PASSWORD },
  });
  if (response.statusCode !== 200) {
    throw new Error(`login failed for ${username}: ${response.statusCode}`);
  }
  return response.json().tokens.accessToken as string;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function patchDraft(token: string, values: Record<string, unknown>) {
  return app.inject({
    method: 'PATCH',
    url: `${API_PREFIX}/settings/draft?scope=MERCHANT`,
    headers: auth(token),
    payload: { values },
  });
}

async function publish(token: string, note?: string) {
  return app.inject({
    method: 'POST',
    url: `${API_PREFIX}/settings/publish?scope=MERCHANT`,
    headers: auth(token),
    payload: note ? { note } : {},
  });
}

async function effective(token: string) {
  const response = await app.inject({
    method: 'GET',
    url: `${API_PREFIX}/settings/effective`,
    headers: auth(token),
  });
  return response.json().settings as Record<string, { value: unknown; origin: string }>;
}

describe('FND-04: a shop with no settings of its own', () => {
  it('is governed by the registry defaults, and says so', async () => {
    const settings = await effective(await tokenFor('owner'));
    expect(settings['station.receipt_fade_ms']).toEqual({ value: 500, origin: 'SYSTEM' });
    expect(settings['security.login_attempts']?.origin).toBe('SYSTEM');
  });

  /**
   * The Station is governed by several of these — the fade, the card display, the idle
   * reset — so it has to be able to read them. It still cannot read the registry or the
   * drafts: §3 keeps every settings surface on the manager's side.
   */
  it('lets the Station read the values it is governed by', async () => {
    const station = await tokenFor('station');
    const settings = await effective(station);
    expect(settings['station.card_display_ms']?.value).toBe(3_000);

    const registry = await app.inject({
      method: 'GET',
      url: `${API_PREFIX}/settings/registry`,
      headers: auth(station),
    });
    expect(registry.statusCode).toBe(403);
  });
});

describe('FND-04: the draft', () => {
  /**
   * The promise §4 makes. A manager reconfiguring the station mid-afternoon must not be
   * changing the station mid-afternoon — the states between his first field and his last
   * are not ones anybody chose.
   */
  it('changes nothing a shop is running until it is published', async () => {
    const owner = await tokenFor('owner');

    await patchDraft(owner, { 'station.receipt_fade_ms': 2_000 });
    expect((await effective(owner))['station.receipt_fade_ms']?.value).toBe(500);

    const published = await publish(owner);
    expect(published.statusCode).toBe(200);
    expect((await effective(owner))['station.receipt_fade_ms']).toEqual({
      value: 2_000,
      origin: 'MERCHANT',
    });
  });

  /**
   * Keeping the good values matters more than it looks. A screen that discards six
   * correct edits because the seventh was out of range is one people stop trusting, and
   * then stop using.
   */
  it('keeps the values it accepted and reports the ones it did not', async () => {
    const owner = await tokenFor('owner');
    const response = await patchDraft(owner, {
      'security.login_attempts': 999,
      'backup.daily_time': '04:30',
      'nope.not_a_setting': 1,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.draft).toEqual({ 'backup.daily_time': '04:30' });
    expect(body.rejected.map((r: { key: string }) => r.key).sort()).toEqual([
      'nope.not_a_setting',
      'security.login_attempts',
    ]);
  });

  /** Null is the only way back to inheriting — distinct from setting today's default. */
  it('removes an override when the value is null, returning the setting to the layer beneath', async () => {
    const owner = await tokenFor('owner');
    await patchDraft(owner, { 'station.idle_reset_seconds': 120 });
    await publish(owner);
    expect((await effective(owner))['station.idle_reset_seconds']?.origin).toBe('MERCHANT');

    await patchDraft(owner, { 'station.idle_reset_seconds': null });
    await publish(owner);
    expect((await effective(owner))['station.idle_reset_seconds']).toEqual({
      value: 20,
      origin: 'SYSTEM',
    });
  });

  it('can be thrown away without touching what is published', async () => {
    const owner = await tokenFor('owner');
    await patchDraft(owner, { 'station.receipt_fade_ms': 1_100 });
    await publish(owner);
    await patchDraft(owner, { 'station.receipt_fade_ms': 4_000 });

    const discarded = await app.inject({
      method: 'DELETE',
      url: `${API_PREFIX}/settings/draft?scope=MERCHANT`,
      headers: auth(owner),
    });
    expect(discarded.statusCode).toBe(200);
    expect((await effective(owner))['station.receipt_fade_ms']?.value).toBe(1_100);
  });

  it('refuses to publish when there is nothing to publish', async () => {
    const owner = await tokenFor('owner');
    const response = await publish(owner);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('NO_DRAFT');
  });
});

describe('FND-04: who may change what', () => {
  /**
   * The screen disables what a manager may not edit. A disabled field is not an absent
   * one, so the same rule is enforced where it cannot be skipped.
   */
  it('refuses a manager an owner-only setting, and names which', async () => {
    const manager = await tokenFor('manager');
    const response = await patchDraft(manager, { 'security.lockout_minutes': 30 });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.details.keys).toEqual(['security.lockout_minutes']);
  });

  it('lets a manager change a setting that is his to change', async () => {
    const manager = await tokenFor('manager');
    const response = await patchDraft(manager, { 'station.card_display_ms': 5_000 });
    expect(response.statusCode).toBe(200);
    expect(response.json().rejected).toEqual([]);
  });

  /**
   * One owner-only key in a payload refuses the payload. Accepting the rest would mean a
   * manager could half-apply a change he is not allowed to make, which is worse than a
   * clean refusal because it is invisible.
   */
  it('refuses the whole payload when one key is beyond the role', async () => {
    const manager = await tokenFor('manager');
    const response = await patchDraft(manager, {
      'station.card_display_ms': 4_000,
      'locale.timezone': 'Asia/Dubai',
    });
    expect(response.statusCode).toBe(403);

    const view = await app.inject({
      method: 'GET',
      url: `${API_PREFIX}/settings?scope=MERCHANT`,
      headers: auth(manager),
    });
    expect(view.json().draft).toBeNull();
  });
});

describe('FND-04: versions and rollback', () => {
  it('numbers versions from one and keeps them newest-first', async () => {
    const owner = await tokenFor('owner');

    await patchDraft(owner, { 'station.receipt_fade_ms': 1_000 });
    expect((await publish(owner, 'أبطأ قليلاً')).json().version).toBe(1);

    await patchDraft(owner, { 'station.receipt_fade_ms': 1_500 });
    expect((await publish(owner)).json().version).toBe(2);

    const versions = await app.inject({
      method: 'GET',
      url: `${API_PREFIX}/settings/versions?scope=MERCHANT`,
      headers: auth(owner),
    });
    const list = versions.json().versions as Array<{ version: number; note: string | null }>;
    expect(list.map((v) => v.version)).toEqual([2, 1]);
    expect(list[1]?.note).toBe('أبطأ قليلاً');
  });

  /**
   * The point of the whole design. A history that rewrote itself could not answer the
   * question it is kept for — «what was this set to on the day it went wrong» — so a
   * rollback goes forward: it publishes the old values as a NEW version and says where
   * they came from.
   */
  it('restores old values by publishing them again, without deleting what came after', async () => {
    const owner = await tokenFor('owner');

    await patchDraft(owner, { 'station.receipt_fade_ms': 1_000 });
    await publish(owner);
    await patchDraft(owner, { 'station.receipt_fade_ms': 4_500 });
    await publish(owner);
    expect((await effective(owner))['station.receipt_fade_ms']?.value).toBe(4_500);

    const rolled = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/settings/rollback?scope=MERCHANT`,
      headers: auth(owner),
      payload: { version: 1 },
    });

    expect(rolled.statusCode).toBe(200);
    expect(rolled.json().version).toBe(3);
    expect((await effective(owner))['station.receipt_fade_ms']?.value).toBe(1_000);

    const versions = await app.inject({
      method: 'GET',
      url: `${API_PREFIX}/settings/versions?scope=MERCHANT`,
      headers: auth(owner),
    });
    const list = versions.json().versions as Array<{ version: number; rolledBackFrom: number | null }>;
    expect(list.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(list[0]?.rolledBackFrom).toBe(1);
  });

  /**
   * A draft written before the rollback would re-apply the very change the rollback
   * undid, the next time anybody pressed publish — and it would look like the rollback
   * had silently failed.
   */
  it('clears a leftover draft, so a later publish cannot undo the rollback', async () => {
    const owner = await tokenFor('owner');
    await patchDraft(owner, { 'station.receipt_fade_ms': 1_000 });
    await publish(owner);
    await patchDraft(owner, { 'station.receipt_fade_ms': 4_500 });
    await publish(owner);
    await patchDraft(owner, { 'station.receipt_fade_ms': 4_900 });

    await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/settings/rollback?scope=MERCHANT`,
      headers: auth(owner),
      payload: { version: 1 },
    });

    const view = await app.inject({
      method: 'GET',
      url: `${API_PREFIX}/settings?scope=MERCHANT`,
      headers: auth(owner),
    });
    expect(view.json().draft).toBeNull();
  });

  it('refuses a version that does not exist', async () => {
    const owner = await tokenFor('owner');
    const response = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/settings/rollback?scope=MERCHANT`,
      headers: auth(owner),
      payload: { version: 9 },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NO_SUCH_VERSION');
  });

  /**
   * Declared in `config.roles`, so the refusal happens before validation. An in-handler
   * check answered a manager with 400 for a malformed body and 403 only for a well-formed
   * one — a refusal that depends on the shape of the request is not a refusal, and the
   * RBAC matrix caught it.
   */
  it('refuses a manager a rollback whatever his body looks like', async () => {
    const manager = await tokenFor('manager');
    for (const payload of [{}, { version: 1 }, { version: 'x' }]) {
      const response = await app.inject({
        method: 'POST',
        url: `${API_PREFIX}/settings/rollback?scope=MERCHANT`,
        headers: auth(manager),
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(403);
    }
  });
});

describe('FND-04: the trail', () => {
  /**
   * §4 point 4 and FND-06. The draft is deliberately absent from it: a trail carrying
   * every keystroke of a manager changing his mind buries the one row that matters —
   * the moment a value started governing the shop.
   */
  it('records a publish with the old and new values, and records no draft', async () => {
    const owner = await tokenFor('owner');
    await patchDraft(owner, { 'station.receipt_fade_ms': 1_000 });
    await publish(owner);
    await patchDraft(owner, { 'station.receipt_fade_ms': 2_000 });
    await publish(owner);

    const entries = await prisma.auditLog.findMany({
      where: { merchantId: world.merchantId, action: 'settings.published' },
      orderBy: { createdAt: 'asc' },
    });

    expect(entries).toHaveLength(2);
    expect(entries[0]?.actorUserId).toBe(world.ownerId);
    expect(JSON.parse(entries[1]?.beforeJson ?? '{}')).toEqual({
      'station.receipt_fade_ms': 1_000,
    });
    expect(JSON.parse(entries[1]?.afterJson ?? '{}')).toEqual({
      'station.receipt_fade_ms': 2_000,
    });
  });

  it('records a rollback as its own kind of event', async () => {
    const owner = await tokenFor('owner');
    await patchDraft(owner, { 'station.receipt_fade_ms': 1_000 });
    await publish(owner);
    await patchDraft(owner, { 'station.receipt_fade_ms': 2_000 });
    await publish(owner);

    await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/settings/rollback?scope=MERCHANT`,
      headers: auth(owner),
      payload: { version: 1 },
    });

    const rollbacks = await prisma.auditLog.findMany({
      where: { merchantId: world.merchantId, action: 'settings.rolled_back' },
    });
    expect(rollbacks).toHaveLength(1);
    expect(JSON.parse(rollbacks[0]?.afterJson ?? '{}')).toEqual({
      'station.receipt_fade_ms': 1_000,
    });
  });
});

describe('FND-04: tenant isolation', () => {
  /**
   * Every query in the service is scoped by merchant. Asserted because the settings
   * tables are new and A9 — «تاجران على الـHub: لا يرى أحدهما بيانات الآخر» — is a
   * property of every table, not of the ones that had it first.
   */
  it('never lets one merchant read or publish over another', async () => {
    const owner = await tokenFor('owner');
    await patchDraft(owner, { 'station.receipt_fade_ms': 1_234 });
    await publish(owner);

    const other = await prisma.merchant.create({ data: { name: 'متجر آخر' } });
    await prisma.settingVersion.create({
      data: {
        merchantId: other.id,
        scope: 'MERCHANT',
        scopeId: null,
        version: 1,
        values: JSON.stringify({ 'station.receipt_fade_ms': 4_321 }),
      },
    });

    expect((await effective(owner))['station.receipt_fade_ms']?.value).toBe(1_234);

    const versions = await app.inject({
      method: 'GET',
      url: `${API_PREFIX}/settings/versions?scope=MERCHANT`,
      headers: auth(owner),
    });
    expect(versions.json().versions).toHaveLength(1);
  });
});
