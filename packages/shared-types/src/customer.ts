import { z } from 'zod';
import { CustomerCategorySchema } from './enums';
import { PhoneInputSchema } from './phone';

/** Customer DTOs. Phone is the identifier; nothing sensitive is stored (CLAUDE.md §0.4). */

export const CustomerSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  /** Always E.164 on the way out. */
  phone: z.string(),
  category: CustomerCategorySchema,
  /**
   * The permanent code printed on the customer's loyalty card. Opaque and signed —
   * never PII, never derived from the phone number. A reprint reissues THIS code:
   * a new one would sever the customer from their own history (§6.2 #5).
   */
  barcodeToken: z.string(),
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
    sort: z.enum(['createdAt', 'cumulativeAmount', 'name']).default('createdAt'),
    order: z.enum(['asc', 'desc']).default('desc'),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export type CustomerListQuery = z.infer<typeof CustomerListQuerySchema>;
