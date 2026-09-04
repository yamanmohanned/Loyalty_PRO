import { z } from 'zod';
import { CardRejectionSchema, ScannedCardSchema } from './card-stock';
import { CaptureModeSchema, DiscountTypeSchema } from './enums';
import { CapturedInvoiceSchema } from './invoice';
import { IqdAmountSchema, PositiveIqdAmountSchema } from './money';
import { DiscountSlipSchema, VoucherSchema } from './voucher';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE CORE LOOP (v3) — capture, then attribute
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * v1 had one step: the assistant held the customer and the invoice together and
 * linked them. v3 splits that in two, because the receipt now prints before anyone
 * knows who is holding it:
 *
 *   1. **Ingestion** — the agent posts a captured invoice. Customer unknown.
 *   2. **Attribution** — the customer scans their card at the station; the system
 *      matches card to captured invoice, evaluates thresholds, computes the
 *      discount, and issues a voucher.
 *
 * Step 1 happens for every sale in the store. Step 2 happens only for enrolled
 * customers who scan. The gap between those two numbers is the enrolment rate, and
 * it is a headline metric rather than an error condition.
 */

/* ── Step 1: ingestion ─────────────────────────────────────────────────────── */

export const IngestInvoiceRequestSchema = z
  .object({
    invoice: CapturedInvoiceSchema,
    /** Which agent installation sent it, for capture-health reporting. */
    agentId: z.string().trim().max(128).optional(),
  })
  .strict();

export type IngestInvoiceRequest = z.infer<typeof IngestInvoiceRequestSchema>;

export const IngestInvoiceResponseSchema = z.object({
  transactionId: z.string().uuid(),
  invoiceId: z.string(),
  /** True when this capture was already on record — a retry, not a new sale. */
  duplicate: z.boolean(),
  capturedAt: z.string().datetime({ offset: true }),
});

export type IngestInvoiceResponse = z.infer<typeof IngestInvoiceResponseSchema>;

/* ── Step 2: attribution ───────────────────────────────────────────────────── */

export const ScanCardRequestSchema = z
  .object({
    /** What the keyboard-wedge scanner typed — the customer's permanent card code. */
    barcodeToken: z.string().trim().min(1, 'رمز البطاقة مطلوب').max(256),
    /**
     * A specific invoice to attribute. Normally omitted: the station takes the most
     * recent unattributed capture from this branch, which is the receipt the person
     * at the counter is holding.
     */
    invoiceId: z.string().trim().max(64).optional(),
    stationId: z.string().trim().max(128).optional(),
    idempotencyKey: z.string().uuid().optional(),
  })
  .strict();

export type ScanCardRequest = z.infer<typeof ScanCardRequestSchema>;

export const TransactionSchema = z.object({
  id: z.string().uuid(),
  customerId: z.string().uuid().nullable(),
  branchId: z.string().uuid(),
  branchCode: z.string(),
  invoiceId: z.string(),
  amountGross: PositiveIqdAmountSchema,
  discountType: DiscountTypeSchema,
  discountRate: z.number().int().min(0),
  discountValue: IqdAmountSchema,
  amountNet: IqdAmountSchema,
  currency: z.literal('IQD'),
  captureMode: CaptureModeSchema,
  occurredAt: z.string().datetime({ offset: true }),
  capturedAt: z.string().datetime({ offset: true }),
  linkedAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
});

export type Transaction = z.infer<typeof TransactionSchema>;

/* ── Two shapes for two facts (v4 §10.4) ───────────────────────────────────── */

/**
 * A customer's history. **Reporting only — never an input to a discount** (§1.4).
 *
 * v3 had one `CustomerBalance` carrying a period total *and* the gap to the next
 * threshold, because both were facts about the same thing: a customer's standing
 * inside the active window. v4 splits them, because they stopped being one fact.
 *
 * At step 1 of the station flow there is no invoice yet, so "the next bracket" and
 * the gap to it are **undefined — there is nothing to compute them against**. At the
 * result there is. One shape carrying both would mean different things depending on
 * when it was read, and a field that is null at one moment and meaningful at another
 * does not fail loudly; it stays plausible. That is §12.27 with a new surface.
 *
 * Still computed from transaction rows, never stored (§5.3). The reasoning survives
 * the model change intact: a stored aggregate drifts from the log that produced it
 * and then lies quietly. The only difference is that no calendar bounds it now.
 */
export const CustomerLifetimeSchema = z.object({
  /** Σ `amountGross` across every attributed invoice, all time. */
  totalSpend: IqdAmountSchema,
  transactionCount: z.number().int().min(0),
});

export type CustomerLifetime = z.infer<typeof CustomerLifetimeSchema>;

/**
 * Where ONE invoice landed on the ladder. **Exists only where an invoice does.**
 *
 * Every field here is a fact about a single invoice amount, so the whole object is
 * absent rather than half-null when no invoice has been named yet.
 */
export const InvoiceOutcomeSchema = z.object({
  /** The invoice total this was computed from — as the POS recorded it (§0 rule 4). */
  amountGross: PositiveIqdAmountSchema,
  /** The bracket this invoice reached, or null when it reached none. */
  bracketAmount: IqdAmountSchema.nullable(),
  /** The next bracket up. Null once the top bracket is reached. */
  nextBracketAmount: IqdAmountSchema.nullable(),
  /** What this invoice would have needed to reach it. Null with the above. */
  amountToNextBracket: IqdAmountSchema.nullable(),
  /** `3٪` or `5,000 د.ع` — what that next bracket pays. */
  nextDiscountLabel: z.string().nullable(),
});

export type InvoiceOutcome = z.infer<typeof InvoiceOutcomeSchema>;

/* ── The person behind the card ────────────────────────────────────────────── */

/**
 * The customer as the station needs them: enough to greet by name and to show the
 * operator who they are about to attribute a sale to, and nothing more.
 *
 * Declared once and shared by both station responses. The identify step and the
 * attribute step describe the same person, and two copies of that shape is exactly
 * the drift §12.27 forbids — one of them would grow a field and the other would
 * quietly go on rendering `undefined`.
 */
export const ScanCustomerSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  phone: z.string(),
  category: z.string(),
});

export type ScanCustomer = z.infer<typeof ScanCustomerSchema>;

/* ── Step 2a: identify ───────────────────────────────────────────── */

/**
 * **Identity before transaction** (CLAUDE.md §0 rule 1, §1.2).
 *
 * The station's guided flow asks for the card first and the invoice second, so it
 * needs a step that answers *who is this* while changing nothing. That is this call:
 * it reads a card, reports the person or the reason it will not, and does not
 * attribute, discount, or write anything.
 *
 * Why a separate endpoint rather than a flag on the attribute call: an endpoint that
 * sometimes commits and sometimes does not is one wrong argument away from
 * attributing a sale during what the operator believed was a lookup. The two acts
 * have different consequences and get different doors.
 */
export const IdentifyCardRequestSchema = z
  .object({
    /** What the keyboard-wedge scanner typed — the customer's permanent card code. */
    barcodeToken: z.string().trim().min(1, 'رمز البطاقة مطلوب').max(256),
  })
  .strict();

export type IdentifyCardRequest = z.infer<typeof IdentifyCardRequestSchema>;

export const IdentifyOutcomeSchema = z.enum([
  /** A live card belonging to an active customer. The flow may proceed to step 2. */
  'IDENTIFIED',
  /** Unknown number, or a real blank card — both doors lead to registration. */
  'UNKNOWN_CARD',
  /** Known and refused: lost, replaced, voided, or a deactivated account. */
  'CARD_REJECTED',
]);
export type IdentifyOutcome = z.infer<typeof IdentifyOutcomeSchema>;

/**
 * A capture waiting to be claimed at this branch.
 *
 * Shown to the operator so the invoice they are about to attribute can be checked
 * against the paper in their hand *before* it is committed. The amount is the one
 * the POS recorded; the station never computes it (§0 rule 4).
 */
export const PendingInvoiceSchema = z.object({
  invoiceId: z.string(),
  amountGross: PositiveIqdAmountSchema,
  capturedAt: z.string().datetime({ offset: true }),
});

export type PendingInvoice = z.infer<typeof PendingInvoiceSchema>;

export const IdentifyCardResponseSchema = z.object({
  outcome: IdentifyOutcomeSchema,
  /** Why the card was refused, on `UNKNOWN_CARD` and `CARD_REJECTED`; null otherwise. */
  cardRejection: CardRejectionSchema.nullable().default(null),
  /** The card that was scanned, when this server minted it. */
  scannedCard: ScannedCardSchema.nullable().default(null),
  customer: ScanCustomerSchema.nullable(),
  /** History, not progress: at step 1 there is no invoice to measure against. */
  lifetime: CustomerLifetimeSchema.nullable(),
  /**
   * The most recent unclaimed capture at this branch, if there is one.
   *
   * Offered as a checkable fallback for the receipt whose barcode will not read, or
   * the register that prints none. Naming the invoice number and the amount turns
   * "take whatever was captured last" from a blind guess into something the operator
   * compares against the paper before committing.
   */
  pendingInvoice: PendingInvoiceSchema.nullable(),
});

export type IdentifyCardResponse = z.infer<typeof IdentifyCardResponseSchema>;

/**
 * The three outcomes of a card scan (§6.2 #3). The station renders exactly one.
 *
 * `NOT_QUALIFIED` is framed as progress, never as rejection — "you are X away from
 * a discount" is a sales prompt, and telling a paying customer they failed at the
 * till is the opposite of a loyalty programme.
 */
export const ScanOutcomeSchema = z.enum([
  'QUALIFIED',
  'NOT_QUALIFIED',
  'UNKNOWN_CARD',
  'NO_PENDING_INVOICE',
  /**
   * The spend was credited but no discount was issued, because the scan reached the
   * server after the sale had already been settled — a station's offline queue
   * flushing. Distinct from NOT_QUALIFIED on purpose: the customer *did* qualify,
   * and a report that conflated the two would understate how often the network cost
   * someone their discount.
   */
  'LINKED_WITHOUT_DISCOUNT',
  /**
   * The card was recognised and cannot be used: reported lost, superseded by a
   * replacement, or voided as a misprint (§12.25). `cardRejection` says which.
   *
   * Separate from `UNKNOWN_CARD` because the two lead somewhere different. An
   * unknown or unissued card is an enrolment opportunity and the station offers
   * registration; a dead card is a conversation, and offering to register a customer
   * who already has an account would be the wrong door.
   */
  'CARD_REJECTED',
]);
export type ScanOutcome = z.infer<typeof ScanOutcomeSchema>;

export const ScanCardResponseSchema = z.object({
  outcome: ScanOutcomeSchema,
  /**
   * Why the card was refused, on `UNKNOWN_CARD` and `CARD_REJECTED`; null otherwise.
   *
   * It is carried on `UNKNOWN_CARD` too, because that outcome has two causes with
   * two different follow-ups: `UNKNOWN` is a number this server never minted, and
   * registration starts from a blank slate; `UNASSIGNED` is a real, unissued card in
   * the operator's hand, and registration should bind *that* card rather than mint a
   * fresh one and waste it.
   */
  cardRejection: CardRejectionSchema.nullable().default(null),
  /**
   * The card that was scanned, when it is one this server knows — so the station can
   * name a serial in its message and carry an unassigned card into registration.
   */
  scannedCard: ScannedCardSchema.nullable().default(null),
  customer: ScanCustomerSchema.nullable(),
  transaction: TransactionSchema.nullable(),
  lifetime: CustomerLifetimeSchema.nullable(),
  /** Present wherever an invoice was named; absent when none was. */
  invoiceOutcome: InvoiceOutcomeSchema.nullable(),
  /** Present only on QUALIFIED — the issued voucher record. */
  voucher: VoucherSchema.nullable(),
  /**
   * Present only on QUALIFIED — everything printed on the paper slip, composed
   * server-side (§6.3).
   *
   * Composed there rather than in the station because the cashier instruction comes
   * from the settlement strategy, and which strategy is active is a merchant setting
   * with accounting consequences (§9). A station that phrased its own instruction
   * would be business logic in the UI (§11), and the failure mode is a cashier told
   * to take short payment with no voucher behind it.
   */
  slip: DiscountSlipSchema.nullable(),
  /** The progress sentence shown on NOT_QUALIFIED. */
  progressMessage: z.string().nullable(),
});

export type ScanCardResponse = z.infer<typeof ScanCardResponseSchema>;

/* ── Listing ───────────────────────────────────────────────────────────────── */

export const TransactionListQuerySchema = z
  .object({
    customerId: z.string().uuid().optional(),
    branchId: z.string().uuid().optional(),
    /** `true` returns only captures no card has claimed yet. */
    unattributed: z.coerce.boolean().optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export type TransactionListQuery = z.infer<typeof TransactionListQuerySchema>;

/** Payload carried in a 409 on a duplicate capture — the record already held. */
export const DuplicateInvoiceDetailsSchema = z.object({
  existingTransaction: TransactionSchema,
  customerName: z.string().nullable(),
  capturedAt: z.string().datetime({ offset: true }),
});

export type DuplicateInvoiceDetails = z.infer<typeof DuplicateInvoiceDetailsSchema>;
