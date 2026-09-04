import { z } from 'zod';
import { CardOriginSchema, CustomerCategorySchema } from './enums';
import { PhoneInputSchema } from './phone';

/** Customer DTOs. Phone is the identifier; nothing sensitive is stored (CLAUDE.md §0.4). */

export const CustomerSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  /** Always E.164 on the way out. */
  phone: z.string(),
  category: CustomerCategorySchema,
  /**
   * The number on the card this customer currently holds, or null when they hold
   * none — between reporting one lost and being issued a replacement.
   *
   * **Null is not an error state.** The card is a credential, not the identity: the
   * customer, their balance and their history all exist perfectly well without one
   * (§12.25). A reprint reissues THIS number; a replacement mints a different one
   * and retires this card (§6.2 #5).
   */
  cardNumber: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
});

export type Customer = z.infer<typeof CustomerSchema>;

/**
 * Registration takes **name and phone only** (§6.2 #4). Category is optional and
 * defaults to REGULAR — the station never asks for it. Every additional field at
 * the counter costs enrolment, and enrolment is the whole programme.
 */
export const CreateCustomerRequestSchema = z
  .object({
    name: z.string().trim().min(2, 'الاسم مطلوب').max(120),
    phone: PhoneInputSchema,
    category: CustomerCategorySchema.default('REGULAR'),
    /**
     * The blank pre-printed card being handed over, exactly as scanned (§12.25).
     *
     * Scanned, never typed: transcription error on this field would bind one
     * customer's details to a card in somebody else's pocket, and it is faster with
     * a queue waiting besides.
     *
     * Omitted when no blank is to hand, and the Station prints a thermal card
     * instead — the fallback that keeps a customer from being turned away because
     * the stock drawer is empty (§6.3).
     */
    cardNumber: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export type CreateCustomerRequest = z.infer<typeof CreateCustomerRequestSchema>;

export const UpdateCustomerRequestSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    phone: PhoneInputSchema.optional(),
    category: CustomerCategorySchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'لا يوجد أي تغيير' });

export type UpdateCustomerRequest = z.infer<typeof UpdateCustomerRequestSchema>;

/**
 * How the assistant identifies a customer at the register (CLAUDE.md §1.4).
 * A QR token or a phone number — both unique. Name search is forbidden: it is not
 * unique and it is too slow with a queue waiting.
 */
export const ResolveCustomerQuerySchema = z
  .object({
    identifier: z.string().trim().min(1, 'المعرّف مطلوب').max(256),
  })
  .strict();

export type ResolveCustomerQuery = z.infer<typeof ResolveCustomerQuerySchema>;

/** Sorting for the dashboard list. Deliberately no `name` search (see above). */
export const CustomerListQuerySchema = z
  .object({
    /** Matches a phone number prefix, never a name. */
    phone: z.string().trim().max(32).optional(),
    category: CustomerCategorySchema.optional(),
    sort: z.enum(['createdAt', 'lifetimeSpend', 'name']).default('createdAt'),
    order: z.enum(['asc', 'desc']).default('desc'),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export type CustomerListQuery = z.infer<typeof CustomerListQuerySchema>;

/* ── Reprint lookup (§6.2 #5) ──────────────────────────────────────────────── */

/**
 * Finding a customer who has lost their card.
 *
 * One field takes all three identifiers: a card number (16 digits), a phone number,
 * or a name. The station operator should not have to classify the input before
 * typing it — the shapes are distinguishable, so the server classifies it.
 *
 * **On name search.** CLAUDE.md §1.4 forbids name lookup as an *identification*
 * method, and that ban stands where it was aimed: the scan hot path, where a queue
 * is waiting and only a unique identifier will do. §6.2 #5 asks for it here, in the
 * reprint flow, and this is a different problem — the customer is standing at the
 * counter without the card that would identify them, and the alternative to a name
 * search is turning them away. It returns masked phone numbers and a short list, so
 * it disambiguates without becoming a way to read out the shop's customer list.
 */
export const CustomerSearchQuerySchema = z
  .object({
    query: z.string().trim().min(2, 'أدخل حرفين على الأقل').max(120),
  })
  .strict();

export type CustomerSearchQuery = z.infer<typeof CustomerSearchQuerySchema>;

export const CustomerSearchMatchSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  /** `0770 ••• 4567` — enough to confirm with the person, not enough to harvest. */
  phoneMasked: z.string(),
  createdAt: z.string().datetime({ offset: true }),
});

export type CustomerSearchMatch = z.infer<typeof CustomerSearchMatchSchema>;

export const CustomerSearchResponseSchema = z.object({
  matches: z.array(CustomerSearchMatchSchema),
  /** True when more customers matched than were returned — narrow the search. */
  truncated: z.boolean(),
});

export type CustomerSearchResponse = z.infer<typeof CustomerSearchResponseSchema>;

/**
 * What the station needs to reprint a card.
 *
 * A separate call from the search on purpose: a name search returns a list without
 * card numbers in it, and the number is fetched one customer at a time, after the
 * operator has confirmed which person is in front of them.
 */
export const CustomerCardSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  phone: z.string(),
  /** `0770 123 4567` — the form printed on the card and read back by a person. */
  phoneLocal: z.string(),
  /** The 16 digits, bare, for the barcode. */
  cardNumber: z.string(),
  /** `4821 0093 7746 1152` — the same digits, grouped for printing and reading. */
  cardNumberFormatted: z.string(),
  /**
   * `000042` for a pre-printed card, null for one printed on thermal paper.
   *
   * Shown beside the number so an operator holding the physical card can confirm
   * they have the right one before reprinting anything.
   */
  serialFormatted: z.string().nullable(),
  /** PRE_PRINTED | THERMAL — decides whether a reprint produces paper or plastic. */
  origin: CardOriginSchema,
  createdAt: z.string().datetime({ offset: true }),
});

export type CustomerCard = z.infer<typeof CustomerCardSchema>;

/* ── The dashboard list (§12.26) ──────────────────────────────────────────── */

/**
 * One row of the customer list.
 *
 * `lifetimeSpend` is Σ `amountGross` across every attributed invoice, all time. It is
 * derived from transactions and never stored (§5.3) — which is also why sorting by it
 * cannot be an ORDER BY.
 *
 * **It is history, not eligibility.** Under v4 nothing about this number affects what
 * a customer is offered at the till; the discount comes from the invoice in front of
 * them (§1.4). The name says `lifetime` precisely so no future reader mistakes it for
 * a balance that buys something.
 */
export interface CustomerListRow {
  id: string;
  name: string;
  phone: string;
  category: string;
  cardNumber: string | null;
  lifetimeSpend: number;
  transactionCount: number;
  createdAt: string;
}

export interface CustomerListResponse {
  customers: CustomerListRow[];
  total: number;
  page: number;
  pageSize: number;
}
