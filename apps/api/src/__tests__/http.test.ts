import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API_PREFIX, buildApp } from '../app';
import { resetDatabase } from './helpers/db';
import { createWorld, TEST_PASSWORD, type World } from './helpers/fixtures';

/**
 * The HTTP surface: authentication, RBAC, validation and the error envelope
 * (CLAUDE.md §7.1, §7.2, §7.4, §9).
 *
 * Driven through `app.inject()` rather than a real socket — it exercises the full
 * plugin chain (hooks, validation, error handler) without binding a port.
 */

const prisma = new PrismaClient();
let app: FastifyInstance;
let world: World;

const url = (path: string) => `${API_PREFIX}${path}`;

async function tokenFor(username: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: url('/auth/login'),
    payload: { username, password: TEST_PASSWORD },
  });
  if (response.statusCode !== 200) {
    throw new Error(`login failed for ${username}: ${response.body}`);
  }
  return response.json().tokens.accessToken as string;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

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

describe('authentication (CLAUDE.md §7.1)', () => {
  it('issues tokens for valid credentials', async () => {
    const response = await app.inject({
      method: 'POST',
      url: url('/auth/login'),
      payload: { username: 'assistant', password: TEST_PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.tokens.accessToken).toBeTruthy();
    expect(body.tokens.refreshToken).toBeTruthy();
    expect(body.user.role).toBe('ASSISTANT');
    // The password hash must never cross the wire.
    expect(JSON.stringify(body)).not.toContain('argon2');
  });

  it('gives the same answer for a wrong password and an unknown user', async () => {
    // Different messages here would turn login into a username oracle.
    const wrongPassword = await app.inject({
      method: 'POST',
      url: url('/auth/login'),
      payload: { username: 'assistant', password: 'not-the-password' },
    });
    const unknownUser = await app.inject({
      method: 'POST',
      url: url('/auth/login'),
      payload: { username: 'nobody-here', password: 'not-the-password' },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownUser.statusCode).toBe(401);
    expect(wrongPassword.json().error.message).toBe(unknownUser.json().error.message);
  });

  it('rotates refresh tokens and revokes the old one', async () => {
    const login = await app.inject({
      method: 'POST',
      url: url('/auth/login'),
      payload: { username: 'assistant', password: TEST_PASSWORD },
    });
    const original = login.json().tokens.refreshToken as string;

    const refreshed = await app.inject({
      method: 'POST',
      url: url('/auth/refresh'),
      payload: { refreshToken: original },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().tokens.refreshToken).not.toBe(original);

    // Replaying the old token must fail — and take the whole chain down with it,
    // because a replay is indistinguishable from a theft.
    const replay = await app.inject({
      method: 'POST',
      url: url('/auth/refresh'),
      payload: { refreshToken: original },
    });
    expect(replay.statusCode).toBe(401);

    const newToken = refreshed.json().tokens.refreshToken as string;
    const afterBreach = await app.inject({
      method: 'POST',
      url: url('/auth/refresh'),
      payload: { refreshToken: newToken },
    });
    expect(afterBreach.statusCode).toBe(401);
  });

  it('refuses an unauthenticated request', async () => {
    const response = await app.inject({ method: 'GET', url: url('/auth/me') });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('refuses a malformed or forged token', async () => {
    for (const header of [
      { authorization: 'Bearer not-a-jwt' },
      { authorization: 'Basic abc' },
      { authorization: 'Bearer a b c' },
    ]) {
      const response = await app.inject({ method: 'GET', url: url('/auth/me'), headers: header });
      expect(response.statusCode, JSON.stringify(header)).toBe(401);
    }
  });

  it('protects routes by default — a new route is not accidentally public', async () => {
    // Auth is opt-out, so anything without an explicit `public` marker requires a
    // token. This is the property that keeps a forgotten route from leaking.
    const response = await app.inject({ method: 'GET', url: url('/customers') });
    expect(response.statusCode).toBe(401);
  });
});

describe('RBAC (CLAUDE.md §7.2)', () => {
  it('lets an assistant run the core loop', async () => {
    const token = await tokenFor('assistant');
    const response = await app.inject({
      method: 'GET',
      url: url(`/customers/resolve?identifier=${encodeURIComponent(world.customerPhone)}`),
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().customer.name).toBe('حسين علي');
  });

  it('stops an assistant reading the customer list', async () => {
    const token = await tokenFor('assistant');
    const response = await app.inject({
      method: 'GET',
      url: url('/customers'),
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
  });

  it('stops an assistant changing the loyalty rules', async () => {
    // An assistant who could move thresholds could mint themselves discounts.
    const token = await tokenFor('assistant');

    const read = await app.inject({ method: 'GET', url: url('/rules'), headers: bearer(token) });
    expect(read.statusCode).toBe(403);

    const write = await app.inject({
      method: 'PUT',
      url: url('/rules'),
      headers: bearer(token),
      payload: {
        periodType: 'MONTHLY',
        tiers: [{ thresholdAmount: 1, discountPct: 99, couponValidityDays: 365 }],
      },
    });
    expect(write.statusCode).toBe(403);
  });

  it('lets a manager read and update the rules, and audits the change', async () => {
    const token = await tokenFor('manager');

    const read = await app.inject({ method: 'GET', url: url('/rules'), headers: bearer(token) });
    expect(read.statusCode).toBe(200);
    expect(read.json().ruleSet.tiers).toHaveLength(3);

    const update = await app.inject({
      method: 'PUT',
      url: url('/rules'),
      headers: bearer(token),
      payload: {
        periodType: 'MONTHLY',
        tiers: [
          { thresholdAmount: 150_000, discountPct: 7, couponValidityDays: 30 },
          { thresholdAmount: 400_000, discountPct: 12, couponValidityDays: 30 },
        ],
      },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().ruleSet.tiers).toHaveLength(2);

    const audit = await prisma.auditLog.findFirst({ where: { action: 'rules.updated' } });
    expect(audit?.actorUserId).toBe(world.managerId);
  });
});

describe('validation (CLAUDE.md §7.4)', () => {
  it('rejects unknown fields instead of dropping them silently', async () => {
    const token = await tokenFor('assistant');
    const response = await app.inject({
      method: 'POST',
      url: url('/customers'),
      headers: bearer(token),
      payload: { name: 'زينب عبد الرزاق', phone: '07801112233', sneaky: 'value' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('normalises a phone number to E.164 on the way in', async () => {
    const token = await tokenFor('assistant');
    const response = await app.inject({
      method: 'POST',
      url: url('/customers'),
      headers: bearer(token),
      payload: { name: 'زينب عبد الرزاق', phone: '0780 111 2233' },
    });

    expect(response.statusCode).toBe(201);
    // One human must never become two accounts because of formatting (§13.4).
    expect(response.json().customer.phone).toBe('+9647801112233');
  });

  it('rejects a float amount — money is an integer', async () => {
    const token = await tokenFor('assistant');
    const response = await app.inject({
      method: 'POST',
      url: url('/transactions'),
      headers: bearer(token),
      payload: {
        customerId: world.customerId,
        invoice: {
          invoice_id: 'INV-1',
          amount: 85_000.5,
          currency: 'IQD',
          branch_id: 'BAG-01',
          customer_identifier: world.customerPhone,
          occurred_at: new Date().toISOString(),
          source: 'scan',
          amount_capture: 'auto',
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.fields?.length).toBeGreaterThan(0);
  });

  it('reports field-level detail on a validation failure', async () => {
    const token = await tokenFor('assistant');
    const response = await app.inject({
      method: 'POST',
      url: url('/customers'),
      headers: bearer(token),
      payload: { name: 'x', phone: 'not-a-phone' },
    });

    const body = response.json();
    expect(response.statusCode).toBe(400);
    expect(body.error.fields.map((f: { path: string }) => f.path)).toContain('phone');
  });
});

describe('the core loop over HTTP', () => {
  const invoicePayload = (invoiceId: string, amount: number) => ({
    invoice_id: invoiceId,
    amount,
    currency: 'IQD' as const,
    branch_id: 'BAG-01',
    customer_identifier: '+9647701234567',
    occurred_at: new Date().toISOString(),
    source: 'scan' as const,
    amount_capture: 'auto' as const,
  });

  it('links an invoice and returns balance plus any coupon', async () => {
    const token = await tokenFor('assistant');
    const response = await app.inject({
      method: 'POST',
      url: url('/transactions'),
      headers: bearer(token),
      payload: { customerId: world.customerId, invoice: invoicePayload('INV-9824', 100_000) },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.balance.cumulativeAmount).toBe(100_000);
    expect(body.issuedCoupon.discountPct).toBe(5);
  });

  it('returns 409 with the existing record on a duplicate', async () => {
    const token = await tokenFor('assistant');
    const payload = {
      customerId: world.customerId,
      invoice: invoicePayload('INV-9824', 50_000),
    };

    await app.inject({
      method: 'POST',
      url: url('/transactions'),
      headers: bearer(token),
      payload,
    });
    const duplicate = await app.inject({
      method: 'POST',
      url: url('/transactions'),
      headers: bearer(token),
      payload,
    });

    expect(duplicate.statusCode).toBe(409);
    const body = duplicate.json();
    expect(body.error.code).toBe('DUPLICATE_INVOICE');
    expect(body.error.details.customerName).toBe('حسين علي');
  });

  it('resolves a customer by QR token as well as by phone', async () => {
    const token = await tokenFor('assistant');
    const response = await app.inject({
      method: 'GET',
      url: url(`/customers/resolve?identifier=${encodeURIComponent(world.customerQrToken)}`),
      headers: bearer(token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().customer.id).toBe(world.customerId);
  });

  it('refuses a QR token with a broken signature without leaking existence', async () => {
    const token = await tokenFor('assistant');
    const tampered = `${world.customerQrToken.slice(0, -4)}AAAA`;

    const response = await app.inject({
      method: 'GET',
      url: url(`/customers/resolve?identifier=${encodeURIComponent(tampered)}`),
      headers: bearer(token),
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('error envelope and headers', () => {
  it('shapes every error the same way', async () => {
    const response = await app.inject({ method: 'GET', url: url('/auth/me') });
    const body = response.json();

    expect(body).toHaveProperty('error.code');
    expect(body).toHaveProperty('error.message');
    expect(body.error).toHaveProperty('requestId');
  });

  it('does not let an unauthenticated caller enumerate routes', async () => {
    // The auth hook runs before the not-found handler, so an unknown path is 401
    // rather than 404. That is deliberate: differing answers would reveal which
    // routes exist to someone with no credentials.
    const response = await app.inject({ method: 'GET', url: url('/nope') });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('returns the envelope for an unknown route when authenticated', async () => {
    const token = await tokenFor('manager');
    const response = await app.inject({
      method: 'GET',
      url: url('/nope'),
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });

  it('sets HSTS and the other security headers (CLAUDE.md §7.3)', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.headers['strict-transport-security']).toContain('max-age=63072000');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
  });

  it('serves health without a token', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('ok');
  });
});
