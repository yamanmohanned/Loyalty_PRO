import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API_PREFIX, buildApp } from '../app';
import { resetDatabase } from './helpers/db';
import { createWorld, TEST_PASSWORD, type World } from './helpers/fixtures';

/**
 * The endpoints the Loyalty Station needs beyond the scan itself (§6.2 #5): finding
 * a customer who has lost their card, and reprinting it.
 *
 * The reprint flow is the one place the system searches by name, which CLAUDE.md
 * §1.4 forbids as an *identification* method. The tests below pin the mitigations
 * that make the exception safe rather than merely permitted: masked phone numbers,
 * a bounded list that admits when it is incomplete, and card numbers that are never
 * returned by a search — only by a second, per-customer call.
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
  if (response.statusCode !== 200)
    throw new Error(`login failed for ${username}: ${response.body}`);
  return response.json().tokens.accessToken as string;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const search = async (token: string, query: string) =>
  app.inject({
    method: 'GET',
    url: url(`/customers/search?query=${encodeURIComponent(query)}`),
    headers: bearer(token),
  });

beforeAll(async () => {
  app = await buildApp({ rateLimit: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  world = await createWorld(prisma);
});

describe('finding a customer who lost their card', () => {
  it('finds them by card number', async () => {
    const response = await search(await tokenFor('station'), world.customerBarcode);

    expect(response.statusCode).toBe(200);
    expect(response.json().matches).toHaveLength(1);
    expect(response.json().matches[0].id).toBe(world.customerId);
  });

  it('finds them by card number typed with the grouping printed on the card', async () => {
    // What a person reads aloud and an operator types back.
    const grouped = (world.customerBarcode.match(/.{1,4}/g) as string[]).join(' ');
    const response = await search(await tokenFor('station'), grouped);

    expect(response.json().matches).toHaveLength(1);
    expect(response.json().matches[0].id).toBe(world.customerId);
  });

  it('finds them by phone number in any of the shapes people type', async () => {
    const token = await tokenFor('station');

    for (const phone of ['+9647701234567', '07701234567', '0770 123 4567']) {
      const response = await search(token, phone);
      expect(response.json().matches, phone).toHaveLength(1);
      expect(response.json().matches[0].id).toBe(world.customerId);
    }
  });

  it('finds them by name', async () => {
    const response = await search(await tokenFor('station'), 'حسين');

    expect(response.statusCode).toBe(200);
    expect(response.json().matches).toHaveLength(1);
    expect(response.json().matches[0].name).toBe('حسين علي');
  });

  it('returns nothing for a card number with a broken signature', async () => {
    // A tampered number must look exactly like a number that does not exist.
    const digits = world.customerBarcode;
    const tampered = `${digits.slice(0, -1)}${(Number(digits.slice(-1)) + 1) % 10}`;

    const response = await search(await tokenFor('station'), tampered);

    expect(response.statusCode).toBe(200);
    expect(response.json().matches).toHaveLength(0);
  });

  it('never returns a customer from another merchant', async () => {
    const other = await createWorld(prisma);
    const token = await tokenFor('station');

    const byName = await search(token, 'حسين');
    const ids = byName.json().matches.map((m: { id: string }) => m.id);
    expect(ids).not.toContain(other.customerId);

    const byCard = await search(token, other.customerBarcode);
    expect(byCard.json().matches).toHaveLength(0);
  });
});

describe('what a name search is allowed to reveal', () => {
  it('masks the phone number', async () => {
    const response = await search(await tokenFor('station'), 'حسين');
    const match = response.json().matches[0];

    expect(match.phoneMasked).toBe('0770 ••• 4567');
    // The point of the mask: the operator can confirm "ending 4567?" with the person
    // in front of them, and cannot read the shop's phone list off the screen.
    expect(response.body).not.toContain('7701234567');
    expect(response.body).not.toContain('+9647701234567');
  });

  it('never includes a card number', async () => {
    const response = await search(await tokenFor('station'), 'حسين');

    expect(response.body).not.toContain(world.customerBarcode);
    expect(Object.keys(response.json().matches[0])).toEqual([
      'id',
      'name',
      'phoneMasked',
      'createdAt',
    ]);
  });

  it('bounds the list and says when it is incomplete', async () => {
    // Ten customers sharing a common Iraqi given name — unremarkable in one
    // neighbourhood, and precisely the case §1.4 warns about.
    for (let i = 0; i < 10; i += 1) {
      await prisma.customer.create({
        data: {
          merchantId: world.merchantId,
          name: `محمد ${i}`,
          phone: `+96477012000${i}`,
          category: 'REGULAR',
          barcodeToken: `900000000${String(i).padStart(7, '0')}`,
        },
      });
    }

    const response = await search(await tokenFor('station'), 'محمد');

    expect(response.json().matches.length).toBeLessThanOrEqual(8);
    // An operator who does not know the list is cut short will confidently pick the
    // wrong person from it.
    expect(response.json().truncated).toBe(true);
  });

  it('refuses a query too short to be a search', async () => {
    const response = await search(await tokenFor('station'), 'م');
    expect(response.statusCode).toBe(400);
  });

  it('requires authentication', async () => {
    const response = await app.inject({
      method: 'GET',
      url: url('/customers/search?query=حسين'),
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('reprinting the card', () => {
  const card = async (token: string, id: string) =>
    app.inject({ method: 'GET', url: url(`/customers/${id}/card`), headers: bearer(token) });

  it('reissues the SAME number, never a new one', async () => {
    const token = await tokenFor('station');

    const first = await card(token, world.customerId);
    const second = await card(token, world.customerId);

    expect(first.statusCode).toBe(200);
    // A reprint that minted a new number would sever the customer from their own
    // purchase history (§6.2 #5).
    expect(first.json().card.barcodeToken).toBe(world.customerBarcode);
    expect(second.json().card.barcodeToken).toBe(world.customerBarcode);
  });

  it('returns the number in both the printed and the readable form', async () => {
    const response = await card(await tokenFor('station'), world.customerId);
    const payload = response.json().card;

    expect(payload.barcodeToken).toMatch(/^\d{16}$/);
    expect(payload.cardNumberFormatted).toMatch(/^\d{4} \d{4} \d{4} \d{4}$/);
    expect(payload.cardNumberFormatted.replace(/ /g, '')).toBe(payload.barcodeToken);
    expect(payload.phoneLocal).toBe('0770 123 4567');
  });

  it('does not serve a customer from another merchant', async () => {
    const other = await createWorld(prisma);
    const response = await card(await tokenFor('station'), other.customerId);
    expect(response.statusCode).toBe(404);
  });

  it('is reachable by the station role', async () => {
    // The station operator is the person who reprints a card; if this needed a
    // manager the customer would be sent away to come back later.
    const response = await card(await tokenFor('station'), world.customerId);
    expect(response.statusCode).toBe(200);
  });
});
