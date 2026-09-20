import { z } from 'zod';
import { CreateCustomerRequestSchema } from './customer';
import { ApiErrorCodeSchema } from './errors';
import { StorageLevelSchema } from './storage';
import { CapturedInvoiceSchema } from './invoice';
import { ScanCardRequestSchema } from './transaction';

/**
 * Offline sync (docs/legacy/CLAUDE_v3.md §7.2).
 *
 * The Station and the Agent each keep a local queue and flush it on reconnect.
 * That queue lives **on the client** — browser storage for the Station, a local
 * store for the Agent — and deliberately has no table in the manager's database
 * (§5.2). Putting it there would invert the design: the queue exists precisely for
 * the times the manager machine is unreachable.
 *
 * Two properties make the flush safe:
 *
 *  - **Per-item idempotency.** Every operation carries a client-generated
 *    `operationId`; replaying a batch cannot double-apply anything. For an agent
 *    this is what stops a network retry becoming a second recorded sale.
 *  - **Per-item results.** The server reports each item separately, so the device
 *    clears exactly what was settled and keeps the rest. A partial failure must
 *    never corrupt the queue — no work stoppage, no data loss.
 */

export const SyncOperationSchema = z.discriminatedUnion('type', [
  /** From the Print Capture Agent: a receipt it intercepted while offline. */
  z
    .object({
      type: z.literal('INGEST_INVOICE'),
      operationId: z.string().uuid(),
      queuedAt: z.string().datetime({ offset: true }),
      payload: CapturedInvoiceSchema,
    })
    .strict(),
  /** From the Loyalty Station: a card scanned while the manager was unreachable. */
  z
    .object({
      type: z.literal('SCAN_CARD'),
      operationId: z.string().uuid(),
      queuedAt: z.string().datetime({ offset: true }),
      payload: ScanCardRequestSchema,
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
      type: z.literal('REDEEM_VOUCHER'),
      operationId: z.string().uuid(),
      queuedAt: z.string().datetime({ offset: true }),
      payload: z.object({ voucherId: z.string().uuid() }).strict(),
    })
    .strict(),
]);

export type SyncOperation = z.infer<typeof SyncOperationSchema>;

export const SyncBatchRequestSchema = z
  .object({
    /** Which device is flushing — an agent id or a station id. */
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
 * has this operation, so the device should clear it. `HELD` is the same promise for a
 * sale refused because the licence is read-only: the manager PC has written the link
 * down and applies it itself on activation (packaging/LICENSING.md §10), so the device
 * may let it go. Only `FAILED` stays queued; `REJECTED` is dropped as permanently
 * invalid. Getting this classification wrong either loses a sale or retries it forever,
 * which is why it is decided in one place and shared with every client.
 */
export const SyncItemStatusSchema = z.enum(['APPLIED', 'DUPLICATE', 'HELD', 'REJECTED', 'FAILED']);
export type SyncItemStatus = z.infer<typeof SyncItemStatusSchema>;

export const SyncItemResultSchema = z.object({
  operationId: z.string().uuid(),
  status: SyncItemStatusSchema,
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

/** Connection state driving the station's status indicator. */
export const SyncStateSchema = z.enum(['ONLINE', 'SYNCING', 'OFFLINE']);
export type SyncState = z.infer<typeof SyncStateSchema>;

/** Whether a result means the device may clear the operation from its queue. */
export const isSyncItemSettled = (status: SyncItemStatus): boolean =>
  status === 'APPLIED' || status === 'DUPLICATE' || status === 'HELD' || status === 'REJECTED';

/* ── Real-time push (§7.2) ─────────────────────────────────────────────────── */

/**
 * Events the API broadcasts over WebSocket so the manager dashboard updates in
 * under a second without polling.
 */
export const RealtimeEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('INVOICE_CAPTURED'), transactionId: z.string().uuid(), invoiceId: z.string(), amountGross: z.number().int(), at: z.string() }),
  z.object({ type: z.literal('CARD_SCANNED'), transactionId: z.string().uuid(), customerId: z.string().uuid(), qualified: z.boolean(), at: z.string() }),
  z.object({ type: z.literal('VOUCHER_ISSUED'), voucherId: z.string().uuid(), value: z.number().int(), at: z.string() }),
  z.object({ type: z.literal('CUSTOMER_REGISTERED'), customerId: z.string().uuid(), at: z.string() }),
  z.object({ type: z.literal('AGENT_STATUS'), agentId: z.string(), online: z.boolean(), captureMode: z.string(), at: z.string() }),
  /**
   * Free space on the manager machine crossed a threshold (§12.15).
   *
   * Pushed on a CHANGE of verdict, never on every reading — a sampler that broadcast
   * once a minute would be a heartbeat nobody reads, and the point of this event is
   * that its arrival means something. A client that connects after the change learns
   * the current state from `GET /system/storage` instead; the two together are what
   * make the banner correct for a dashboard opened at any moment.
   */
  z.object({
    type: z.literal('STORAGE_LEVEL_CHANGED'),
    level: StorageLevelSchema,
    previousLevel: StorageLevelSchema,
    freeBytes: z.number().int().nonnegative().nullable(),
    path: z.string(),
    at: z.string(),
  }),
]);

export type RealtimeEvent = z.infer<typeof RealtimeEventSchema>;
