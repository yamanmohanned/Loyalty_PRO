import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { resetDatabase } from './helpers/db';

const prisma = new PrismaClient();

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A MERCHANT'S FIRST SIXTY SECONDS, THROUGH THE PUBLIC API ONLY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── Why this test exists ─────────────────────────────────────────────────────
 *
 * Five hundred tests passed while a freshly installed shop could not trade. Every one
 * of them started from `prisma/seed.ts` or wrote its fixtures straight into the
 * database, and the seed creates things the product itself never does:
 *
 *   · a `station` account — the till could never be signed into;
 *   · an AGENT account — the capture agent could only run on the owner's password;
 *   · `discount_settings` — the FIRST SALE of every installation was a 500.
 *
 * Each of those was a proxy: "a database with a station account in it" standing in for
 * "a shop that can make one". They were found by walking the product by hand on a
 * machine with no prior state. This is that walk, written down so it cannot regress.
 *
 * ── The rule this test keeps ─────────────────────────────────────────────────
 *
 * **Nothing here touches the database except to read the outcome.** Every row it
 * depends on is created through the same endpoints a merchant's screens and the agent
 * call. If a step a real installation needs has no endpoint, this fails — which is the
 * whole point.
 */

let app: Awaited<ReturnType<typeof buildApp>>;
type Injected = Awaited<ReturnType<FastifyInstance['inject']>>;

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

const call = (
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>,
  token?: string,
): Promise<Injected> =>
  app.inject({
    method,
    url: `/api/v1${url}`,
    ...(payload ? { payload } : {}),
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });

async function signIn(username: string, password: string): Promise<string> {
  const response = await call('POST', '/auth/login', { username, password });
  expect(response.statusCode, `sign-in as ${username}: ${response.body}`).toBe(200);
  return JSON.parse(response.body).tokens.accessToken as string;
}

describe('from an empty installation to the first attributed sale', () => {
  it('works through the endpoints a merchant and the agent actually use', async () => {
    // ── The installation is empty: nothing but the setup screen can open it.
    expect(JSON.parse((await call('GET', '/auth/bootstrap')).body)).toEqual({ required: true });

    // ── «إعداد المتجر لأول مرة»
    const setup = await call('POST', '/auth/bootstrap', {
      merchantName: 'سوبرماركت المدينة',
      branchName: 'الفرع الرئيسي',
      branchCode: 'BAG-01',
      ownerName: 'علي العبيدي',
      username: 'ali',
      password: 'Madina!2026',
    });
    expect(setup.statusCode, setup.body).toBe(201);
    const owner = await signIn('ali', 'Madina!2026');

    // ── Settings → حسابات الدخول: the till, and the capture agent.
    const staff = JSON.parse((await call('GET', '/users', undefined, owner)).body);
    const branchId = staff.branches[0].id as string;

    const till = await call(
      'POST',
      '/users',
      { name: 'محطة الصندوق', username: 'station', password: 'Till!2026', role: 'STATION', branchId },
      owner,
    );
    expect(till.statusCode, till.body).toBe(201);

    const agentAccount = await call(
      'POST',
      '/users',
      { name: 'برنامج الالتقاط', username: 'agent1', password: 'Capture!2026', role: 'AGENT', branchId },
      owner,
    );
    expect(agentAccount.statusCode, agentAccount.body).toBe(201);

    const station = await signIn('station', 'Till!2026');
    const agent = await signIn('agent1', 'Capture!2026');

    // ── At the till: a new customer, with a printed card.
    const customer = await call(
      'POST',
      '/customers',
      { name: 'أحمد الجبوري', phone: '07701234567' },
      station,
    );
    expect(customer.statusCode, customer.body).toBe(201);
    const { id: customerId, cardNumber } = JSON.parse(customer.body).customer as {
      id: string;
      cardNumber: string;
    };
    expect(cardNumber).toBeTruthy();

    // ── The register prints; the agent captures it.
    const now = new Date().toISOString();
    const capture = await call(
      'POST',
      '/ingest/invoice',
      {
        agentId: 'till-1',
        invoice: {
          invoice_id: 'INV-70055',
          amount_gross: 120000,
          currency: 'IQD',
          branch_id: 'BAG-01',
          occurred_at: now,
          captured_at: now,
          capture_mode: 'SPOOL_WATCH',
        },
      },
      agent,
    );
    expect(capture.statusCode, capture.body).toBe(201);

    // ── At the till: card, then invoice. This is the step that returned 500 on every
    //    new installation, because nothing had created `discount_settings`.
    const identify = await call('POST', '/scan/identify', { barcodeToken: cardNumber }, station);
    expect(identify.statusCode, identify.body).toBe(200);

    const attribute = await call(
      'POST',
      '/scan/card',
      { barcodeToken: cardNumber, invoiceId: 'INV-70055' },
      station,
    );
    expect(attribute.statusCode, attribute.body).toBeLessThan(300);

    // ── The outcome, read back — the only database access in this test.
    const sale = await prisma.transaction.findFirstOrThrow({ where: { invoiceId: 'INV-70055' } });
    expect(sale.customerId).toBe(customerId);
    expect(sale.amountGross).toBe(120000);

    // ── And the dashboard can see it.
    const capturing = JSON.parse((await call('GET', '/system/capture', undefined, owner)).body);
    expect(capturing.capturedLast24h).toBe(1);
    expect(capturing.lastCapturedAt).not.toBeNull();
  });

  it('has no seeded account the product did not create', async () => {
    /*
      The inverse guard. If this installation contains a `station` or `owner` account
      before anybody has set it up, something outside the product made it — which is the
      exact shape of the three defects above, and of a shipped credential.
    */
    expect(await prisma.user.count()).toBe(0);
    const login = await call('POST', '/auth/login', { username: 'station', password: 'Walaa!Dev2026' });
    expect(login.statusCode).toBe(401);
  });
});
