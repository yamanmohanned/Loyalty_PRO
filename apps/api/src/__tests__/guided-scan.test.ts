import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API_PREFIX, buildApp } from '../app';
import { ingestInvoice, type IngestionContext } from '../services/ingestion.service';
import { identifyCard, type ScanContext } from '../services/scan.service';
import { resetDatabase } from './helpers/db';
import { capturedInvoice, createWorld, TEST_PASSWORD, type World } from './helpers/fixtures';

/**
 * The guided two-step flow (CLAUDE.md §0 rule 1, §1.2 — built 2026-09-02).
 *
 * The property under test is the one the whole ordering exists for: **step 1 must
 * not change anything.** An identify call that quietly attributed an invoice would
 * be indistinguishable from a working lookup right up until a customer was charged
 * for a basket they had only walked past, so it is pinned here rather than trusted
 * to the shape of the code.
 *
 * The HTTP cases go through `app.inject` with the same `content-type` a browser
 * sends, because §12.20 is explicit that an endpoint exercised only by a test client
 * that builds requests differently from the real one has not been exercised.
 */

const prisma = new PrismaClient();
let app: FastifyInstance;
let world: World;
let agent: IngestionContext;
let station: ScanContext;

const url = (path: string) => `${API_PREFIX}${path}`;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

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
  agent = {
    merchantId: world.merchantId,
    userId: world.stationUserId,
    userBranchId: world.branchId,
    agentId: 'agent-01',
  };
  station = {
    merchantId: world.merchantId,
    userId: world.stationUserId,
    branchId: world.branchId,
    stationId: 'station-01',
  };
});

const capture = (invoiceId: string, amountGross: number) =>
  ingestInvoice(agent, capturedInvoice({ invoice_id: invoiceId, amount_gross: amountGross }));

describe('step 1 — identify', () => {
  it('names the customer behind a live card', async () => {
    const result = await identifyCard(station, { barcodeToken: world.customerBarcode });

    expect(result.outcome).toBe('IDENTIFIED');
    expect(result.customer?.id).toBe(world.customerId);
    expect(result.cardRejection).toBeNull();
  });

  it('leaves a captured invoice unattributed — identifying is not attributing', async () => {
    await capture('INV-1', 90_000);

    await identifyCard(station, { barcodeToken: world.customerBarcode });

    // The whole reason the two steps are separate. If this ever fails, a lookup has
    // started claiming sales and the card-first ordering has stopped protecting
    // anything.
    const stored = await prisma.transaction.findFirstOrThrow({
      where: { merchantId: world.merchantId, invoiceId: 'INV-1' },
    });
    expect(stored.customerId).toBeNull();
    expect(stored.linkedAt).toBeNull();
    expect(stored.discountValue).toBe(0);
    expect(await prisma.voucher.count({ where: { merchantId: world.merchantId } })).toBe(0);
  });

  it('offers the pending capture by number and amount, so the operator can check it', async () => {
    await capture('INV-2', 90_000);

    const result = await identifyCard(station, { barcodeToken: world.customerBarcode });

    expect(result.pendingInvoice).toEqual({
      invoiceId: 'INV-2',
      amountGross: 90_000,
      capturedAt: expect.any(String),
    });
  });

  it('reports no pending capture when the register has not printed yet', async () => {
    const result = await identifyCard(station, { barcodeToken: world.customerBarcode });

    expect(result.outcome).toBe('IDENTIFIED');
    expect(result.pendingInvoice).toBeNull();
  });

  it('routes an unknown number to enrolment, not to a refusal', async () => {
    // Sixteen digits that pass no check code — a number this server never minted.
    const result = await identifyCard(station, { barcodeToken: '1111222233334444' });

    expect(result.outcome).toBe('UNKNOWN_CARD');
    expect(result.customer).toBeNull();
  });

  it('refuses a card reported lost, and says which state it is in', async () => {
    await prisma.card.update({
      where: { id: world.customerCardId },
      data: { status: 'LOST' },
    });

    const result = await identifyCard(station, { barcodeToken: world.customerBarcode });

    expect(result.outcome).toBe('CARD_REJECTED');
    expect(result.cardRejection).toBe('LOST');
  });

  it('refuses a station with no branch — a sale belongs to one till area', async () => {
    await expect(
      identifyCard({ ...station, branchId: null }, { barcodeToken: world.customerBarcode }),
    ).rejects.toThrow();
  });
});

describe('step 1 over HTTP', () => {
  it('answers a station operator', async () => {
    const response = await app.inject({
      method: 'POST',
      url: url('/scan/identify'),
      headers: { ...bearer(await tokenFor('station')), 'content-type': 'application/json' },
      payload: { barcodeToken: world.customerBarcode },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().outcome).toBe('IDENTIFIED');
  });

  it('rejects an unknown field rather than ignoring it (§7 #4)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: url('/scan/identify'),
      headers: { ...bearer(await tokenFor('station')), 'content-type': 'application/json' },
      payload: { barcodeToken: world.customerBarcode, invoiceId: 'INV-1' },
    });

    // `invoiceId` belongs to the attribute call. Accepting it here would let a client
    // believe it had chosen an invoice at a step that cannot honour the choice.
    expect(response.statusCode).toBe(400);
  });

  it('is closed to the capture agent, which has no business reading customers', async () => {
    const response = await app.inject({
      method: 'POST',
      url: url('/scan/identify'),
      headers: { ...bearer(await tokenFor('agent')), 'content-type': 'application/json' },
      payload: { barcodeToken: world.customerBarcode },
    });

    expect(response.statusCode).toBe(403);
  });

  it('is closed to an unauthenticated caller', async () => {
    const response = await app.inject({
      method: 'POST',
      url: url('/scan/identify'),
      headers: { 'content-type': 'application/json' },
      payload: { barcodeToken: world.customerBarcode },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('step 2 — attributing the invoice the operator named', () => {
  it('claims the named invoice rather than whatever printed last', async () => {
    await capture('INV-OLD', 90_000);
    await capture('INV-NEW', 40_000);

    const response = await app.inject({
      method: 'POST',
      url: url('/scan/card'),
      headers: { ...bearer(await tokenFor('station')), 'content-type': 'application/json' },
      payload: { barcodeToken: world.customerBarcode, invoiceId: 'INV-OLD' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().transaction.invoiceId).toBe('INV-OLD');

    const untouched = await prisma.transaction.findFirstOrThrow({
      where: { merchantId: world.merchantId, invoiceId: 'INV-NEW' },
    });
    expect(untouched.customerId).toBeNull();
  });

  it('reports nothing pending for an invoice number that was never captured', async () => {
    const response = await app.inject({
      method: 'POST',
      url: url('/scan/card'),
      headers: { ...bearer(await tokenFor('station')), 'content-type': 'application/json' },
      payload: { barcodeToken: world.customerBarcode, invoiceId: 'INV-NOT-CAPTURED' },
    });

    // Not an error: the ordinary cause is a receipt the agent has not forwarded yet,
    // and the station tells the operator to ask for it.
    expect(response.statusCode).toBe(200);
    expect(response.json().outcome).toBe('NO_PENDING_INVOICE');
  });
});

describe('the discount label a cashier acts on', () => {
  it('states the value actually applied when the absolute cap bites', async () => {
    // A fixed-amount ladder well above the cap, so the two disagree.
    await prisma.discountSettings.update({
      where: { merchantId: world.merchantId },
      data: { discountType: 'FIXED_AMOUNT', absoluteMaxDiscountValue: 5_000 },
    });
    await prisma.discountRule.deleteMany({ where: { merchantId: world.merchantId } });
    await prisma.discountRule.create({
      data: {
        merchantId: world.merchantId,
        thresholdAmount: 25_000,
        discountType: 'FIXED_AMOUNT',
        discountRate: 7_500,
        maxDiscountValue: null,
        sortOrder: 0,
        isActive: true,
      },
    });
    await capture('INV-CAP', 260_000);

    const response = await app.inject({
      method: 'POST',
      url: url('/scan/card'),
      headers: { ...bearer(await tokenFor('station')), 'content-type': 'application/json' },
      payload: { barcodeToken: world.customerBarcode, invoiceId: 'INV-CAP' },
    });

    const slip = response.json().slip;
    expect(slip.discountValue).toBe(5_000);
    // The label and the value are both sums of money on one line of paper a cashier
    // takes money off a till for. They must be the same sum.
    expect(slip.discountLabel).toContain('5,000');
    expect(slip.discountLabel).not.toContain('7,500');
  });
});
