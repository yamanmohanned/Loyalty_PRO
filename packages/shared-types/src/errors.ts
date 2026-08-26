import { z } from 'zod';

/**
 * One error envelope for the whole API (CLAUDE.md §9). Every non-2xx response is
 * this shape — clients branch on `code`, never on a parsed message string.
 */

export const ApiErrorCodeSchema = z.enum([
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'TOKEN_EXPIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  /** The idempotency guard fired: this invoice is already linked (CLAUDE.md §0.2). */
  'DUPLICATE_INVOICE',
  /** A coupon was redeemed twice, or redeemed while EXPIRED/USED/SUPERSEDED. */
  'COUPON_NOT_REDEEMABLE',
  /** An invoice arrived without a resolved customer — the loop order was violated. */
  'CUSTOMER_REQUIRED',
  'CUSTOMER_ALREADY_EXISTS',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
]);

export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    /** Arabic, safe to show a user. Never contains secrets, tokens or SQL. */
    message: z.string(),
    /** Field-level detail for VALIDATION_FAILED. */
    fields: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
    /** Correlates a client report with a server log line. */
    requestId: z.string().optional(),
    /**
     * For DUPLICATE_INVOICE: the transaction that already owns this invoice, so the
     * assistant can show *who* it was linked to instead of a bare failure.
     */
    // Shape depends on `code` — e.g. DuplicateInvoiceDetails for DUPLICATE_INVOICE.
    // Callers narrow it with the matching DTO schema rather than trusting it raw.
    details: z.unknown().optional(),
  }),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;

/** Maps an error code to the HTTP status the API returns for it. */
export const ERROR_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  DUPLICATE_INVOICE: 409,
  COUPON_NOT_REDEEMABLE: 409,
  CUSTOMER_REQUIRED: 422,
  CUSTOMER_ALREADY_EXISTS: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};
