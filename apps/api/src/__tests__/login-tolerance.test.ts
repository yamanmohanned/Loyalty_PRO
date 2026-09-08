import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API_PREFIX, buildApp } from '../app';
import { resetDatabase } from './helpers/db';
import { createWorld, TEST_PASSWORD } from './helpers/fixtures';

/**
 * What the login form tolerates, and what it must not.
 *
 * ── Why these cases and not others ───────────────────────────────────────────
 *
 * A merchant was handed `owner` / `walaa2026`, typed it, and was refused. The database
 * was correct, the password hash was correct, and the account was active — the lookup
 * was case-sensitive. `Owner` and `owner` are the same account to everyone except
 * SQLite, and the merchant had no way to see the difference: the failure message is
 * «اسم المستخدم أو كلمة المرور غير صحيحة», which is true of a typo and equally true of
 * this.
 *
 * The username is an internal handle, never an email and never PII, so folding its case
 * gives up nothing. The password is a secret and is compared byte for byte — trimming
 * or folding it would be a real weakening, and the tests below pin that asymmetry so a
 * later "consistency" tidy-up cannot quietly extend the tolerance to the wrong field.
 */

const prisma = new PrismaClient();
let app: FastifyInstance;

const url = (path: string) => `${API_PREFIX}${path}`;

const attempt = (username: string, password: string) =>
  app.inject({ method: 'POST', url: url('/auth/login'), payload: { username, password } });

beforeAll(async () => {
  // Rate limiting off: this file makes many login attempts on purpose, and they would
  // otherwise share one bucket and start failing for a reason it is not testing.
  app = await buildApp({ rateLimit: false });
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

describe('the username is matched case-insensitively', () => {
  it('accepts the exact username', async () => {
    expect((await attempt('owner', TEST_PASSWORD)).statusCode).toBe(200);
  });

  it.each(['Owner', 'OWNER', 'oWnEr'])('accepts %s', async (variant) => {
    const response = await attempt(variant, TEST_PASSWORD);
    expect(response.statusCode).toBe(200);
    // The stored spelling comes back, not what was typed — the session should name the
    // account as it exists, so nothing downstream inherits the merchant's capitalisation.
    expect(response.json().user.username).toBe('owner');
  });

  it('still resolves the right account when several exist', async () => {
    // `manager` and `owner` differ in more than case; folding must not widen a lookup
    // into matching the wrong row.
    const response = await attempt('MANAGER', TEST_PASSWORD);
    expect(response.statusCode).toBe(200);
    expect(response.json().user.username).toBe('manager');
    expect(response.json().user.role).toBe('MANAGER');
  });
});

describe('the password is not softened in any way', () => {
  it('rejects a different case', async () => {
    expect((await attempt('owner', TEST_PASSWORD.toUpperCase())).statusCode).toBe(401);
    expect((await attempt('owner', TEST_PASSWORD.toLowerCase())).statusCode).toBe(401);
  });

  it('rejects surrounding whitespace', async () => {
    // The username IS trimmed by the request schema, which is why this needs its own
    // assertion: the two fields are deliberately treated differently.
    expect((await attempt('owner', ` ${TEST_PASSWORD}`)).statusCode).toBe(401);
    expect((await attempt('owner', `${TEST_PASSWORD} `)).statusCode).toBe(401);
  });

  it('rejects a wrong password with the vague message, leaking nothing', async () => {
    const real = await attempt('owner', 'CompletelyWrong1!');
    const absent = await attempt('nosuchuser', 'CompletelyWrong1!');

    expect(real.statusCode).toBe(401);
    expect(absent.statusCode).toBe(401);
    // A production build must not let login answer "does this account exist?".
    expect(real.json().error.message).toBe(absent.json().error.message);
  });
});
