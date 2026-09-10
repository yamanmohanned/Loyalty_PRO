import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { resetDatabase } from './helpers/db';

const prisma = new PrismaClient();

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE TILL'S ACCOUNT — THE ONE THE PRODUCT COULD NOT CREATE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── The blocker ──────────────────────────────────────────────────────────────
 *
 * First run creates exactly one OWNER and says, in its own comment, that the till's
 * account is made from the dashboard afterwards. The endpoint and the screen it
 * deferred to did not exist.
 *
 * The consequence, found by walking a merchant's first sixty seconds on a machine with
 * no prior state: install, set up, sign in, dashboard — and then nothing, because the
 * **Loyalty Station could never be signed into**. The Station is where the entire core
 * loop lives, so the product could be installed and configured and could not do the
 * one thing it exists to do. The only `station` account that had ever existed was in
 * `prisma/seed.ts`, a development script that is not bundled into the service.
 *
 * ── Why this suite is not just "it creates a user" ───────────────────────────
 *
 * This is the only authenticated surface in the product that MINTS CREDENTIALS. Every
 * case below is a way that could go wrong in a shop rather than a way the happy path
 * could regress:
 *
 *   · a second OWNER — a second unrecoverable password with full reach
 *   · the owner's own password set from here — a reset for the account with none
 *   · a STATION with no branch — §13.9 verifies branch on every captured sale
 *   · a duplicate username differing only by case — two accounts, one human
 *   · a deactivated account still trading on the refresh token it already holds
 */

let app: Awaited<ReturnType<typeof buildApp>>;
type Injected = Awaited<ReturnType<FastifyInstance['inject']>>;

const OWNER = {
  merchantName: 'سوبرماركت الاختبار',
  branchName: 'الفرع الرئيسي',
  branchCode: 'TST-01',
  ownerName: 'صاحب المتجر',
  username: 'shopowner',
  password: 'a-long-enough-one',
};

let token = '';
let branchId = '';

beforeEach(async () => {
  await resetDatabase(prisma);
  app = await buildApp({ rateLimit: false });
  await app.ready();

  await app.inject({ method: 'POST', url: '/api/v1/auth/bootstrap', payload: OWNER });
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: OWNER.username, password: OWNER.password },
  });
  token = JSON.parse(login.body).tokens.accessToken;
  branchId = (await prisma.branch.findFirstOrThrow({ select: { id: true } })).id;
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const auth = { authorization: `Bearer ${''}` };
const asOwner = () => ({ authorization: `Bearer ${token}` });

const create = (payload: Record<string, unknown>): Promise<Injected> =>
  app.inject({ method: 'POST', url: '/api/v1/users', headers: asOwner(), payload });

const patch = (id: string, payload: Record<string, unknown>): Promise<Injected> =>
  app.inject({ method: 'PATCH', url: `/api/v1/users/${id}`, headers: asOwner(), payload });

const TILL = { name: 'محطة الصندوق', username: 'station', password: 'Till!2026', role: 'STATION' };

const fieldsOf = (response: Injected): Array<{ path: string; message: string }> =>
  JSON.parse(response.body).error?.fields ?? [];

describe('the shop can create the account its till signs in with', () => {
  it('creates a STATION bound to a branch, and it can actually sign in', async () => {
    const response = await create({ ...TILL, branchId });
    expect(response.statusCode).toBe(201);

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'station', password: 'Till!2026' },
    });
    expect(login.statusCode).toBe(200);

    const user = JSON.parse(login.body).user;
    expect(user.role).toBe('STATION');
    // Bound, and to the branch it was given: §13.9 checks this on every captured sale.
    expect(user.branchCode).toBe('TST-01');
  });

  it('lists the accounts, with the branches to choose from', async () => {
    await create({ ...TILL, branchId });
    const response = await app.inject({ method: 'GET', url: '/api/v1/users', headers: asOwner() });

    const body = JSON.parse(response.body);
    expect(body.users.map((u: { username: string }) => u.username).sort()).toEqual([
      'shopowner',
      'station',
    ]);
    expect(body.branches).toHaveLength(1);
    // No password material of any kind crosses this boundary.
    expect(response.body).not.toContain('passwordHash');
    expect(response.body).not.toContain('$argon2');
  });
});

describe('what it refuses', () => {
  it('cannot be asked for a second OWNER', async () => {
    /*
      Refused by the SCHEMA (`StaffRoleSchema` is `MANAGER | STATION`), not by a check
      in the handler — so the guarantee holds for any caller that reaches the route,
      including one that skips whatever the handler remembers to validate.
    */
    const response = await create({ ...TILL, role: 'OWNER', branchId });
    expect(response.statusCode).toBe(400);
    expect(fieldsOf(response)[0]?.path).toBe('role');
    expect(await prisma.user.count({ where: { role: 'OWNER' } })).toBe(1);
  });

  it('cannot set the OWNER’s password, which is the account with no reset', async () => {
    const owner = await prisma.user.findFirstOrThrow({ where: { role: 'OWNER' } });
    const response = await patch(owner.id, { password: 'somethingelse' });

    expect(response.statusCode).toBe(403);
    // And the owner's own password still works — nothing was half-applied.
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: OWNER.username, password: OWNER.password },
    });
    expect(login.statusCode).toBe(200);
  });

  it('refuses a STATION with no branch, and says which field', async () => {
    const response = await create(TILL);
    expect(response.statusCode).toBe(400);
    expect(fieldsOf(response)).toEqual([
      { path: 'branchId', message: 'حساب المحطة يجب أن يرتبط بفرع' },
    ]);
  });

  it('refuses a branch belonging to another installation', async () => {
    const response = await create({
      ...TILL,
      branchId: '00000000-0000-4000-8000-000000000000',
    });
    expect(response.statusCode).toBe(400);
    expect(fieldsOf(response)[0]?.path).toBe('branchId');
  });

  it('refuses a username that differs only by case', async () => {
    expect((await create({ ...TILL, branchId })).statusCode).toBe(201);

    const again = await create({ ...TILL, username: 'STATION', branchId });
    expect(again.statusCode).toBe(400);
    expect(fieldsOf(again)[0]?.path).toBe('username');
    expect(await prisma.user.count({ where: { username: { in: ['station', 'STATION'] } } })).toBe(1);
  });

  it('refuses the development seed’s password here too', async () => {
    const response = await create({ ...TILL, password: 'Walaa!Dev2026', branchId });
    expect(response.statusCode).toBe(400);
    expect(fieldsOf(response)[0]?.path).toBe('password');
  });

  it('is closed to a MANAGER, not only hidden from one', async () => {
    await create({ ...TILL, name: 'مدير ثانٍ', username: 'manager2', role: 'MANAGER', branchId });
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'manager2', password: 'Till!2026' },
    });
    const managerToken = JSON.parse(login.body).tokens.accessToken;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { ...TILL, username: 'station2', branchId },
    });
    expect(response.statusCode).toBe(403);
  });

  it('is closed to nobody at all', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/users', headers: auth });
    expect(response.statusCode).toBe(401);
  });
});

describe('deactivating an account', () => {
  it('stops it signing in AND throws away the session it already had', async () => {
    /*
      ── The half of this that is easy to leave out ──────────────────────────

      Flipping `isActive` stops the next LOGIN. It does nothing about the refresh
      token the till is already holding, and a till that keeps rotating one trades
      indefinitely — which is the exact thing somebody deactivating an account is
      trying to stop. The whole chain is revoked with the flag.
    */
    const created = await create({ ...TILL, branchId });
    const id = JSON.parse(created.body).id;

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'station', password: 'Till!2026' },
    });
    const refreshToken = JSON.parse(login.body).tokens.refreshToken;

    expect((await patch(id, { isActive: false })).statusCode).toBe(200);

    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'station', password: 'Till!2026' },
    });
    expect(again.statusCode).toBe(401);

    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken },
    });
    expect(refreshed.statusCode).not.toBe(200);
  });

  it('lets the owner set a new password, which is the reset a till needs', async () => {
    const created = await create({ ...TILL, branchId });
    const id = JSON.parse(created.body).id;

    expect((await patch(id, { password: 'NewTill!2026' })).statusCode).toBe(200);

    const old = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'station', password: 'Till!2026' },
    });
    expect(old.statusCode).toBe(401);

    const fresh = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'station', password: 'NewTill!2026' },
    });
    expect(fresh.statusCode).toBe(200);
  });
});

describe('the audit trail', () => {
  it('records who created the account, and never what its password was', async () => {
    const created = await create({ ...TILL, branchId });
    const id = JSON.parse(created.body).id;
    await patch(id, { password: 'NewTill!2026' });

    const rows = await prisma.auditLog.findMany({
      where: { entityType: 'user' },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => r.action)).toEqual(['user.created', 'user.updated']);

    const owner = await prisma.user.findFirstOrThrow({ where: { role: 'OWNER' } });
    expect(rows[0]?.actorUserId).toBe(owner.id);

    // The password is nowhere in the trail — neither the value nor its hash. A change
    // is recorded as the FACT that one happened.
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain('Till!2026');
    expect(serialised).not.toContain('NewTill!2026');
    expect(serialised).not.toContain('$argon2');
    expect(serialised).toContain('passwordChanged');
  });
});
