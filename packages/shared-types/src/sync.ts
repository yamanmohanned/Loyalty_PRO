import { z } from 'zod';
import { CreateCustomerRequestSchema } from './customer';
import { LinkTransactionRequestSchema } from './transaction';
import { ApiErrorCodeSchema } from './errors';

/**
 * Offline sync (CLAUDE.md §5, §8).
 *
 * The assistant app writes locally first and is the temporary source of truth until
 * a batch is confirmed. Two properties make that safe:
 *
 *  - **Per-item idempotency.** Every operation carries a client-generated
 *    `operationId`; replaying a batch cannot double-apply anything.
 *  - **Per-item results.** The server reports each item separately so the device
 *    clears exactly the confirmed operations and keeps the rest queued. A partial
 *    failure must never corrupt the queue.
 */

export const SyncOperationSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('LINK_TRANSACTION'),
      operationId: z.string().uuid(),
      /** When the device recorded it — preserved so offline links keep their real time. */
      queuedAt: z.string().datetime({ offset: true }),
      payload: LinkTransactionRequestSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('CREATE_CUSTOMER'),
      operationId: z.string().uuid(),
      queuedAt: z.string().datetime({ offset: true }),
      payload: CreateCustomerRequestSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('REDEEM_COUPON'),
      operationId: z.string().uuid(),
      queuedAt: z.string().datetime({ offset: true }),
      payload: z.object({ couponId: z.string().uuid() }).strict(),
    })
    .strict(),
]);

export type SyncOperation = z.infer<typeof SyncOperationSchema>;

export const SyncBatchRequestSchema = z
  .object({
    deviceId: z.string().trim().min(1).max(128),
    /** Bounded so one device cannot hold a connection open with an unbounded batch. */
    operations: z.array(SyncOperationSchema).min(1).max(100),
  })
  .strict();

export type SyncBatchRequest = z.infer<typeof SyncBatchRequestSchema>;

/**
 * Outcome of one queued operation.
 *
 * `DUPLICATE` is a **success** from the device's point of view: the server already
 * has this operation, so the device should clear it. Only `FAILED` items stay queued,
 * and only `REJECTED` items are dropped as permanently invalid.
 */
export const SyncItemStatusSchema = z.enum(['APPLIED', 'DUPLICATE', 'REJECTED', 'FAILED']);
export type SyncItemStatus = z.infer<typeof SyncItemStatusSchema>;

export const SyncItemResultSchema = z.object({
  operationId: z.string().uuid(),
  status: SyncItemStatusSchema,
  /** Populated for REJECTED/FAILED so the device can show why. */
  errorCode: ApiErrorCodeSchema.nullable(),
  errorMessage: z.string().nullable(),
  /** The server-assigned entity id when the operation created something. */
  entityId: z.string().uuid().nullable(),
});

export type SyncItemResult = z.infer<typeof SyncItemResultSchema>;

export const SyncBatchResponseSchema = z.object({
  results: z.array(SyncItemResultSchema),
  /** Server clock, so a device with a skewed clock can correct its display. */
  serverTime: z.string().datetime({ offset: true }),
});

export type SyncBatchResponse = z.infer<typeof SyncBatchResponseSchema>;

/** Device-side connection state driving the sync indicators (CLAUDE.md §6.7 #3). */
export const SyncStateSchema = z.enum(['ONLINE', 'SYNCING', 'OFFLINE']);
export type SyncState = z.infer<typeof SyncStateSchema>;

/** Whether a result means the device may clear the operation from its queue. */
export const isSyncItemSettled = (status: SyncItemStatus): boolean =>
  status === 'APPLIED' || status === 'DUPLICATE' || status === 'REJECTED';
