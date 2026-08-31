import { z } from 'zod';
import { CardRejectionSchema, ScannedCardSchema } from './card-stock';
import { CaptureModeSchema, DiscountTypeSchema } from './enums';
import { CapturedInvoiceSchema } from './invoice';
import { IqdAmountSchema, PositiveIqdAmountSchema } from './money';
import { PeriodKeySchema } from './period';
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
  periodKey: PeriodKeySchema,
  occurredAt: z.string().datetime({ offset: true }),
  capturedAt: z.string().datetime({ offset: true }),
  linkedAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
});

export type Transaction = z.infer<typeof TransactionSchema>;

/**
 * A customer's standing within the active period.
 *
 * **Always computed from transaction rows, never read from a stored total**
 * (§5.3). v1's `balance_snapshot` cache is gone: a stored aggregate drifts from the
 * log that produced it and then lies quietly. There is no cache to reconcile
 * because there is no cache.
 */
export const CustomerBalanceSchema = z.object({
  periodKey: PeriodKeySchema,
  cumulativeAmount: IqdAmountSchema,
  transactionCount: z.number().int().min(0),
  nextThresholdAmount: IqdAmountSchema.nullable(),
  amountToNextThreshold: IqdAmountSchema.nullable(),
  nextDiscountLabel: z.string().nullable(),
});

export type CustomerBalance = z.infer<typeof CustomerBalanceSchema>;

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
  customer: z
    .object({
      id: z.string().uuid(),
      name: z.string(),
      phone: z.string(),
      category: z.string(),
    })
    .nullable(),
  transaction: TransactionSchema.nullable(),
  balance: CustomerBalanceSchema.nullable(),
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
