import { z } from 'zod';
import { CustomerCategorySchema } from './enums';
import { IqdAmountSchema } from './money';
import { PhoneInputSchema } from './phone';
import { PeriodKeySchema } from './period';

/** Customer DTOs. Phone is the identifier; nothing sensitive is stored (CLAUDE.md §0.4). */

export const CustomerSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  /** Always E.164 on the way out. */
  phone: z.string(),
  category: CustomerCategorySchema,
  /**
   * The signed, opaque token encoded in the customer's QR. Never contains PII
   * (CLAUDE.md §3.6, §7.9) — it resolves to a customer server-side and nowhere else.
   */
  qrToken: z.string(),
  createdAt: z.string().datetime({ offset: true }),
});

export type Customer = z.infer<typeof CustomerSchema>;

export const CreateCustomerRequestSchema = z
  .object({
    name: z.string().trim().min(2, 'الاسم مطلوب').max(120),
    phone: PhoneInputSchema,
    category: CustomerCategorySchema.default('REGULAR'),
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

/** A customer's standing within the *current* loyalty period. */
export const CustomerBalanceSchema = z.object({
  periodKey: PeriodKeySchema,
  /** Cumulative spend this period, derived from transactions — never hand-edited. */
  cumulativeAmount: IqdAmountSchema,
  /** The next tier's threshold, or null when every tier is already earned. */
  nextThresholdAmount: IqdAmountSchema.nullable(),
  /** How much more to spend to reach it. Null when there is no next tier. */
  amountToNextThreshold: IqdAmountSchema.nullable(),
  /** The discount waiting at that next threshold. */
  nextDiscountPct: z.number().int().nullable(),
});

export type CustomerBalance = z.infer<typeof CustomerBalanceSchema>;

/** Sorting for the dashboard list. Deliberately no `name` search (see above). */
export const CustomerListQuerySchema = z
  .object({
    /** Matches a phone number prefix, never a name. */
    phone: z.string().trim().max(32).optional(),
    category: CustomerCategorySchema.optional(),
    sort: z.enum(['createdAt', 'cumulativeAmount', 'name']).default('createdAt'),
    order: z.enum(['asc', 'desc']).default('desc'),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export type CustomerListQuery = z.infer<typeof CustomerListQuerySchema>;
