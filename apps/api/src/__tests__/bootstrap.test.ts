import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { resetDatabase } from './helpers/db';

// Its own client, as every other suite here does: the module-scope singleton is the
// one the service under test uses, and sharing it would let a test's teardown close a
// connection the app still holds.
const prisma = new PrismaClient();

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  NO PASSWORD SHIPS, AND THE ONE THE SHOP CHOOSES CAN ONLY BE CHOSEN ONCE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The shipped database is migrated and empty on purpose. A template carrying a working
 * account would be the same login on every installation of this product — published in
 * this repository and in every conversation about it.
 *
 * That leaves one public, unauthenticated endpoint that creates an OWNER, which is
 * exactly the kind of thing that must be pinned down by tests rather than by intent.
 * What follows is the whole of its contract: it works once, it refuses afterwards, it
 * refuses the passwords this project's own history makes likely, and the credentials
 * that exist for development cannot reach a merchant.
 */

let app: Awaited<ReturnType<typeof buildApp>>;

const VALID = {
  merchantName: 'سوبرماركت الاختبار',
  branchName: 'الفرع الرئيسي',
  branchCode: 'TST-01',
  ownerName: 'صاحب المتجر',
  username: 'shopowner',
  password: 'a-long-enough-one',
};

beforeEach(async () => {
  await resetDatabase(prisma);
  app = await buildApp({ rateLimit: false });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/*
  The return type is named rather than inferred. `app.inject` is overloaded — with a
  callback it returns a `Chain`, without one a promise — and letting TypeScript pick
  produced a union that had no `statusCode` on it, so the suite passed at runtime while
  the typecheck failed.
*/
type Injected = Awaited<ReturnType<FastifyInstance['inject']>>;

const post = (payload: Record<string, unknown>): Promise<Injected> =>
  app.inject({ method: 'POST', url: '/api/v1/auth/bootstrap', payload });

const status = (): Promise<Injected> =>
  app.inject({ method: 'GET', url: '/api/v1/auth/bootstrap' });

describe('a freshly installed database', () => {
  it('has no accounts at all, so nothing could log in', async () => {
    expect(await prisma.user.count()).toBe(0);

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'owner', password: 'Walaa!Dev2026' },
    });
    expect(login.statusCode).toBe(401);
  });

  it('reports that first-run setup is required', async () => {
    const r = await status();
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ required: true });
  });
});

describe('creating the shop and its owner', () => {
  it('creates a merchant, a branch and one unbound OWNER', async () => {
    const response = await post(VALID);
    expect(response.statusCode).toBe(201);

    const user = await prisma.user.findFirstOrThrow();
    expect(user.role).toBe('OWNER');
    // Null because an OWNER is not bound to one branch — §13.9 makes branch a verified
    // property of the writer, and the owner may write anywhere.
    expect(user.branchId).toBeNull();
    expect(user.username).toBe('shopowner');

    expect(await prisma.merchant.count()).toBe(1);
    expect(await prisma.branch.count()).toBe(1);
    expect((await prisma.branch.findFirstOrThrow()).code).toBe('TST-01');
  });

  it('lets the owner sign in with exactly what was typed', async () => {
    await post(VALID);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: VALID.username, password: VALID.password },
    });
    expect(login.statusCode).toBe(200);
    expect(JSON.parse(login.body).user.role).toBe('OWNER');
  });

  it('records it in the append-only audit trail', async () => {
    await post(VALID);
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'installation.bootstrapped' },
    });
    expect(entry.entityType).toBe('merchant');
  });

  it('stores the username lowercased, so one person is not two accounts', async () => {
    await post({ ...VALID, username: 'ShopOwner' });
    expect((await prisma.user.findFirstOrThrow()).username).toBe('shopowner');
  });
});

describe('and then refuses, forever', () => {
  it('answers 403 to a second attempt', async () => {
    expect((await post(VALID)).statusCode).toBe(201);

    const second = await post({ ...VALID, username: 'someoneelse' });
    expect(second.statusCode).toBe(403);
    expect(await prisma.user.count()).toBe(1);
  });

  it('reports that setup is no longer required', async () => {
    await post(VALID);
    const r = await status();
    expect(JSON.parse(r.body)).toEqual({ required: false });
  });

  /**
   * The guarantee is "one owner", not "the first caller wins".
   *
   * Ten simultaneous callers, all valid, all racing. The count and the insert share one
   * transaction and every write goes through the serialising queue, so exactly one may
   * commit — the same shape the voucher drill proves for redemption, applied to the one
   * account that can do anything in this product.
   */
  it('cannot be raced into creating two owners', async () => {
    const answers = await Promise.all(
      Array.from({ length: 10 }, (_, i) => post({ ...VALID, username: `owner${i}` })),
    );

    expect(answers.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.merchant.count()).toBe(1);
  });
});

describe('the password it will accept', () => {
  it('refuses one shorter than ten characters', async () => {
    const r = await post({ ...VALID, password: 'short1' });
    expect(r.statusCode).toBe(400);
    expect(await prisma.user.count()).toBe(0);
  });

  /**
   * The development seed's password specifically.
   *
   * It is in this repository, in shell histories and in every conversation about the
   * project. Somebody setting a shop up while reading the docs will try it, and the
   * one moment to refuse it is before it protects a real shop's customer list.
   */
  it('refuses the development seed password by name', async () => {
    const r = await post({ ...VALID, password: 'Walaa!Dev2026' });
    expect(r.statusCode).toBe(400);
    const body = JSON.parse(r.body) as { error: { message: string } };
    expect(body.error.message).toContain('معروفة');
    expect(await prisma.user.count()).toBe(0);
  });

  it('refuses it whatever the casing', async () => {
    const r = await post({ ...VALID, password: 'WALAA!DEV2026' });
    expect(r.statusCode).toBe(400);
  });
});

describe('the development seed', () => {
  /**
   * Two things keep `prisma/seed.ts` away from a shop: it is not bundled, and it
   * refuses. This asserts the second, because the first is a property of the packaging
   * and packaging changes. The realistic accident is a developer with `DATABASE_URL`
   * pointed at a restored copy of a merchant's database running `pnpm db:seed` without
   * thinking — which would put a published password into a live shop, silently.
   */
  it('refuses to run when NODE_ENV is production', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'prisma', 'seed.ts'), 'utf8');

    expect(source).toContain("process.env.NODE_ENV === 'production'");
    expect(source).toContain('WALAA_ALLOW_PRODUCTION_SEED');
    expect(source).toContain('process.exit(1)');

    // And the guard is actually invoked, not merely defined.
    expect(source).toMatch(/^refuseInProduction\(\);$/m);
  });
});
