import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API_PREFIX, buildApp, redactUrlToken } from '../app';
import { setFlag } from '../services/feature-flags.service';
import { getOverview } from '../services/reports.service';
import { reconcileDay } from '../services/voucher.service';
import { resetDatabase } from './helpers/db';
import { createWorld, TEST_PASSWORD, type World } from './helpers/fixtures';

/**
 * Findings from the V3-6 security and performance pass (CLAUDE.md §7, §8).
 *
 * Each case below is a defect that was in the code, not a hypothetical. They are
 * gathered in one file because that is what they have in common: every one of them was
 * invisible in review and obvious the moment something real exercised it — a log read, a
 * fourth role, a query parameter nobody had typed wrong yet.
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
  if (response.statusCode !== 200) throw new Error(`login failed for ${username}`);
  return response.json().tokens.accessToken as string;
}

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

describe('the access token never reaches a log line (§7.6)', () => {
  it('redacts the handshake token from a URL', () => {
    // A browser cannot set a header on a WebSocket upgrade, so the token travels in the
    // query string — and Fastify logs `req.url`. Every reconnect was writing a live
    // bearer token in cleartext into api.log, on the same volume as the database.
    expect(redactUrlToken('/realtime?token=eyJhbGciOi.payload.signature')).toBe(
      '/realtime?token=%5Bredacted%5D',
    );
  });

  it('leaves an allowlisted query alone', () => {
    expect(redactUrlToken('/api/v1/reports/overview?range=30d')).toBe(
      '/api/v1/reports/overview?range=30d',
    );
    expect(redactUrlToken('/health')).toBe('/health');
  });

  it('keeps the path and redacts a parameter it does not recognise', () => {
    // `station` is not on the allowlist, so its value goes — even though a till label
    // is probably harmless. That is the trade being made deliberately: an
    // over-redacted log line is a small loss, and a parameter nobody thought about is
    // how every leak in this file got here.
    expect(redactUrlToken('/realtime?token=secret&station=till-1')).toBe(
      '/realtime?token=%5Bredacted%5D&station=%5Bredacted%5D',
    );
  });

  /*
    ── The property the allowlist buys ────────────────────────────────────────

    The redactor was a denylist of five names, each added after somebody found a real
    leak by reading the log. It could only ever be a record of the mistakes already
    discovered, and it said nothing about the route written next week.

    This is the case a denylist cannot pass: a parameter that carries a phone number
    under a name nobody has thought of yet. It is the whole reason for the inversion,
    so it is asserted directly rather than left implied by the examples above.
  */
  it('redacts a sensitive value under a parameter name nobody anticipated', () => {
    expect(redactUrlToken('/customers?mobile=07701234567')).toBe(
      '/customers?mobile=%5Bredacted%5D',
    );
    expect(redactUrlToken('/customers?whatsapp=07701234567&fullName=%D8%B2%D9%8A%D9%86%D8%A8')).toBe(
      '/customers?whatsapp=%5Bredacted%5D&fullName=%5Bredacted%5D',
    );
  });

  /*
    ── The customer-phone leak ────────────────────────────────────────────────

    The redactor handled `token` and nothing else, so every customer lookup wrote a
    phone number into `api.log` in cleartext: a manager searching the customer list,
    and the Station resolving a card at the till, thousands of times a day.

    It went unnoticed because the log lived in a directory locked to SYSTEM and
    Administrators. That is not a defence, it is an accident — and it is being
    removed deliberately, because a shop owner who cannot read why his own software
    failed cannot get it fixed. These cases are what makes opening that directory
    safe, so they are a permanent guard rather than a one-off check.
  */
  it('redacts a phone number from a customer search', () => {
    expect(redactUrlToken('/customers?query=07701234567&page=1')).toBe(
      '/customers?query=%5Bredacted%5D&page=1',
    );
    expect(redactUrlToken('/customers/search?query=07701234567')).toBe(
      '/customers/search?query=%5Bredacted%5D',
    );
  });

  it('redacts the resolve identifier — a phone or a signed card token', () => {
    expect(redactUrlToken('/customers/resolve?identifier=07701234567')).toBe(
      '/customers/resolve?identifier=%5Bredacted%5D',
    );
  });

  it('redacts a name searched in Arabic, percent-encoded or not', () => {
    // `URLSearchParams` decodes on read and re-encodes on write, so the assertion is
    // on the redacted output rather than on the byte sequence that arrived.
    expect(redactUrlToken('/customers?query=%D8%B2%D9%8A%D9%86%D8%A8')).toBe(
      '/customers?query=%5Bredacted%5D',
    );
  });

  it('keeps the path and the non-sensitive parameters', () => {
    // A support call has to be able to see WHICH endpoint was called and with what
    // paging — redacting the whole URL would trade one problem for another.
    expect(redactUrlToken('/customers?query=0770&category=VIP&page=2')).toBe(
      '/customers?query=%5Bredacted%5D&category=VIP&page=2',
    );
  });
});

describe('the Station is served with a content security policy (§7.3)', () => {
  it('sends one, and does not try to upgrade the connection', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    const policy = response.headers['content-security-policy'];

    // This service was JSON-only when the header was switched off, and then §12.3 made
    // it serve the Station's HTML on the same port.
    expect(policy).toBeTruthy();
    expect(String(policy)).toContain("default-src 'self'");

    // §7.1 makes LAN traffic deliberately plain HTTP. Helmet's default would have the
    // tablet rewrite every request to https:// against a service that does not answer
    // there — a hardening header taking the Station off the air.
    expect(String(policy)).not.toContain('upgrade-insecure-requests');
  });
});

describe('a query parameter cannot become a 500 (§7.4)', () => {
  it('refuses a date that is not a date', async () => {
    await setFlag({
      merchantId: world.merchantId,
      key: 'voucher_reconciliation',
      isEnabled: true,
      actorUserId: world.ownerId,
    });

    const response = await app.inject({
      method: 'GET',
      url: url('/vouchers/reconciliation?date=not-a-date'),
      headers: { authorization: `Bearer ${await tokenFor('manager')}` },
    });

    // `new Date('not-a-date')` is an Invalid Date, which Prisma cannot serialise into a
    // filter and `toISOString` throws on. A typo answering 500 reads as a server fault
    // and invites the client to retry it.
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('the reconciliation day is the merchant local day (§13.1)', () => {
  /** A voucher issued at a chosen instant, with the transaction it belongs to. */
  async function issueVoucherAt(issuedAt: Date, invoiceId: string): Promise<void> {
    const transaction = await prisma.transaction.create({
      data: {
        merchantId: world.merchantId,
        branchId: world.branchId,
        customerId: world.customerId,
        invoiceId,
        amountGross: 100_000,
        discountValue: 2_000,
        amountNet: 98_000,
        captureMode: 'MANUAL',
        occurredAt: issuedAt,
        capturedAt: issuedAt,
      },
    });

    await prisma.voucher.create({
      data: {
        merchantId: world.merchantId,
        transactionId: transaction.id,
        customerId: world.customerId,
        code: invoiceId,
        value: 2_000,
        settlementStrategy: 'VOUCHER_AS_PAYMENT',
        issuedAt,
      },
    });
  }

  it('files a voucher issued after local midnight under the new local day', async () => {
    // 01:30 on 1 September in Baghdad. Bucketed in UTC — which is what this did until
    // the V3-6 review — it lands on 31 August, and the manager counting slips in the
    // drawer on the 1st finds one the report says does not exist.
    await issueVoucherAt(new Date('2026-08-31T22:30:00Z'), 'INV-LATE');

    const september = await reconcileDay(world.merchantId, '2026-09-01');
    expect(september.date).toBe('2026-09-01');
    expect(september.issuedCount).toBe(1);

    const august = await reconcileDay(world.merchantId, '2026-08-31');
    expect(august.issuedCount).toBe(0);
  });

  it('files a voucher issued in the local evening under that same local day', async () => {
    // 21:00 local on 31 August is 18:00 UTC the same day — the case the UTC bucketing
    // got right, which is why the bug survived: normal trading hours hide it.
    await issueVoucherAt(new Date('2026-08-31T18:00:00Z'), 'INV-EVENING');

    const august = await reconcileDay(world.merchantId, '2026-08-31');
    expect(august.issuedCount).toBe(1);
  });
});

describe('report aggregates above the 32-bit line (§13.5)', () => {
  it('sums a customer past 2,147,483,647 IQD without wrapping', async () => {
    // §13.5 allows money to be a plain `Int` because every per-row value is bounded, and
    // warns that aggregates are not. A wholesale customer at this volume is not exotic:
    // 30 invoices of 100 million IQD is a fortnight of a mid-size distributor.
    const each = 100_000_000;
    const count = 30;
    const expected = each * count; // 3,000,000,000 — comfortably over Int32

    const at = new Date();
    for (let i = 0; i < count; i += 1) {
      await prisma.transaction.create({
        data: {
          merchantId: world.merchantId,
          branchId: world.branchId,
          customerId: world.customerId,
          invoiceId: `INV-BIG-${i}`,
          amountGross: each,
          discountValue: 0,
          amountNet: each,
          captureMode: 'MANUAL',
          occurredAt: at,
          capturedAt: at,
        },
      });
    }

    const overview = await getOverview(world.merchantId, '30d');

    expect(overview.capturedSales).toBe(expected);
    // The top-customers figure comes from a SQL `groupBy` rather than a JavaScript
    // reduce, which is the path §13.5 was actually warning about.
    expect(overview.topCustomers[0]?.spendInRange).toBe(expected);
  });
});
