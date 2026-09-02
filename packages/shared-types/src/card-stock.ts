import { z } from 'zod';
import { CardBatchStatusSchema, CardOriginSchema, CardStatusSchema } from './enums';

/**
 * Physical card stock: batches, cards, and the operations on them (§12.25).
 *
 * The governing rule for everything in this file: **the customer record is the
 * identity, the card is only a credential.** Balance and history belong to the
 * customer and follow them across any number of cards. Nothing here carries a
 * balance, a spend, or a transaction — a card knows who holds it and nothing else
 * about them.
 */

/* ── Batch generation ─────────────────────────────────────────────────────── */

/**
 * Generating a batch takes a **quantity and nothing else**.
 *
 * There is deliberately no starting serial in this request. The merchant's actual
 * worry is printing a second batch that collides with the first, and the way to
 * remove that worry is to remove the choice: the server computes the next serial
 * from the highest one that exists. A field he cannot fill in wrongly beats a
 * validation message telling him he did.
 */
export const GenerateCardBatchRequestSchema = z
  .object({
    quantity: z.coerce
      .number()
      .int('الكمية يجب أن تكون عدداً صحيحاً')
      .min(1, 'أقل كمية هي بطاقة واحدة')
      .max(20000, 'أقصى كمية في الدفعة الواحدة هي 20,000 بطاقة'),
    /** Free-text note for the merchant's own records — vendor, order number. */
    note: z.string().trim().max(200).optional(),
  })
  .strict();

export type GenerateCardBatchRequest = z.infer<typeof GenerateCardBatchRequestSchema>;

/** Per-batch tallies, so the merchant knows how many blanks are left to hand out. */
export const CardBatchCountsSchema = z.object({
  printed: z.number().int(),
  assigned: z.number().int(),
  lost: z.number().int(),
  replaced: z.number().int(),
  void: z.number().int(),
});

export type CardBatchCounts = z.infer<typeof CardBatchCountsSchema>;

export const CardBatchSchema = z.object({
  id: z.string().uuid(),
  /** Sequential per merchant, starting at 1. What the merchant calls the batch. */
  batchNumber: z.number().int(),
  /** Inclusive serial range, as integers. */
  serialStart: z.number().int(),
  serialEnd: z.number().int(),
  /** Same range, formatted for reading: `000001 — 001000`. */
  serialRangeFormatted: z.string(),
  quantity: z.number().int(),
  status: CardBatchStatusSchema,
  note: z.string().nullable(),
  generatedByName: z.string().nullable(),
  generatedAt: z.string().datetime({ offset: true }),
  exportedAt: z.string().datetime({ offset: true }).nullable(),
  counts: CardBatchCountsSchema,
});

export type CardBatch = z.infer<typeof CardBatchSchema>;

export const CardBatchListResponseSchema = z.object({
  batches: z.array(CardBatchSchema),
  /** Blanks left across every batch — the number that decides when to reorder. */
  blanksRemaining: z.number().int(),
  /** Highest serial in use, so the next batch's start is visible before generating. */
  nextSerial: z.number().int(),
});

export type CardBatchListResponse = z.infer<typeof CardBatchListResponseSchema>;

/* ── Batch export ─────────────────────────────────────────────────────────── */

/**
 * One row of the print-ready export.
 *
 * This file necessarily contains every card number in the batch — the card printer
 * cannot print a barcode it has not been given — which makes it the one artefact of
 * this feature worth stealing, and means the printing vendor sees the whole batch.
 * Two things make that survivable: an unassigned card is worth nothing until
 * somebody physically hands it over, and a leaked batch can be voided wholesale.
 * Neither is a reason to leave the file lying about after printing.
 */
export const CardExportRowSchema = z.object({
  /** `000042` — printed large and human-readable on the card. */
  serial: z.string(),
  /** The sixteen bare digits the barcode encodes. */
  cardNumber: z.string(),
  /** `0000 4217 3920 5846` — the same digits, grouped for any human-readable line. */
  cardNumberFormatted: z.string(),
});

export type CardExportRow = z.infer<typeof CardExportRowSchema>;

/**
 * Which cards to put in the print file.
 *
 * Empty body means the whole batch, which is what a first print needs. The optional
 * range is the reprint case: a stack that jammed in the card printer, a run that came
 * out misaligned, a handful damaged in transit. Reprinting the batch to recover forty
 * cards would mean pulling every number in it out of the machine again, and the
 * export file is the one artefact of this feature worth stealing.
 *
 * **Bounding the range bounds the audit entry too.** `CARD_BATCH_EXPORTED` records
 * what was actually read, so "who has seen these numbers" stays answerable — which it
 * would not be if every reprint were logged as a full-batch export.
 *
 * Both ends are inclusive, and both are serials rather than card numbers: the serial
 * is what is printed large on the card and what a person reads off the damaged stack
 * in front of them.
 */
const ExportCardBatchRangeSchema = z
  .object({
    serialFrom: z.coerce.number().int().positive().optional(),
    serialTo: z.coerce.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.serialFrom === undefined ||
      value.serialTo === undefined ||
      value.serialFrom <= value.serialTo,
    { message: 'بداية المدى يجب أن تكون أصغر من نهايته', path: ['serialFrom'] },
  )
  .refine((value) => (value.serialFrom === undefined) === (value.serialTo === undefined), {
    // Half a range is ambiguous — "from 40" could mean to the end of the batch or a
    // typo that drops the end. Neither reading is safe on a file of card numbers.
    message: 'حدّد بداية المدى ونهايته معاً',
    path: ['serialTo'],
  });

/**
 * An absent body means the whole batch.
 *
 * `preprocess`, not `.default({})`, and the difference is the bug it fixes: a POST
 * with **no body at all** reaches the validator as `null`, and a Zod default only
 * fires on `undefined`. So the schema answered 400 to every client that had been
 * calling this endpoint correctly since before the range existed — curl, a script,
 * the packaging smoke test — while the browser, which sends `{}` with a JSON
 * content-type, sailed through.
 *
 * That is §12.20 read from the other end. There the browser broke because the tests
 * used curl; here curl breaks because the feature was built against the browser. The
 * rule is the same one: **a request shape is only supported if some real client
 * builds it that way in a test.** Both shapes are covered below this line.
 */
export const ExportCardBatchRequestSchema = z.preprocess(
  (value) => value ?? {},
  ExportCardBatchRangeSchema,
);

export type ExportCardBatchRequest = z.infer<typeof ExportCardBatchRequestSchema>;

export const CardBatchExportResponseSchema = z.object({
  batch: CardBatchSchema,
  rows: z.array(CardExportRowSchema),
  /**
   * The range this file actually covers, formatted for reading, or null for the whole
   * batch. The client names it on screen and in the filename so a reprint file and a
   * full-batch file are never mistaken for one another on disk.
   */
  exportedRangeFormatted: z.string().nullable(),
  /** Ready-to-save CSV for the card printer's variable-data import. */
  csv: z.string(),
  /** Human-readable manifest for the merchant's records — Arabic, no card numbers. */
  manifest: z.string(),
});

export type CardBatchExportResponse = z.infer<typeof CardBatchExportResponseSchema>;

/* ── Cards ────────────────────────────────────────────────────────────────── */

export const CardSchema = z.object({
  id: z.string().uuid(),
  /** Null for thermal cards, which have no physical inventory to track. */
  serial: z.number().int().nullable(),
  serialFormatted: z.string().nullable(),
  /** The sixteen digits. Never returned by a search — only by an explicit fetch. */
  cardNumber: z.string(),
  cardNumberFormatted: z.string(),
  status: CardStatusSchema,
  origin: CardOriginSchema,
  batchNumber: z.number().int().nullable(),
  customerId: z.string().uuid().nullable(),
  customerName: z.string().nullable(),
  assignedAt: z.string().datetime({ offset: true }).nullable(),
  /** Set on a REPLACED card: the serial of the card that superseded it. */
  replacedBySerial: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
});

export type Card = z.infer<typeof CardSchema>;

/**
 * Why a scanned card cannot be used, phrased for the person at the counter.
 *
 * Every state gets its **own** answer: a card replaced last week and a card never
 * issued are different conversations. The one deliberate exception is `UNKNOWN` —
 * it covers both a number this server never minted and a number whose check code
 * failed, because telling the two apart would confirm to a forger that their check
 * digits were right. That is the same oracle the key ceremony's constant-time
 * comparison refuses to be (§12.19).
 */
export const CardRejectionSchema = z.enum([
  'UNKNOWN',
  'UNASSIGNED',
  'LOST',
  'REPLACED',
  'VOID',
  /** The card is fine; the customer it belongs to has been deactivated. */
  'INACTIVE_CUSTOMER',
]);

export type CardRejection = z.infer<typeof CardRejectionSchema>;

/**
 * The little that a scan result says about the card itself.
 *
 * Deliberately not the whole `Card`: a refusal at the counter needs a serial to
 * name and a state to explain, and nothing else. In particular it never carries the
 * customer, so a found card cannot be turned into a way of learning whose it is.
 */
export const ScannedCardSchema = z.object({
  id: z.string().uuid(),
  serialFormatted: z.string().nullable(),
  status: CardStatusSchema,
  /** Set when this card was superseded — the serial that replaced it, if it has one. */
  replacedBySerial: z.string().nullable(),
});

export type ScannedCard = z.infer<typeof ScannedCardSchema>;

/* ── Assignment and lifecycle ─────────────────────────────────────────────── */

/**
 * Registering a customer onto a card that already exists.
 *
 * The operator enters name and phone, then **scans the blank card being handed
 * over** — never types its serial. Scanning is faster with a queue waiting and it
 * eliminates transcription error, which on this particular field would bind one
 * customer's details to a card in somebody else's pocket.
 */
export const AssignCardRequestSchema = z
  .object({
    /** As scanned. Grouping, dashes and Arabic-Indic digits are all normalised. */
    cardNumber: z.string().trim().min(1, 'امسح البطاقة'),
  })
  .strict();

export type AssignCardRequest = z.infer<typeof AssignCardRequestSchema>;

export const ReportCardLostRequestSchema = z
  .object({
    reason: z.string().trim().max(200).optional(),
  })
  .strict();

export type ReportCardLostRequest = z.infer<typeof ReportCardLostRequestSchema>;

/**
 * Restoring a card the customer thought they had lost.
 *
 * Audited with an actor and a reason, because it re-arms a credential that was
 * deliberately disarmed. It fails by name — not silently — when the customer has
 * since been issued a live replacement.
 */
export const RestoreCardRequestSchema = z
  .object({
    reason: z.string().trim().min(2, 'اذكر سبب الاستعادة').max(200),
  })
  .strict();

export type RestoreCardRequest = z.infer<typeof RestoreCardRequestSchema>;

/**
 * Replacing a customer's card with another physical card.
 *
 * The new card is scanned exactly as at registration. The old one moves to
 * `REPLACED` and is refused on every future scan; the customer's history and
 * balance do not move at all, because they were never on the card.
 */
export const ReplaceCardRequestSchema = z
  .object({
    cardNumber: z.string().trim().min(1, 'امسح البطاقة الجديدة'),
    reason: z.string().trim().max(200).optional(),
  })
  .strict();

export type ReplaceCardRequest = z.infer<typeof ReplaceCardRequestSchema>;

export const VoidCardRequestSchema = z
  .object({
    reason: z.string().trim().min(2, 'اذكر سبب الإتلاف').max(200),
  })
  .strict();

export type VoidCardRequest = z.infer<typeof VoidCardRequestSchema>;

/**
 * Voiding every unissued card in a batch.
 *
 * The remedy for a leaked export file, and the reason it exists as one action: a
 * merchant told "void the batch" who has to void a thousand cards one at a time
 * will not do it. Only `PRINTED` cards are affected — a card already in a
 * customer's hand is not collateral for a spill of numbers, and taking it away
 * would punish them for it.
 */
export const VoidCardBatchRequestSchema = z
  .object({
    reason: z.string().trim().min(2, 'اذكر سبب إتلاف الدفعة').max(200),
  })
  .strict();

export type VoidCardBatchRequest = z.infer<typeof VoidCardBatchRequestSchema>;

export const VoidCardBatchResponseSchema = z.object({
  batch: CardBatchSchema,
  /** How many blanks were retired. Assigned cards are deliberately untouched. */
  voided: z.number().int(),
});

export type VoidCardBatchResponse = z.infer<typeof VoidCardBatchResponseSchema>;
