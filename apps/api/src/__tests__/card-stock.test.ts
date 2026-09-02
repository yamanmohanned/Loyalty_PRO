import { PrismaClient } from '@prisma/client';
import { encodeCode128C, formatCardSerial, MAX_CARD_SERIAL } from '@walaa/shared-types';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API_PREFIX, buildApp } from '../app';
import { loadEnv } from '../config/env';
import { mintPrePrintedCardNumber, verifyPrePrintedCardNumber } from '../lib/card-number';
import { resetDatabase } from './helpers/db';
import { createWorld, TEST_PASSWORD, type World } from './helpers/fixtures';

/**
 * Physical card stock (CLAUDE_v3.md §12.25).
 *
 * Three properties are worth more than the rest of this file put together, and each
 * one is a way that a shop loses trust rather than a way that code goes wrong:
 *
 *  1. **An assigned card can never be assigned again.** The failure it prevents is
 *     one customer's details landing on a card in somebody else's pocket.
 *  2. **Batch ranges cannot overlap**, even through a bug, because a range is not a
 *     claim — every serial in it is a row under a unique constraint.
 *  3. **A dead card is refused with its own reason.** An operator told only that
 *     something failed will try again, which is the one thing that cannot help.
 */

const prisma = new PrismaClient();
const env = loadEnv();
let app: FastifyInstance;
let world: World;

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

const generateBatch = async (token: string, quantity: number, note?: string) =>
  app.inject({
    method: 'POST',
    url: url('/cards/batches'),
    headers: bearer(token),
    payload: note === undefined ? { quantity } : { quantity, note },
  });

/** The blank cards in a batch, in serial order. */
async function blanksOf(batchNumber: number) {
  const batch = await prisma.cardBatch.findFirstOrThrow({
    where: { merchantId: world.merchantId, batchNumber },
  });
  return prisma.card.findMany({
    where: { batchId: batch.id },
    orderBy: { serial: 'asc' },
  });
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
});

/* ── The number itself ─────────────────────────────────────────────────────── */

describe('the card.v2 number', () => {
  it('is sixteen digits: a six-digit serial then a ten-digit check', () => {
    const number = mintPrePrintedCardNumber(world.merchantId, 42, env.QR_TOKEN_SECRET);
    expect(number).toMatch(/^\d{16}$/);
    expect(number.slice(0, 6)).toBe('000042');
  });

  it('encodes to 143 modules — the frozen geometry, unchanged', () => {
    // §12.12 froze this: 143 modules including both quiet zones is 47.19 mm at a
    // 0.33 mm module, which fits 58 mm paper. Changing where the digits come from
    // must not change how wide the symbol is, or every fixture and every printer
    // setting in the field goes with it.
    const number = mintPrePrintedCardNumber(world.merchantId, 1, env.QR_TOKEN_SECRET);
    expect(encodeCode128C(number).totalModules).toBe(143);
  });

  it('is deterministic, so a lost export file can be regenerated', () => {
    // The difference between reprinting a manifest and reprinting a thousand cards.
    const first = mintPrePrintedCardNumber(world.merchantId, 7, env.QR_TOKEN_SECRET);
    const second = mintPrePrintedCardNumber(world.merchantId, 7, env.QR_TOKEN_SECRET);
    expect(first).toBe(second);
  });

  it('cannot be derived from a neighbouring serial', () => {
    // The whole reason for the HMAC. Someone holding card 000042 knows serial 43
    // exists; they must not be able to write down its number.
    const a = mintPrePrintedCardNumber(world.merchantId, 42, env.QR_TOKEN_SECRET);
    const b = mintPrePrintedCardNumber(world.merchantId, 43, env.QR_TOKEN_SECRET);
    expect(a.slice(6)).not.toBe(b.slice(6));
    expect(verifyPrePrintedCardNumber(`000043${a.slice(6)}`, world.merchantId, env.QR_TOKEN_SECRET)).toBe(
      false,
    );
  });

  it('is bound to the merchant', () => {
    const number = mintPrePrintedCardNumber(world.merchantId, 42, env.QR_TOKEN_SECRET);
    expect(verifyPrePrintedCardNumber(number, 'another-merchant', env.QR_TOKEN_SECRET)).toBe(false);
  });

  it('refuses a serial past the printed ceiling rather than rolling over', () => {
    expect(() =>
      mintPrePrintedCardNumber(world.merchantId, MAX_CARD_SERIAL + 1, env.QR_TOKEN_SECRET),
    ).toThrow();
  });
});

/* ── Batches ───────────────────────────────────────────────────────────────── */

describe('generating batches', () => {
  it('computes the starting serial itself, and consecutive batches do not overlap', async () => {
    const token = await tokenFor('owner');

    const first = await generateBatch(token, 5, 'الدفعة الأولى');
    const second = await generateBatch(token, 3);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().batch.serialStart).toBe(1);
    expect(first.json().batch.serialEnd).toBe(5);
    // The merchant's actual worry: batch two must start where batch one stopped.
    expect(second.json().batch.serialStart).toBe(6);
    expect(second.json().batch.serialEnd).toBe(8);

    const serials = (await prisma.card.findMany({ where: { merchantId: world.merchantId } }))
      .map((card) => card.serial)
      .filter((serial): serial is number => serial !== null)
      .sort((a, b) => a - b);
    expect(serials).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('refuses a starting serial even if one is sent', async () => {
    // Removing the choice is the mechanism. A request that carries one is rejected
    // by the strict schema rather than quietly ignored, so a client cannot come to
    // depend on setting it.
    const response = await app.inject({
      method: 'POST',
      url: url('/cards/batches'),
      headers: bearer(await tokenFor('owner')),
      payload: { quantity: 5, serialStart: 900 },
    });
    expect(response.statusCode).toBe(400);
  });

  it('makes an overlapping range impossible at the database level', async () => {
    const token = await tokenFor('owner');
    await generateBatch(token, 3);
    const batch = await prisma.cardBatch.findFirstOrThrow({
      where: { merchantId: world.merchantId },
    });

    // Forge the bug the constraint exists for: a second batch that believes it may
    // start at 1. The row cannot be written, whatever the service thought.
    await expect(
      prisma.card.create({
        data: {
          merchantId: world.merchantId,
          serial: 1,
          cardNumber: mintPrePrintedCardNumber(world.merchantId, 1, env.QR_TOKEN_SECRET),
          scheme: 'card.v2',
          origin: 'PRE_PRINTED',
          status: 'PRINTED',
          batchId: batch.id,
        },
      }),
    ).rejects.toThrow();
  });

  it('counts blanks per batch, which is how the merchant knows to reorder', async () => {
    const token = await tokenFor('owner');
    await generateBatch(token, 4);

    const listed = await app.inject({
      method: 'GET',
      url: url('/cards/batches'),
      headers: bearer(token),
    });

    expect(listed.statusCode).toBe(200);
    expect(listed.json().batches[0].counts.printed).toBe(4);
    expect(listed.json().blanksRemaining).toBe(4);
    expect(listed.json().nextSerial).toBe(5);
  });

  it('exports every number in the batch, and a manifest carrying none of them', async () => {
    const token = await tokenFor('owner');
    const batch = await generateBatch(token, 3);

    const exported = await app.inject({
      method: 'POST',
      url: url(`/cards/batches/${batch.json().batch.id}/export`),
      headers: bearer(token),
    });

    expect(exported.statusCode).toBe(200);
    expect(exported.json().rows).toHaveLength(3);
    expect(exported.json().csv.split('\r\n')).toHaveLength(4); // header + 3

    // The manifest is the copy that gets filed, pinned up or photographed. A range
    // and a count is all it needs to be, and a card number is the one thing it must
    // never carry.
    const manifest = exported.json().manifest as string;
    for (const row of exported.json().rows as Array<{ cardNumber: string }>) {
      expect(manifest).not.toContain(row.cardNumber);
    }
    expect(manifest).toContain(formatCardSerial(1));
  });

  /* ── Reprinting a slice (2026-09-02) ───────────────────────────────────── */

  it('exports the whole batch for a caller that sends no body at all', async () => {
    const token = await tokenFor('owner');
    const batch = await generateBatch(token, 4);

    // No payload and no content-type — the shape curl, a script and the packaging
    // smoke test send. It reaches the validator as `null`, which is why the schema
    // preprocesses rather than defaulting (§12.20 read from the other end).
    const exported = await app.inject({
      method: 'POST',
      url: url(`/cards/batches/${batch.json().batch.id}/export`),
      headers: bearer(token),
    });

    expect(exported.statusCode).toBe(200);
    expect(exported.json().rows).toHaveLength(4);
    expect(exported.json().exportedRangeFormatted).toBeNull();
  });

  it('exports the whole batch for a browser sending an empty JSON body', async () => {
    const token = await tokenFor('owner');
    const batch = await generateBatch(token, 4);

    const exported = await app.inject({
      method: 'POST',
      url: url(`/cards/batches/${batch.json().batch.id}/export`),
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: {},
    });

    expect(exported.statusCode).toBe(200);
    expect(exported.json().rows).toHaveLength(4);
  });

  it('exports only the requested serial range', async () => {
    const token = await tokenFor('owner');
    const batch = await generateBatch(token, 10);

    const exported = await app.inject({
      method: 'POST',
      url: url(`/cards/batches/${batch.json().batch.id}/export`),
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: { serialFrom: 3, serialTo: 5 },
    });

    expect(exported.statusCode).toBe(200);
    expect(exported.json().rows.map((row: { serial: string }) => row.serial)).toEqual([
      formatCardSerial(3),
      formatCardSerial(4),
      formatCardSerial(5),
    ]);
    expect(exported.json().exportedRangeFormatted).toBe(
      `${formatCardSerial(3)} — ${formatCardSerial(5)}`,
    );
  });

  it('still reports the tallies for the WHOLE batch when only a slice is exported', async () => {
    const token = await tokenFor('owner');
    const batch = await generateBatch(token, 10);

    const exported = await app.inject({
      method: 'POST',
      url: url(`/cards/batches/${batch.json().batch.id}/export`),
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: { serialFrom: 3, serialTo: 5 },
    });

    // Counting the exported rows instead — which is what the first version of this
    // did — makes a batch appear to shrink every time somebody reprints part of it,
    // on the very screen that renders this response.
    expect(exported.json().rows).toHaveLength(3);
    expect(exported.json().batch.counts.printed).toBe(10);
    expect(exported.json().batch.quantity).toBe(10);
  });

  it('does not advance a batch to EXPORTED on a partial reprint', async () => {
    const token = await tokenFor('owner');
    const batch = await generateBatch(token, 10);

    const exported = await app.inject({
      method: 'POST',
      url: url(`/cards/batches/${batch.json().batch.id}/export`),
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: { serialFrom: 1, serialTo: 2 },
    });

    // Reprinting two cards does not mean the batch has been sent to the printer.
    expect(exported.json().batch.status).toBe('GENERATED');
  });

  it('names only the reprinted range in the audit trail', async () => {
    const token = await tokenFor('owner');
    const batch = await generateBatch(token, 10);

    await app.inject({
      method: 'POST',
      url: url(`/cards/batches/${batch.json().batch.id}/export`),
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: { serialFrom: 3, serialTo: 5 },
    });

    // "Who has seen these numbers" has to stay answerable, and it would not be if a
    // three-card reprint were logged the same way as a ten-card export.
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'card_batch.exported' },
      orderBy: { createdAt: 'desc' },
    });
    const after = JSON.parse(entry.afterJson ?? '{}');
    expect(after.rows).toBe(3);
    expect(after.range).toBe(`${formatCardSerial(3)} — ${formatCardSerial(5)}`);
  });

  it('refuses half a range — "from 40" with no end is ambiguous', async () => {
    const token = await tokenFor('owner');
    const batch = await generateBatch(token, 10);

    const exported = await app.inject({
      method: 'POST',
      url: url(`/cards/batches/${batch.json().batch.id}/export`),
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: { serialFrom: 3 },
    });

    expect(exported.statusCode).toBe(400);
  });

  it('refuses a range lying entirely outside the batch', async () => {
    const token = await tokenFor('owner');
    const batch = await generateBatch(token, 10);

    const exported = await app.inject({
      method: 'POST',
      url: url(`/cards/batches/${batch.json().batch.id}/export`),
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: { serialFrom: 900, serialTo: 999 },
    });

    expect(exported.statusCode).toBe(400);
  });

  it('clamps a range that overhangs the end rather than refusing it', async () => {
    const token = await tokenFor('owner');
    const batch = await generateBatch(token, 5);

    const exported = await app.inject({
      method: 'POST',
      url: url(`/cards/batches/${batch.json().batch.id}/export`),
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: { serialFrom: 4, serialTo: 40 },
    });

    // The merchant is reading serials off a damaged stack. An off-by-one at the end
    // of the run should produce the cards that exist, not an error message.
    expect(exported.statusCode).toBe(200);
    expect(exported.json().rows).toHaveLength(2);
    expect(exported.json().exportedRangeFormatted).toBe(
      `${formatCardSerial(4)} — ${formatCardSerial(5)}`,
    );
  });

  it('is refused to the station — stock is the owner\'s business', async () => {
    const response = await generateBatch(await tokenFor('station'), 5);
    expect(response.statusCode).toBe(403);
  });
});

/* ── Assignment ────────────────────────────────────────────────────────────── */

describe('assigning a card at registration', () => {
  async function register(token: string, cardNumber: string | undefined, phone: string) {
    return app.inject({
      method: 'POST',
      url: url('/customers'),
      headers: bearer(token),
      payload: {
        name: 'زينب كاظم',
        phone,
        ...(cardNumber === undefined ? {} : { cardNumber }),
      },
    });
  }

  it('binds the scanned blank to the new customer', async () => {
    const owner = await tokenFor('owner');
    await generateBatch(owner, 2);
    const [blank] = await blanksOf(1);

    const response = await register(await tokenFor('station'), blank!.cardNumber, '07801112233');

    expect(response.statusCode).toBe(201);
    expect(response.json().customer.cardNumber).toBe(blank!.cardNumber);

    const stored = await prisma.card.findUniqueOrThrow({ where: { id: blank!.id } });
    expect(stored.status).toBe('ASSIGNED');
    expect(stored.customerId).toBe(response.json().customer.id);
  });

  it('never assigns the same card twice', async () => {
    // The failure this prevents: one customer's details on a card another person is
    // holding. The second registration must fail, and the first customer must keep
    // their card.
    const owner = await tokenFor('owner');
    await generateBatch(owner, 1);
    const [blank] = await blanksOf(1);
    const station = await tokenFor('station');

    const first = await register(station, blank!.cardNumber, '07801112233');
    const second = await register(station, blank!.cardNumber, '07801119999');

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('CARD_NOT_ISSUABLE');

    const stored = await prisma.card.findUniqueOrThrow({ where: { id: blank!.id } });
    expect(stored.customerId).toBe(first.json().customer.id);

    // And the second customer was not half-created: the card and the person are
    // written in one transaction precisely so a counter is never left to unpick it.
    const stranded = await prisma.customer.findFirst({
      where: { merchantId: world.merchantId, phone: '+9647801119999' },
    });
    expect(stranded).toBeNull();
  });

  it('survives two stations racing for the same blank', async () => {
    const owner = await tokenFor('owner');
    await generateBatch(owner, 1);
    const [blank] = await blanksOf(1);
    const station = await tokenFor('station');

    const [a, b] = await Promise.all([
      register(station, blank!.cardNumber, '07801110001'),
      register(station, blank!.cardNumber, '07801110002'),
    ]);

    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([201, 409]);
    const assigned = await prisma.card.count({
      where: { id: blank!.id, status: 'ASSIGNED' },
    });
    expect(assigned).toBe(1);
  });

  it('falls back to a thermal card when no blank is scanned', async () => {
    // §6.3: nobody is turned away because the stock drawer is empty.
    const response = await register(await tokenFor('station'), undefined, '07801112244');

    expect(response.statusCode).toBe(201);
    const card = await prisma.card.findFirstOrThrow({
      where: { customerId: response.json().customer.id },
    });
    expect(card.origin).toBe('THERMAL');
    expect(card.scheme).toBe('card.v1');
    // A thermal card must not consume a serial, or the count of blanks the batch
    // screen reports would drift from the drawer.
    expect(card.serial).toBeNull();
  });

  it('refuses a voided blank, and says so', async () => {
    const owner = await tokenFor('owner');
    await generateBatch(owner, 1);
    const [blank] = await blanksOf(1);
    await app.inject({
      method: 'POST',
      url: url(`/cards/${blank!.id}/void`),
      headers: bearer(owner),
      payload: { reason: 'طباعة تالفة' },
    });

    const response = await register(await tokenFor('station'), blank!.cardNumber, '07801112255');

    expect(response.statusCode).toBe(409);
    expect(response.json().error.details.rejection).toBe('VOID');
  });
});

/* ── Scanning a card that cannot be used ───────────────────────────────────── */

describe('scanning a card in each state', () => {
  const scan = async (token: string, cardNumber: string) =>
    app.inject({
      method: 'POST',
      url: url('/scan/card'),
      headers: bearer(token),
      payload: { barcodeToken: cardNumber },
    });

  it('offers registration for a blank card, carrying that card into it', async () => {
    const owner = await tokenFor('owner');
    await generateBatch(owner, 1);
    const [blank] = await blanksOf(1);

    const response = await scan(await tokenFor('station'), blank!.cardNumber);

    expect(response.json().outcome).toBe('UNKNOWN_CARD');
    // UNASSIGNED rather than UNKNOWN: the operator is holding a real card, and
    // registration should bind it rather than mint a fresh one and waste it.
    expect(response.json().cardRejection).toBe('UNASSIGNED');
    expect(response.json().scannedCard.serialFormatted).toBe('000001');
  });

  it('refuses a lost card by name, and does not offer registration', async () => {
    const station = await tokenFor('station');
    await app.inject({
      method: 'POST',
      url: url(`/cards/${world.customerCardId}/lost`),
      headers: bearer(station),
      payload: {},
    });

    const response = await scan(station, world.customerBarcode);

    expect(response.json().outcome).toBe('CARD_REJECTED');
    expect(response.json().cardRejection).toBe('LOST');
  });

  it('gives an unknown number and a bad check code the same answer', async () => {
    // Deliberate: telling them apart would confirm to a forger that their check
    // digits were right. Same oracle §12.19's constant-time comparison refuses.
    const station = await tokenFor('station');
    const real = mintPrePrintedCardNumber(world.merchantId, 500, env.QR_TOKEN_SECRET);
    const forged = `${real.slice(0, 6)}0000000000`;

    const unknown = await scan(station, '1234567890123456');
    const badCheck = await scan(station, forged);

    expect(unknown.json().outcome).toBe('UNKNOWN_CARD');
    expect(unknown.json().cardRejection).toBe('UNKNOWN');
    expect(badCheck.json().cardRejection).toBe('UNKNOWN');
    expect(badCheck.json().scannedCard).toBeNull();
  });
});

/* ── Lost, found, replaced ─────────────────────────────────────────────────── */

describe('the life of a card after it is issued', () => {
  it('restores a card the customer found', async () => {
    const station = await tokenFor('station');
    await app.inject({
      method: 'POST',
      url: url(`/cards/${world.customerCardId}/lost`),
      headers: bearer(station),
      payload: {},
    });

    const restored = await app.inject({
      method: 'POST',
      url: url(`/cards/${world.customerCardId}/restore`),
      headers: bearer(station),
      payload: { reason: 'وجدها الزبون' },
    });

    expect(restored.statusCode).toBe(200);
    expect(restored.json().card.status).toBe('ASSIGNED');
  });

  it('refuses to restore by name once a replacement is live', async () => {
    // The point of the test is that the impossibility is *reported*, not swallowed:
    // an operator told only "failed" will retry something that can never work.
    //
    // Two mechanisms answer this, and the gentler one gets there first. Replacing a
    // card retires it to REPLACED, so the state guard refuses with the reason that
    // is actually true for the person at the counter — "this card was replaced" —
    // rather than the partial index's blunter "you already hold a live card". The
    // index stays as the backstop for any future path that leaves a card LOST while
    // the customer acquires another; nothing reaches it today, and that is the
    // correct order of defences rather than a redundancy.
    const owner = await tokenFor('owner');
    const station = await tokenFor('station');
    await generateBatch(owner, 1);
    const [blank] = await blanksOf(1);

    await app.inject({
      method: 'POST',
      url: url(`/cards/${world.customerCardId}/lost`),
      headers: bearer(station),
      payload: {},
    });
    await app.inject({
      method: 'POST',
      url: url(`/cards/${world.customerCardId}/replace`),
      headers: bearer(station),
      payload: { cardNumber: blank!.cardNumber },
    });

    const restored = await app.inject({
      method: 'POST',
      url: url(`/cards/${world.customerCardId}/restore`),
      headers: bearer(station),
      payload: { reason: 'وجدها الزبون' },
    });

    expect(restored.statusCode).toBe(409);
    expect(restored.json().error.code).toBe('CARD_NOT_ISSUABLE');
    expect(restored.json().error.message).toContain('استُبدلت');

    // And the replacement is untouched by the attempt.
    const live = await prisma.card.count({
      where: { merchantId: world.merchantId, customerId: world.customerId, status: 'ASSIGNED' },
    });
    expect(live).toBe(1);
  });

  it('retires the old number and keeps the customer whole', async () => {
    const owner = await tokenFor('owner');
    const station = await tokenFor('station');
    await generateBatch(owner, 1);
    const [blank] = await blanksOf(1);
    const oldNumber = world.customerBarcode;

    const replaced = await app.inject({
      method: 'POST',
      url: url(`/cards/${world.customerCardId}/replace`),
      headers: bearer(station),
      payload: { cardNumber: blank!.cardNumber, reason: 'تلف البطاقة' },
    });

    expect(replaced.statusCode).toBe(200);
    expect(replaced.json().oldCard.status).toBe('REPLACED');
    expect(replaced.json().newCard.status).toBe('ASSIGNED');

    // The old number is dead from now on — the whole point of REPLACED.
    const scanned = await app.inject({
      method: 'POST',
      url: url('/scan/card'),
      headers: bearer(station),
      payload: { barcodeToken: oldNumber },
    });
    expect(scanned.json().cardRejection).toBe('REPLACED');
    // And it names its successor, so the counter can say what happened.
    expect(scanned.json().scannedCard.replacedBySerial).toBe('000001');

    // The customer is untouched: identity and history never lived on the card.
    const resolved = await app.inject({
      method: 'GET',
      url: url(`/customers/resolve?identifier=${blank!.cardNumber}`),
      headers: bearer(station),
    });
    expect(resolved.json().customer.id).toBe(world.customerId);
  });

  it('issues a paper card when there is no blank to hand', async () => {
    const station = await tokenFor('station');

    const replaced = await app.inject({
      method: 'POST',
      url: url(`/cards/${world.customerCardId}/replace-thermal`),
      headers: bearer(station),
      payload: { reason: 'لا توجد بطاقات جاهزة' },
    });

    expect(replaced.statusCode).toBe(200);
    expect(replaced.json().newCard.origin).toBe('THERMAL');
    expect(replaced.json().newCard.serialFormatted).toBeNull();

    // The customer walks away with a working card, which is the promise.
    const resolved = await app.inject({
      method: 'GET',
      url: url(`/customers/resolve?identifier=${replaced.json().newCard.cardNumber}`),
      headers: bearer(station),
    });
    expect(resolved.json().customer.id).toBe(world.customerId);
  });

  it('never lets a customer hold two live cards', async () => {
    const owner = await tokenFor('owner');
    await generateBatch(owner, 1);
    const [blank] = await blanksOf(1);

    // Forge the state the partial index exists to forbid.
    await expect(
      prisma.card.update({
        where: { id: blank!.id },
        data: { status: 'ASSIGNED', customerId: world.customerId, assignedAt: new Date() },
      }),
    ).rejects.toThrow();
  });
});

/* ── Voiding a batch ───────────────────────────────────────────────────────── */

describe('voiding a whole batch after a leak', () => {
  it('retires the blanks and leaves issued cards alone', async () => {
    const owner = await tokenFor('owner');
    const station = await tokenFor('station');
    const batch = await generateBatch(owner, 3);
    const blanks = await blanksOf(1);

    await app.inject({
      method: 'POST',
      url: url('/customers'),
      headers: bearer(station),
      payload: { name: 'علي جاسم', phone: '07801114455', cardNumber: blanks[0]!.cardNumber },
    });

    const voided = await app.inject({
      method: 'POST',
      url: url(`/cards/batches/${batch.json().batch.id}/void`),
      headers: bearer(owner),
      payload: { reason: 'تسرّب ملف الطباعة' },
    });

    expect(voided.statusCode).toBe(200);
    expect(voided.json().voided).toBe(2);

    // A card already in a customer's hand is not collateral for a spill of numbers.
    const issued = await prisma.card.findUniqueOrThrow({ where: { id: blanks[0]!.id } });
    expect(issued.status).toBe('ASSIGNED');
  });
});
