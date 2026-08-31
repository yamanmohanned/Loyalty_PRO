import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API_PREFIX, buildApp } from '../app';
import { resetDatabase } from './helpers/db';
import { createTransaction, createWorld, TEST_PASSWORD, type World } from './helpers/fixtures';

/**
 * The HTTP surface after the v3 data-layer migration.
 *
 * Auth, RBAC, validation and the error envelope are classified KEEP — they were
 * correct under v1 and the pivot did not change their reasoning. These tests prove
 * that survived the migration intact.
 *
 * The instant-discount endpoints (/ingest, /scan, /vouchers, /discount-rules) land
 * in V3-2 and are tested there.
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

describe('authentication', () => {
  it('issues tokens for valid credentials', async () => {
    const response = await app.inject({
      method: 'POST',
      url: url('/auth/login'),
      payload: { username: 'manager', password: TEST_PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.tokens.accessToken).toBeTruthy();
    expect(body.user.role).toBe('MANAGER');
    // The password hash must never cross the wire.
    expect(JSON.stringify(body)).not.toContain('argon2');
  });

  it('issues tokens for the new STATION role', async () => {
    // STATION replaces v1's ASSISTANT: the Loyalty Station operator (§6.2).
    const response = await app.inject({
      method: 'POST',
      url: url('/auth/login'),
      payload: { username: 'station', password: TEST_PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().user.role).toBe('STATION');
  });

  it('gives the same answer for a wrong password and an unknown user', async () => {
    // Different messages would turn login into a username oracle.
    const wrongPassword = await app.inject({
      method: 'POST',
      url: url('/auth/login'),
      payload: { username: 'manager', password: 'not-the-password' },
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

  it('rotates refresh tokens and revokes the whole chain on replay', async () => {
    const login = await app.inject({
      method: 'POST',
      url: url('/auth/login'),
      payload: { username: 'manager', password: TEST_PASSWORD },
    });
    const original = login.json().tokens.refreshToken as string;

    const refreshed = await app.inject({
      method: 'POST',
      url: url('/auth/refresh'),
      payload: { refreshToken: original },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().tokens.refreshToken).not.toBe(original);

    // Replaying the old token fails — and takes the chain down with it, because a
    // replay is indistinguishable from a theft.
    const replay = await app.inject({
      method: 'POST',
      url: url('/auth/refresh'),
      payload: { refreshToken: original },
    });
    expect(replay.statusCode).toBe(401);

    const afterBreach = await app.inject({
      method: 'POST',
      url: url('/auth/refresh'),
      payload: { refreshToken: refreshed.json().tokens.refreshToken },
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
    // Auth is opt-out: anything without an explicit `public` marker needs a token.
    // This is the property that keeps a forgotten route from leaking.
    const response = await app.inject({ method: 'GET', url: url(`/customers/${world.customerId}`) });
    expect(response.statusCode).toBe(401);
  });
});

describe('RBAC', () => {
  it('lets the station resolve a customer by scanned card', async () => {
    const token = await tokenFor('station');
    const response = await app.inject({
      method: 'GET',
      url: url(`/customers/resolve?identifier=${encodeURIComponent(world.customerBarcode)}`),
      headers: bearer(token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().customer.id).toBe(world.customerId);
  });

  it('lets the station register a customer', async () => {
    // Registration happens at the counter, so the station operator must be able to.
    const token = await tokenFor('station');
    const response = await app.inject({
      method: 'POST',
      url: url('/customers'),
      headers: bearer(token),
      payload: { name: 'زينب عبد الرزاق', phone: '07801112233' },
    });

    expect(response.statusCode).toBe(201);
    // A registration with no blank card scanned falls back to a thermal card, so the
    // customer still leaves with a working number (§6.3, §12.25).
    expect(response.json().customer.cardNumber).toMatch(/^\d{16}$/);
  });

  it('stops the station reading customer detail', async () => {
    // Detail is a manager screen. The station shows one field and three outcomes.
    const token = await tokenFor('station');
    const response = await app.inject({
      method: 'GET',
      url: url(`/customers/${world.customerId}`),
      headers: bearer(token),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
  });

  it('lets a manager read customer detail with a derived balance', async () => {
    await createTransaction(prisma, world, { invoiceId: 'INV-1', amountGross: 30_000 });

    const token = await tokenFor('manager');
    const response = await app.inject({
      method: 'GET',
      url: url(`/customers/${world.customerId}`),
      headers: bearer(token),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.customer.name).toBe('حسين علي');
    // Computed from transaction rows, not read from a stored total (§5.3).
    expect(body.balance.cumulativeAmount).toBe(30_000);
    expect(body.balance.transactionCount).toBe(1);
  });
});

describe('balance derivation over HTTP (§5.3)', () => {
  it('reports the gap to the next threshold', async () => {
    await createTransaction(prisma, world, { invoiceId: 'INV-1', amountGross: 30_000 });

    const token = await tokenFor('station');
    const response = await app.inject({
      method: 'GET',
      url: url(`/customers/resolve?identifier=${encodeURIComponent(world.customerBarcode)}`),
      headers: bearer(token),
    });

    const balance = response.json().balance;
    expect(balance.cumulativeAmount).toBe(30_000);
    expect(balance.nextThresholdAmount).toBe(75_000);
    expect(balance.amountToNextThreshold).toBe(45_000);
    expect(balance.nextDiscountLabel).toBe('3٪');
  });

  it('reports no next threshold once every tier is cleared', async () => {
    await createTransaction(prisma, world, { invoiceId: 'INV-BIG', amountGross: 200_000 });

    const token = await tokenFor('station');
    const response = await app.inject({
      method: 'GET',
      url: url(`/customers/resolve?identifier=${encodeURIComponent(world.customerBarcode)}`),
      headers: bearer(token),
    });

    const balance = response.json().balance;
    expect(balance.nextThresholdAmount).toBeNull();
    expect(balance.amountToNextThreshold).toBeNull();
  });

  it('excludes unattributed invoices from any customer balance', async () => {
    // A capture with no card scanned belongs to nobody. Counting it toward a
    // balance would hand a customer someone else's spending.
    await createTransaction(prisma, world, { invoiceId: 'INV-MINE', amountGross: 30_000 });
    await createTransaction(prisma, world, {
      invoiceId: 'INV-NOBODY',
      amountGross: 900_000,
      customerId: null,
    });

    const token = await tokenFor('manager');
    const response = await app.inject({
      method: 'GET',
      url: url(`/customers/${world.customerId}`),
      headers: bearer(token),
    });

    expect(response.json().balance.cumulativeAmount).toBe(30_000);
  });
});

describe('validation', () => {
  it('rejects unknown fields instead of dropping them silently', async () => {
    const token = await tokenFor('station');
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
    const token = await tokenFor('station');
    const response = await app.inject({
      method: 'POST',
      url: url('/customers'),
      headers: bearer(token),
      payload: { name: 'زينب عبد الرزاق', phone: '0780 111 2233' },
    });

    expect(response.statusCode).toBe(201);
    // One human must never become two accounts because of formatting.
    expect(response.json().customer.phone).toBe('+9647801112233');
  });

  it('reports field-level detail on a validation failure', async () => {
    const token = await tokenFor('station');
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

  it('refuses a duplicate phone number', async () => {
    const token = await tokenFor('station');
    const response = await app.inject({
      method: 'POST',
      url: url('/customers'),
      headers: bearer(token),
      // The fixture already holds this number.
      payload: { name: 'حسين علي', phone: world.customerPhone },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CUSTOMER_ALREADY_EXISTS');
  });
});

describe('card resolution', () => {
  it('resolves by phone as well as by scanned card', async () => {
    // Phone lookup exists for reprint, when the customer has lost the card.
    const token = await tokenFor('station');
    const response = await app.inject({
      method: 'GET',
      url: url(`/customers/resolve?identifier=${encodeURIComponent(world.customerPhone)}`),
      headers: bearer(token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().customer.id).toBe(world.customerId);
  });

  it('refuses a card number with a broken signature without leaking existence', async () => {
    const token = await tokenFor('station');

    // Tamper by changing a digit, not by substituting letters: a card number is
    // sixteen digits, and anything else is a malformed identifier rather than a
    // forged one. Incrementing the final digit guarantees a different signature.
    const digits = world.customerBarcode;
    const lastDigit = (Number(digits.slice(-1)) + 1) % 10;
    const tampered = `${digits.slice(0, -1)}${lastDigit}`;
    expect(tampered).not.toBe(digits);
    expect(tampered).toMatch(/^\d{16}$/);

    const response = await app.inject({
      method: 'GET',
      url: url(`/customers/resolve?identifier=${encodeURIComponent(tampered)}`),
      headers: bearer(token),
    });

    // 404, and the same 404 an unknown-but-well-signed number gets — the station
    // must not be usable as an oracle for which numbers exist.
    expect(response.statusCode).toBe(404);
  });

  it('rejects an identifier that is neither a card number nor a phone number', async () => {
    const token = await tokenFor('station');

    const response = await app.inject({
      method: 'GET',
      url: url(`/customers/resolve?identifier=${encodeURIComponent('not-an-identifier')}`),
      headers: bearer(token),
    });

    expect(response.statusCode).toBe(400);
  });

  it('never exposes a customer from another merchant', async () => {
    const other = await createWorld(prisma);
    const token = await tokenFor('station');

    const response = await app.inject({
      method: 'GET',
      url: url(`/customers/resolve?identifier=${encodeURIComponent(other.customerBarcode)}`),
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
    // The auth hook runs before the not-found handler, so an unknown path answers
    // 401 rather than 404 — differing answers would reveal which routes exist.
    const response = await app.inject({ method: 'GET', url: url('/nope') });
    expect(response.statusCode).toBe(401);
  });

  it('sets HSTS and the other security headers', async () => {
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
