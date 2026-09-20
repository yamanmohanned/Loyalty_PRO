import type { Card, CardBatch, Prisma } from '@prisma/client';
import {
  CardBatchStatusSchema,
  CardOriginSchema,
  CardStatusSchema,
  formatCardNumber,
  formatCardSerial,
  MAX_CARD_SERIAL,
  normalizeCardNumber,
  type CardBatch as CardBatchDto,
  type CardBatchCounts,
  type CardBatchExportResponse,
  type CardBatchListResponse,
  type CardExportRow,
  type CardRejection,
  type Card as CardDto,
  type GenerateCardBatchRequest,
  type ScannedCard,
} from '@loyalty-pro/shared-types';
import { loadEnv } from '../config/env';
import { generateBarcodeToken } from '../lib/barcode-token';
import {
  CARD_SCHEME_V1,
  CARD_SCHEME_V2,
  identifyCardScheme,
  mintPrePrintedCardNumber,
} from '../lib/card-number';
import { cardNotIssuable, notFound, validationFailed } from '../lib/errors';
import { isUniqueViolation, prisma } from '../lib/prisma';
import { writeTransaction } from '../lib/write-transaction';
import { AUDIT_ACTIONS, recordAudit } from './audit.service';

const env = loadEnv();

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Physical card stock — batches, assignment, and the life of a card (§12.25).
 *
 * **The rule this module exists to keep: the customer record is the identity, the
 * card is only a credential.** Nothing here reads or writes a balance, a
 * transaction or a voucher. A card knows who holds it; the customer keeps their
 * history across every card they ever hold, because the history was never on the
 * card in the first place.
 */

/* ── Rejection messages ───────────────────────────────────────────────────── */

/**
 * One honest answer per state, for the person at the counter.
 *
 * Never a generic error: "this card was replaced" and "this card was never issued"
 * are different conversations, and an operator told only that something failed will
 * guess — usually by trying again, which is the one thing that cannot help.
 *
 * `UNKNOWN` deliberately covers both a number this server never minted and a number
 * whose check code failed. Distinguishing them would confirm to a forger that their
 * check digits were right, which is the oracle §12.19's constant-time comparison
 * refuses to be.
 */
export const CARD_REJECTION_MESSAGES: Readonly<Record<CardRejection, string>> = {
  UNKNOWN: 'بطاقة غير معروفة',
  UNASSIGNED: 'بطاقة غير مُسلَّمة لأي زبون بعد',
  LOST: 'هذه البطاقة مُبلَّغ عنها كمفقودة',
  REPLACED: 'هذه البطاقة استُبدلت ببطاقة أخرى',
  VOID: 'هذه البطاقة متلَفة ولا تُستخدم',
  INACTIVE_CUSTOMER: 'حساب الزبون موقوف',
};

/* ── Serialization ────────────────────────────────────────────────────────── */

export function serializeScannedCard(card: Card, replacedBySerial: number | null): ScannedCard {
  return {
    id: card.id,
    serialFormatted: card.serial === null ? null : formatCardSerial(card.serial),
    status: CardStatusSchema.parse(card.status),
    replacedBySerial: replacedBySerial === null ? null : formatCardSerial(replacedBySerial),
  };
}

type CardWithRelations = Card & {
  batch?: { batchNumber: number } | null;
  customer?: { name: string } | null;
  replacedBy?: { serial: number | null } | null;
};

export function serializeCard(card: CardWithRelations): CardDto {
  return {
    id: card.id,
    serial: card.serial,
    serialFormatted: card.serial === null ? null : formatCardSerial(card.serial),
    cardNumber: card.cardNumber,
    cardNumberFormatted: formatCardNumber(card.cardNumber),
    // SQLite stores these as plain strings, so parse rather than cast — a bad value
    // must surface here and not leak into a response the UI trusts (§enums.ts).
    status: CardStatusSchema.parse(card.status),
    origin: CardOriginSchema.parse(card.origin),
    batchNumber: card.batch?.batchNumber ?? null,
    customerId: card.customerId,
    customerName: card.customer?.name ?? null,
    assignedAt: card.assignedAt ? card.assignedAt.toISOString() : null,
    replacedBySerial:
      card.replacedBy?.serial === null || card.replacedBy?.serial === undefined
        ? null
        : formatCardSerial(card.replacedBy.serial),
    createdAt: card.createdAt.toISOString(),
  };
}

function emptyCounts(): CardBatchCounts {
  return { printed: 0, assigned: 0, lost: 0, replaced: 0, void: 0 };
}

function serializeBatch(
  batch: CardBatch & { generatedBy?: { name: string } | null },
  counts: CardBatchCounts,
): CardBatchDto {
  return {
    id: batch.id,
    batchNumber: batch.batchNumber,
    serialStart: batch.serialStart,
    serialEnd: batch.serialEnd,
    serialRangeFormatted: `${formatCardSerial(batch.serialStart)} — ${formatCardSerial(batch.serialEnd)}`,
    quantity: batch.quantity,
    status: CardBatchStatusSchema.parse(batch.status),
    note: batch.note,
    generatedByName: batch.generatedBy?.name ?? null,
    generatedAt: batch.generatedAt.toISOString(),
    exportedAt: batch.exportedAt ? batch.exportedAt.toISOString() : null,
    counts,
  };
}

/* ── Lookup ───────────────────────────────────────────────────────────────── */

export interface CardLookupHit {
  ok: true;
  card: Card;
  customerId: string;
}

export interface CardLookupMiss {
  ok: false;
  rejection: CardRejection;
  /** Null when the number is not one this server knows at all. */
  card: ScannedCard | null;
}

export type CardLookup = CardLookupHit | CardLookupMiss;

/**
 * Resolves a scanned number to a usable card, or says precisely why not.
 *
 * The signature check comes **before** any database work. A forged or mis-scanned
 * number is refused in memory, which keeps the station fast under a queue and denies
 * an attacker an enumeration oracle — the same order §12.12 established, now
 * covering both schemes.
 */
export async function lookupCard(
  merchantId: string,
  scanned: string,
  db: Db = prisma,
): Promise<CardLookup> {
  const digits = normalizeCardNumber(scanned);
  const scheme = identifyCardScheme(digits, merchantId, env.QR_TOKEN_SECRET);
  if (!scheme) return { ok: false, rejection: 'UNKNOWN', card: null };

  const card = await db.card.findFirst({
    where: { merchantId, cardNumber: digits },
    include: { replacedBy: { select: { serial: true } }, customer: { select: { isActive: true } } },
  });
  if (!card) return { ok: false, rejection: 'UNKNOWN', card: null };

  const summary = serializeScannedCard(card, card.replacedBy?.serial ?? null);

  if (card.status !== 'ASSIGNED') {
    const rejection = card.status === 'PRINTED' ? 'UNASSIGNED' : (card.status as CardRejection);
    return { ok: false, rejection, card: summary };
  }
  if (!card.customerId) {
    // Unreachable while the CHECK constraint holds; asserted rather than assumed
    // because the alternative is a null customer id flowing into a sale.
    return { ok: false, rejection: 'UNKNOWN', card: summary };
  }
  if (card.customer && !card.customer.isActive) {
    return { ok: false, rejection: 'INACTIVE_CUSTOMER', card: summary };
  }

  return { ok: true, card, customerId: card.customerId };
}

/** The card a customer currently holds, or null between a loss and a replacement. */
export async function findActiveCard(
  merchantId: string,
  customerId: string,
  db: Db = prisma,
): Promise<Card | null> {
  return db.card.findFirst({ where: { merchantId, customerId, status: 'ASSIGNED' } });
}

/* ── Batch generation ─────────────────────────────────────────────────────── */

/**
 * Generates a batch of pre-printed cards.
 *
 * **The merchant chooses the quantity and never the starting serial.** His actual
 * worry is a second batch colliding with the first, and the way to remove that worry
 * is to remove the choice: the start is computed from the highest serial that
 * exists. A field he cannot fill in wrongly beats a validation message telling him
 * he did.
 *
 * Overlap is impossible even through a bug, because a batch's range is not an
 * independent claim — every serial in it is a `card` row under
 * `UNIQUE(merchant_id, serial)`, so a second batch covering the same numbers fails
 * on INSERT. The transaction below could be wrong about the maximum and still could
 * not produce a collision.
 */
export async function generateCardBatch(
  params: { merchantId: string; actorUserId: string },
  request: GenerateCardBatchRequest,
): Promise<CardBatchDto> {
  const created = await writeTransaction(async (db) => {
    const highest = await db.card.aggregate({
      where: { merchantId: params.merchantId },
      _max: { serial: true },
    });
    const serialStart = (highest._max.serial ?? 0) + 1;
    const serialEnd = serialStart + request.quantity - 1;

    if (serialEnd > MAX_CARD_SERIAL) {
      // Refuse rather than roll over. A refusal stops the line and gets a phone
      // call; a rollover silently re-issues a serial that is already in somebody's
      // wallet, and the first anyone knows of it is two people holding one number.
      throw validationFailed(
        `لا تتسع المسلسلات لهذه الكمية — أعلى مسلسل ممكن هو ${formatCardSerial(MAX_CARD_SERIAL)}`,
      );
    }

    const lastBatch = await db.cardBatch.findFirst({
      where: { merchantId: params.merchantId },
      orderBy: { batchNumber: 'desc' },
      select: { batchNumber: true },
    });

    const batch = await db.cardBatch.create({
      data: {
        merchantId: params.merchantId,
        batchNumber: (lastBatch?.batchNumber ?? 0) + 1,
        serialStart,
        serialEnd,
        quantity: request.quantity,
        status: 'GENERATED',
        note: request.note ?? null,
        generatedByUserId: params.actorUserId,
      },
      include: { generatedBy: { select: { name: true } } },
    });

    const rows = [];
    for (let serial = serialStart; serial <= serialEnd; serial += 1) {
      rows.push({
        merchantId: params.merchantId,
        serial,
        cardNumber: mintPrePrintedCardNumber(params.merchantId, serial, env.QR_TOKEN_SECRET),
        scheme: CARD_SCHEME_V2,
        origin: 'PRE_PRINTED',
        status: 'PRINTED',
        batchId: batch.id,
      });
    }
    await db.card.createMany({ data: rows });

    await recordAudit(
      {
        merchantId: params.merchantId,
        actorUserId: params.actorUserId,
        action: AUDIT_ACTIONS.CARD_BATCH_GENERATED,
        entityType: 'card_batch',
        entityId: batch.id,
        after: {
          batchNumber: batch.batchNumber,
          serialStart,
          serialEnd,
          quantity: request.quantity,
        },
      },
      db,
    );

    return batch;
  });

  return serializeBatch(created, { ...emptyCounts(), printed: created.quantity });
}

/* ── Batch listing ────────────────────────────────────────────────────────── */

/**
 * Batches with their per-status tallies.
 *
 * The tallies are the point of the screen: `printed` is how many blank cards are
 * still in the drawer, which is what tells the merchant when to reorder. Grouped in
 * one query rather than counted per batch — a shop with twenty batches would
 * otherwise issue twenty-one round trips to render one table.
 */
export async function listCardBatches(merchantId: string): Promise<CardBatchListResponse> {
  const [batches, grouped, highest] = await Promise.all([
    prisma.cardBatch.findMany({
      where: { merchantId },
      orderBy: { batchNumber: 'desc' },
      include: { generatedBy: { select: { name: true } } },
    }),
    prisma.card.groupBy({
      by: ['batchId', 'status'],
      where: { merchantId, batchId: { not: null } },
      _count: { _all: true },
    }),
    prisma.card.aggregate({ where: { merchantId }, _max: { serial: true } }),
  ]);

  const countsByBatch = new Map<string, CardBatchCounts>();
  for (const row of grouped) {
    if (!row.batchId) continue;
    const counts = countsByBatch.get(row.batchId) ?? emptyCounts();
    const key = row.status.toLowerCase() as keyof CardBatchCounts;
    if (key in counts) counts[key] = row._count._all;
    countsByBatch.set(row.batchId, counts);
  }

  const serialized = batches.map((batch) =>
    serializeBatch(batch, countsByBatch.get(batch.id) ?? emptyCounts()),
  );

  return {
    batches: serialized,
    blanksRemaining: serialized.reduce((total, batch) => total + batch.counts.printed, 0),
    nextSerial: (highest._max.serial ?? 0) + 1,
  };
}

/* ── Batch export ─────────────────────────────────────────────────────────── */

const CSV_HEADER = 'serial,card_number,card_number_formatted';

/**
 * Quotes a CSV field the way a spreadsheet expects.
 *
 * Every value here is digits and spaces, so nothing needs escaping today. It is
 * here because the day somebody adds a note column with a comma in it, the export a
 * card printer consumes should not silently shift by one field.
 */
function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * The print-ready file, and a manifest for the merchant's records.
 *
 * **This file necessarily contains every card number in the batch** — a card printer
 * cannot print a barcode it has not been given — which makes it the one artefact of
 * this feature worth stealing, and means the printing vendor sees the whole batch.
 * Two things make that survivable: an unassigned card is worth nothing until
 * somebody physically hands it over at a station, and a leaked batch can be voided
 * wholesale by `voidCardBatch` below. Neither is a reason to leave the file lying
 * about after printing, which is why the export is audited with an actor.
 *
 * The manifest deliberately carries **no card numbers**. It is the copy that gets
 * filed, pinned up, or photographed, and a range plus a count is all it needs to be.
 */
export async function exportCardBatch(
  params: { merchantId: string; actorUserId: string },
  batchId: string,
  range?: { serialFrom?: number; serialTo?: number },
): Promise<CardBatchExportResponse> {
  const batch = await prisma.cardBatch.findFirst({
    where: { id: batchId, merchantId: params.merchantId },
    include: { generatedBy: { select: { name: true } } },
  });
  if (!batch) throw notFound('الدفعة غير موجودة');

  // A reprint range is clamped to the batch rather than rejected when it overhangs.
  // The merchant is reading serials off a damaged stack, and an off-by-one at the
  // end of the run should produce the cards that exist, not an error message.
  const from = range?.serialFrom;
  const to = range?.serialTo;
  const ranged = from !== undefined && to !== undefined;

  if (ranged && (to < batch.serialStart || from > batch.serialEnd)) {
    throw validationFailed('المدى المطلوب خارج نطاق هذه الدفعة');
  }

  const cards = await prisma.card.findMany({
    where: {
      batchId: batch.id,
      merchantId: params.merchantId,
      ...(ranged
        ? {
            serial: {
              gte: Math.max(from, batch.serialStart),
              lte: Math.min(to, batch.serialEnd),
            },
          }
        : {}),
    },
    orderBy: { serial: 'asc' },
    select: { serial: true, cardNumber: true },
  });

  const exportedRangeFormatted = ranged
    ? `${formatCardSerial(Math.max(from, batch.serialStart))} — ${formatCardSerial(Math.min(to, batch.serialEnd))}`
    : null;

  const rows: CardExportRow[] = cards
    .filter((card) => card.serial !== null)
    .map((card) => ({
      serial: formatCardSerial(card.serial as number),
      cardNumber: card.cardNumber,
      cardNumberFormatted: formatCardNumber(card.cardNumber),
    }));

  const csv = [
    CSV_HEADER,
    ...rows.map((row) =>
      [row.serial, row.cardNumber, row.cardNumberFormatted].map(csvField).join(','),
    ),
  ].join('\r\n');

  const manifest = [
    ranged ? 'إعادة طباعة بطاقات ولاء' : 'دفعة بطاقات ولاء',
    `رقم الدفعة: ${batch.batchNumber}`,
    `المدى: ${formatCardSerial(batch.serialStart)} — ${formatCardSerial(batch.serialEnd)}`,
    ranged ? `المدى في هذا الملف: ${exportedRangeFormatted}` : null,
    `الكمية: ${batch.quantity}`,
    ranged ? `عدد البطاقات في هذا الملف: ${rows.length}` : null,
    `أنشأها: ${batch.generatedBy?.name ?? '—'}`,
    `تاريخ الإنشاء: ${batch.generatedAt.toISOString()}`,
    batch.note ? `ملاحظة: ${batch.note}` : null,
    '',
    'ملف الطباعة يحتوي أرقام البطاقات كاملة. احذفه بعد انتهاء الطباعة.',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  const updated = await writeTransaction(async (db) => {
    const next = await db.cardBatch.update({
      where: { id: batch.id },
      // GENERATED → EXPORTED only. A batch already marked RECEIVED must not fall
      // back a step because somebody re-downloaded the file to reprint a few cards.
      data: {
        exportedAt: new Date(),
        // GENERATED → EXPORTED only, and only on a whole-batch export. A reprint of
        // forty cards does not mean the batch has been sent to the printer, and a
        // batch already RECEIVED must not fall back a step because somebody
        // re-downloaded a slice of it.
        status: !ranged && batch.status === 'GENERATED' ? 'EXPORTED' : batch.status,
      },
      include: { generatedBy: { select: { name: true } } },
    });

    await recordAudit(
      {
        merchantId: params.merchantId,
        actorUserId: params.actorUserId,
        action: AUDIT_ACTIONS.CARD_BATCH_EXPORTED,
        entityType: 'card_batch',
        entityId: batch.id,
        // What was actually read, not what could have been. A reprint logged as a
        // full export would make "who has seen these numbers" unanswerable.
        after: {
          batchNumber: batch.batchNumber,
          rows: rows.length,
          range: exportedRangeFormatted,
        },
      },
      db,
    );

    return next;
  });

  return {
    batch: serializeBatch(updated, await batchCounts(params.merchantId, batch.id)),
    rows,
    csv,
    manifest,
    exportedRangeFormatted,
  };
}

/**
 * A batch's status tallies, over the WHOLE batch.
 *
 * A `groupBy` rather than a tally of the rows just exported, and the distinction is
 * not cosmetic: a reprint of three cards would otherwise report a batch of five as
 * containing three, and the screen that renders the response would show a batch
 * shrinking every time somebody reprinted part of it. Counting in the database also
 * means the numbers are read without pulling a single card number out of it.
 */
async function batchCounts(merchantId: string, batchId: string): Promise<CardBatchCounts> {
  const grouped = await prisma.card.groupBy({
    by: ['status'],
    where: { merchantId, batchId },
    _count: { _all: true },
  });

  const counts = emptyCounts();
  for (const row of grouped) {
    const key = row.status.toLowerCase() as keyof CardBatchCounts;
    if (key in counts) counts[key] = row._count._all;
  }
  return counts;
}

/**
 * Retires every unissued card in a batch — the remedy for a leaked export file.
 *
 * One action rather than a thousand, because a merchant told "void the batch" who
 * has to void each card individually will not do it, and a remedy nobody performs is
 * not a remedy.
 *
 * **Only `PRINTED` cards are touched.** A card already in a customer's hand is not
 * collateral for a spill of numbers; taking it away would punish them for somebody
 * else's mistake, and the customer's identity was never at risk in the first place.
 */
export async function voidCardBatch(
  params: { merchantId: string; actorUserId: string },
  batchId: string,
  reason: string,
): Promise<{ batch: CardBatchDto; voided: number }> {
  const batch = await prisma.cardBatch.findFirst({
    where: { id: batchId, merchantId: params.merchantId },
  });
  if (!batch) throw notFound('الدفعة غير موجودة');

  const result = await writeTransaction(async (db) => {
    const voided = await db.card.updateMany({
      where: { batchId: batch.id, merchantId: params.merchantId, status: 'PRINTED' },
      data: { status: 'VOID', voidedAt: new Date(), voidReason: reason },
    });

    const next = await db.cardBatch.update({
      where: { id: batch.id },
      data: { status: 'RETIRED' },
      include: { generatedBy: { select: { name: true } } },
    });

    await recordAudit(
      {
        merchantId: params.merchantId,
        actorUserId: params.actorUserId,
        action: AUDIT_ACTIONS.CARD_BATCH_VOIDED,
        entityType: 'card_batch',
        entityId: batch.id,
        after: { batchNumber: batch.batchNumber, voided: voided.count, reason },
      },
      db,
    );

    return { batch: next, voided: voided.count };
  });

  const grouped = await prisma.card.groupBy({
    by: ['status'],
    where: { batchId: batch.id, merchantId: params.merchantId },
    _count: { _all: true },
  });
  const counts = emptyCounts();
  for (const row of grouped) {
    const key = row.status.toLowerCase() as keyof CardBatchCounts;
    if (key in counts) counts[key] = row._count._all;
  }

  return { batch: serializeBatch(result.batch, counts), voided: result.voided };
}

/* ── Assignment ───────────────────────────────────────────────────────────── */

/**
 * Binds a blank card to a customer, atomically and once.
 *
 * **Every precondition is in the WHERE clause**, the shape v1 §13.9 already uses for
 * voucher redemption, and the caller asserts exactly one row changed. A second
 * attempt matches zero rows, so an assigned card can never be reassigned — which is
 * what stops one customer's details landing on a card in somebody else's pocket. A
 * read-then-write would let two stations both believe they held a blank.
 *
 * Returns false rather than throwing so callers can report the card's actual state,
 * which they have to re-read to know.
 */
async function claimCard(
  db: Db,
  params: { cardId: string; merchantId: string; customerId: string; actorUserId: string },
): Promise<boolean> {
  const claimed = await db.card.updateMany({
    where: {
      id: params.cardId,
      merchantId: params.merchantId,
      status: 'PRINTED',
      customerId: null,
    },
    data: {
      status: 'ASSIGNED',
      customerId: params.customerId,
      assignedAt: new Date(),
      assignedByUserId: params.actorUserId,
    },
  });
  return claimed.count === 1;
}

/**
 * Refusal for a card that cannot be issued, naming the state it is actually in.
 *
 * Re-reads the row because the conditional UPDATE only reports that it matched
 * nothing, not why. The extra query happens on the failure path only, where an
 * accurate message is worth far more than the microseconds.
 */
async function refuseCard(db: Db, merchantId: string, cardId: string): Promise<never> {
  const card = await db.card.findFirst({ where: { id: cardId, merchantId } });
  const rejection: CardRejection =
    !card || card.status === 'PRINTED'
      ? 'UNKNOWN'
      : card.status === 'ASSIGNED'
        ? 'UNASSIGNED'
        : (card.status as CardRejection);

  // An ASSIGNED card that failed to be claimed is already somebody's. That is its
  // own message, and the most important one in this file: it is the refusal that
  // stops a customer's details being written over a card another person is holding.
  const message =
    card?.status === 'ASSIGNED'
      ? 'هذه البطاقة مُسلَّمة لزبون آخر — استخدم بطاقة جديدة'
      : CARD_REJECTION_MESSAGES[rejection];

  throw cardNotIssuable(card?.status === 'ASSIGNED' ? 'UNKNOWN' : rejection, message);
}

/**
 * Finds a blank card by scanned number, inside an open transaction.
 *
 * Verifies the check code before touching the database, exactly as the scan path
 * does — the operator scanning a blank at registration gets the same protection
 * against a forged number as the customer scanning at the till.
 */
export async function findAssignableCard(
  db: Db,
  merchantId: string,
  scanned: string,
): Promise<Card> {
  const digits = normalizeCardNumber(scanned);
  if (!identifyCardScheme(digits, merchantId, env.QR_TOKEN_SECRET)) {
    throw cardNotIssuable('UNKNOWN', CARD_REJECTION_MESSAGES.UNKNOWN);
  }

  const card = await db.card.findFirst({ where: { merchantId, cardNumber: digits } });
  if (!card) throw cardNotIssuable('UNKNOWN', CARD_REJECTION_MESSAGES.UNKNOWN);
  if (card.status !== 'PRINTED') {
    const rejection = (
      card.status === 'ASSIGNED' ? 'UNKNOWN' : card.status
    ) as CardRejection;
    const message =
      card.status === 'ASSIGNED'
        ? 'هذه البطاقة مُسلَّمة لزبون آخر — استخدم بطاقة جديدة'
        : CARD_REJECTION_MESSAGES[card.status as CardRejection];
    throw cardNotIssuable(rejection, message);
  }
  return card;
}

/**
 * Assigns a scanned blank card to a customer, inside the caller's transaction.
 *
 * Separate from `findAssignableCard` so registration can do both in one transaction
 * with the customer's own INSERT: a customer created without the card they were
 * handed, or a card claimed for a customer that failed to save, are both states
 * somebody has to unpick by hand at a counter.
 */
export async function assignCardInTransaction(
  db: Db,
  params: {
    merchantId: string;
    actorUserId: string;
    customerId: string;
    cardId: string;
    cardNumber: string;
    serial: number | null;
  },
): Promise<void> {
  const claimed = await claimCard(db, {
    cardId: params.cardId,
    merchantId: params.merchantId,
    customerId: params.customerId,
    actorUserId: params.actorUserId,
  });
  if (!claimed) await refuseCard(db, params.merchantId, params.cardId);

  await recordAudit(
    {
      merchantId: params.merchantId,
      actorUserId: params.actorUserId,
      action: AUDIT_ACTIONS.CARD_ASSIGNED,
      entityType: 'card',
      entityId: params.cardId,
      after: {
        customerId: params.customerId,
        serial: params.serial === null ? null : formatCardSerial(params.serial),
      },
    },
    db,
  );
}

/**
 * Mints and assigns a thermal card — the fallback when no blank is to hand (§6.3).
 *
 * `card.v1`, no serial, no batch: printed on demand, so there is no physical
 * inventory to track, and consuming a serial would corrupt the count of blanks the
 * batch screen exists to answer.
 *
 * Retries on the card-number unique constraint. Ten random digits make a collision a
 * curiosity rather than a risk, but "unlikely" is not "impossible" and the failure it
 * would otherwise produce lands on a customer standing at a counter.
 */
const THERMAL_MINT_ATTEMPTS = 5;

export async function issueThermalCard(
  db: Db,
  params: { merchantId: string; actorUserId: string; customerId: string },
): Promise<Card> {
  for (let attempt = 1; attempt <= THERMAL_MINT_ATTEMPTS; attempt += 1) {
    try {
      const card = await db.card.create({
        data: {
          merchantId: params.merchantId,
          serial: null,
          cardNumber: generateBarcodeToken(env.QR_TOKEN_SECRET),
          scheme: CARD_SCHEME_V1,
          origin: 'THERMAL',
          status: 'ASSIGNED',
          customerId: params.customerId,
          assignedAt: new Date(),
          assignedByUserId: params.actorUserId,
        },
      });

      await recordAudit(
        {
          merchantId: params.merchantId,
          actorUserId: params.actorUserId,
          action: AUDIT_ACTIONS.CARD_ASSIGNED,
          entityType: 'card',
          entityId: card.id,
          after: { customerId: params.customerId, origin: 'THERMAL' },
        },
        db,
      );

      return card;
    } catch (error) {
      if (isUniqueViolation(error) && attempt < THERMAL_MINT_ATTEMPTS) continue;
      throw error;
    }
  }
  throw validationFailed('تعذّر إنشاء رقم بطاقة فريد — أعد المحاولة');
}

/* ── Lifecycle ────────────────────────────────────────────────────────────── */

/** The card a lifecycle action names, with the relations its response needs. */
async function requireCard(merchantId: string, cardId: string, db: Db = prisma) {
  const card = await db.card.findFirst({
    where: { id: cardId, merchantId },
    include: {
      batch: { select: { batchNumber: true } },
      customer: { select: { name: true } },
      replacedBy: { select: { serial: true } },
    },
  });
  if (!card) throw notFound('البطاقة غير موجودة');
  return card;
}

/**
 * Reports a card lost. From this moment it is refused on every scan.
 *
 * This — not the check code — is the answer to a card someone finds on the floor. A
 * found card is a genuine card, and no arithmetic changes that; what bounds the
 * exposure is how quickly this runs. The customer keeps everything, because none of
 * it was ever on the card.
 */
export async function reportCardLost(
  params: { merchantId: string; actorUserId: string },
  cardId: string,
  reason?: string,
): Promise<CardDto> {
  const existing = await requireCard(params.merchantId, cardId);
  if (existing.status !== 'ASSIGNED') {
    throw cardNotIssuable(
      existing.status as CardRejection,
      CARD_REJECTION_MESSAGES[existing.status as CardRejection],
    );
  }

  await writeTransaction(async (db) => {
    const updated = await db.card.updateMany({
      where: { id: cardId, merchantId: params.merchantId, status: 'ASSIGNED' },
      data: { status: 'LOST', lostAt: new Date() },
    });
    if (updated.count !== 1) await refuseCard(db, params.merchantId, cardId);

    await recordAudit(
      {
        merchantId: params.merchantId,
        actorUserId: params.actorUserId,
        action: AUDIT_ACTIONS.CARD_REPORTED_LOST,
        entityType: 'card',
        entityId: cardId,
        before: { status: 'ASSIGNED' },
        after: { status: 'LOST', reason: reason ?? null },
      },
      db,
    );
  });

  return serializeCard(await requireCard(params.merchantId, cardId));
}

/**
 * Restores a card the customer thought they had lost.
 *
 * "I found it" is a real support call, and refusing it pushes staff into issuing a
 * replacement nobody needed — which costs a physical card and retires a good one.
 *
 * It is safe because the dangerous version is impossible rather than merely
 * discouraged: `card_one_active_per_customer` refuses a second live card, so a
 * customer already holding a replacement cannot acquire one. **That refusal is
 * caught and named** — a silent failure here would leave an operator retrying
 * something that can never work.
 *
 * Audited with an actor and a stated reason, because it re-arms a credential that
 * was deliberately disarmed.
 */
export async function restoreCard(
  params: { merchantId: string; actorUserId: string },
  cardId: string,
  reason: string,
): Promise<CardDto> {
  const existing = await requireCard(params.merchantId, cardId);
  if (existing.status !== 'LOST') {
    throw cardNotIssuable(
      'UNKNOWN',
      existing.status === 'ASSIGNED'
        ? 'هذه البطاقة فعّالة أصلاً'
        : CARD_REJECTION_MESSAGES[existing.status as CardRejection],
    );
  }

  try {
    await writeTransaction(async (db) => {
      await db.card.update({
        where: { id: cardId },
        data: { status: 'ASSIGNED', lostAt: null },
      });

      await recordAudit(
        {
          merchantId: params.merchantId,
          actorUserId: params.actorUserId,
          action: AUDIT_ACTIONS.CARD_RESTORED,
          entityType: 'card',
          entityId: cardId,
          before: { status: 'LOST' },
          after: { status: 'ASSIGNED', reason },
        },
        db,
      );
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // The partial index fired: this customer already holds a live card. Say so by
      // name — an operator told only "failed" will try again, and this is one of the
      // few failures that can never succeed on a retry.
      throw cardNotIssuable(
        'REPLACED',
        'لهذا الزبون بطاقة فعّالة أخرى — لا يمكن استعادة البطاقة القديمة',
      );
    }
    throw error;
  }

  return serializeCard(await requireCard(params.merchantId, cardId));
}

/**
 * Supersedes a customer's card with another physical card.
 *
 * The old card moves to `REPLACED` and is refused on every future scan; the new one
 * is claimed by the same conditional UPDATE registration uses. **The customer's
 * balance and history do not move, because they were never on the card.**
 *
 * The order — retire, then claim — is not a stylistic choice. The partial unique
 * index refuses the intermediate state where both are live, so the database forces
 * the safe sequence rather than trusting this function to remember it.
 */
export async function replaceCard(
  params: { merchantId: string; actorUserId: string },
  cardId: string,
  scannedNewCard: string,
  reason?: string,
): Promise<{ oldCard: CardDto; newCard: CardDto }> {
  const existing = await requireCard(params.merchantId, cardId);
  if (existing.status !== 'ASSIGNED' && existing.status !== 'LOST') {
    throw cardNotIssuable(
      existing.status as CardRejection,
      CARD_REJECTION_MESSAGES[existing.status as CardRejection],
    );
  }
  if (!existing.customerId) throw notFound('البطاقة غير مرتبطة بزبون');
  const customerId = existing.customerId;
  const previousStatus = existing.status;

  const newCardId = await writeTransaction(async (db) => {
    const replacement = await findAssignableCard(db, params.merchantId, scannedNewCard);

    // Retire first. The index would refuse the other order, so doing it this way
    // produces a correct failure rather than an unexplained constraint error.
    const retired = await db.card.updateMany({
      where: { id: cardId, merchantId: params.merchantId, status: previousStatus },
      data: { status: 'REPLACED', replacedByCardId: replacement.id },
    });
    if (retired.count !== 1) await refuseCard(db, params.merchantId, cardId);

    await assignCardInTransaction(db, {
      merchantId: params.merchantId,
      actorUserId: params.actorUserId,
      customerId,
      cardId: replacement.id,
      cardNumber: replacement.cardNumber,
      serial: replacement.serial,
    });

    await recordAudit(
      {
        merchantId: params.merchantId,
        actorUserId: params.actorUserId,
        action: AUDIT_ACTIONS.CARD_REPLACED,
        entityType: 'card',
        entityId: cardId,
        before: { status: previousStatus },
        after: { status: 'REPLACED', replacedByCardId: replacement.id, reason: reason ?? null },
      },
      db,
    );

    return replacement.id;
  });

  return {
    oldCard: serializeCard(await requireCard(params.merchantId, cardId)),
    newCard: serializeCard(await requireCard(params.merchantId, newCardId)),
  };
}

/**
 * Issues a thermal replacement when there is no physical card to hand (§6.3).
 *
 * The point of the fallback: a customer who has lost their card is never turned away
 * because the stock drawer is empty. They leave with a working paper card and their
 * entire history intact.
 */
export async function replaceCardWithThermal(
  params: { merchantId: string; actorUserId: string },
  cardId: string,
  reason?: string,
): Promise<{ oldCard: CardDto; newCard: CardDto }> {
  const existing = await requireCard(params.merchantId, cardId);
  if (existing.status !== 'ASSIGNED' && existing.status !== 'LOST') {
    throw cardNotIssuable(
      existing.status as CardRejection,
      CARD_REJECTION_MESSAGES[existing.status as CardRejection],
    );
  }
  if (!existing.customerId) throw notFound('البطاقة غير مرتبطة بزبون');
  const customerId = existing.customerId;
  const previousStatus = existing.status;

  const newCardId = await writeTransaction(async (db) => {
    const retired = await db.card.updateMany({
      where: { id: cardId, merchantId: params.merchantId, status: previousStatus },
      data: { status: 'REPLACED' },
    });
    if (retired.count !== 1) await refuseCard(db, params.merchantId, cardId);

    const replacement = await issueThermalCard(db, {
      merchantId: params.merchantId,
      actorUserId: params.actorUserId,
      customerId,
    });

    await db.card.update({
      where: { id: cardId },
      data: { replacedByCardId: replacement.id },
    });

    await recordAudit(
      {
        merchantId: params.merchantId,
        actorUserId: params.actorUserId,
        action: AUDIT_ACTIONS.CARD_REPLACED,
        entityType: 'card',
        entityId: cardId,
        before: { status: previousStatus },
        after: { status: 'REPLACED', replacedByCardId: replacement.id, reason: reason ?? null },
      },
      db,
    );

    return replacement.id;
  });

  return {
    oldCard: serializeCard(await requireCard(params.merchantId, cardId)),
    newCard: serializeCard(await requireCard(params.merchantId, newCardId)),
  };
}

/**
 * Voids a single blank card — a misprint, or one damaged in the drawer.
 *
 * Only `PRINTED` stock. A card in a customer's hand is retired by replacing it, not
 * by voiding it, so the trail records what actually happened to the person.
 */
export async function voidCard(
  params: { merchantId: string; actorUserId: string },
  cardId: string,
  reason: string,
): Promise<CardDto> {
  const existing = await requireCard(params.merchantId, cardId);
  if (existing.status !== 'PRINTED') {
    throw cardNotIssuable(
      'UNKNOWN',
      'لا يمكن إتلاف إلا البطاقات غير المُسلَّمة — استبدل البطاقة بدل ذلك',
    );
  }

  await writeTransaction(async (db) => {
    const voided = await db.card.updateMany({
      where: { id: cardId, merchantId: params.merchantId, status: 'PRINTED' },
      data: { status: 'VOID', voidedAt: new Date(), voidReason: reason },
    });
    if (voided.count !== 1) await refuseCard(db, params.merchantId, cardId);

    await recordAudit(
      {
        merchantId: params.merchantId,
        actorUserId: params.actorUserId,
        action: AUDIT_ACTIONS.CARD_VOIDED,
        entityType: 'card',
        entityId: cardId,
        before: { status: 'PRINTED' },
        after: { status: 'VOID', reason },
      },
      db,
    );
  });

  return serializeCard(await requireCard(params.merchantId, cardId));
}

/** Every card a customer has ever held, newest first — the support view. */
export async function listCustomerCards(
  merchantId: string,
  customerId: string,
): Promise<CardDto[]> {
  const cards = await prisma.card.findMany({
    where: { merchantId, customerId },
    orderBy: { createdAt: 'desc' },
    include: {
      batch: { select: { batchNumber: true } },
      customer: { select: { name: true } },
      replacedBy: { select: { serial: true } },
    },
  });
  return cards.map(serializeCard);
}

/** One card by id, for the manager's card detail and support flows. */
export async function getCard(merchantId: string, cardId: string): Promise<CardDto> {
  return serializeCard(await requireCard(merchantId, cardId));
}
