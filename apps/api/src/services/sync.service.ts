import {
  isSyncItemSettled,
  type SyncBatchRequest,
  type SyncBatchResponse,
  type SyncItemResult,
  type SyncOperation,
} from '@walaa/shared-types';
import { AppError, UNEXPECTED_FAILURE_MESSAGE } from '../lib/errors';
import { createCustomer } from './customer.service';
import { ingestInvoice, type IngestionContext } from './ingestion.service';
import { scanCard, type ScanContext } from './scan.service';
import { redeemVoucher } from './voucher.service';

/**
 * Offline sync reconciliation (CLAUDE_v3.md §7.2).
 *
 * The Station and the Agent are the source of truth for their own queues until a
 * batch is confirmed. Two properties keep that safe:
 *
 *  - **Per-item isolation.** One bad operation must never poison the batch, so
 *    each is applied independently with its own outcome. There is deliberately no
 *    enclosing transaction across items — a validation failure on item three must
 *    not roll back the two sales that already succeeded.
 *  - **The device clears only what is settled.** APPLIED, DUPLICATE and REJECTED
 *    are terminal; FAILED stays queued. Getting that classification wrong either
 *    loses a sale or retries it forever, which is why it is decided in one shared
 *    place rather than per client.
 */

export interface SyncContext {
  merchantId: string;
  userId: string;
  branchId: string | null;
  deviceId: string;
}

/**
 * Classifies a failure as permanent or transient.
 *
 * A validation error or a missing customer fails identically forever, so retrying
 * only drains the device's battery — those are REJECTED. An internal error might
 * be a momentary database lock, so it stays queued as FAILED.
 */
function classify(error: unknown): SyncItemResult['status'] {
  if (!(error instanceof AppError)) return 'FAILED';
  switch (error.code) {
    case 'DUPLICATE_INVOICE':
      return 'DUPLICATE';
    case 'VALIDATION_FAILED':
    case 'NOT_FOUND':
    case 'FORBIDDEN':
    case 'CUSTOMER_REQUIRED':
    case 'CUSTOMER_ALREADY_EXISTS':
    case 'COUPON_NOT_REDEEMABLE':
      return 'REJECTED';
    // Not settled: the Station keeps the item queued and sends it again. It reaches
    // here only if the sale happened while the shop was NOT licensed and it still is
    // not — a sale made while licensed is accepted by when it happened. A read-only
    // licence must never cost the merchant a sale; at worst it defers one.
    case 'LICENSE_READ_ONLY':
      // Kept on this PC and applied on activation (scan.service.ts, `holdForActivation`):
      // the till may let it go. A hold that could not be written stays queued there.
      return (error.details as { held?: boolean } | undefined)?.held ? 'HELD' : 'FAILED';
    default:
      return 'FAILED';
  }
}

async function applyOperation(
  context: SyncContext,
  operation: SyncOperation,
): Promise<{ entityId: string | null; status: SyncItemResult['status'] }> {
  // When the device recorded it. The licence judges a queued sale by this, not by when
  // it arrives: a sale made while the shop was licensed is accepted whenever the till
  // reconnects (license.service.ts, `assertCanRecord`).
  const occurredAt = new Date(operation.queuedAt);
  switch (operation.type) {
    case 'INGEST_INVOICE': {
      const ingestionContext: IngestionContext = {
        merchantId: context.merchantId,
        userId: context.userId,
        userBranchId: context.branchId,
        agentId: context.deviceId,
      };
      // The operationId doubles as the network idempotency key, so a batch
      // replayed after a dropped response cannot become a second recorded sale.
      const result = await ingestInvoice(ingestionContext, {
        ...operation.payload,
        idempotency_key: operation.payload.idempotency_key ?? operation.operationId,
      });
      // Ingestion answers a duplicate with a flag rather than an error, so map it
      // here — the device still needs to know it may clear the item.
      return {
        entityId: result.transactionId,
        status: result.duplicate ? 'DUPLICATE' : 'APPLIED',
      };
    }

    case 'SCAN_CARD': {
      const scanContext: ScanContext = {
        merchantId: context.merchantId,
        userId: context.userId,
        branchId: context.branchId,
        stationId: operation.payload.stationId ?? context.deviceId,
      };
      // No discount on a replayed scan: the customer has already paid and left, so a
      // voucher issued now would be one the drawer cannot produce at closing time.
      // The spend is still credited — see ScanOptions.issueDiscount.
      const response = await scanCard(scanContext, operation.payload, { issueDiscount: false, occurredAt });
      return { entityId: response.transaction?.id ?? null, status: 'APPLIED' };
    }

    case 'CREATE_CUSTOMER': {
      const customer = await createCustomer(
        { merchantId: context.merchantId, actorUserId: context.userId },
        operation.payload,
        { occurredAt },
      );
      return { entityId: customer.id, status: 'APPLIED' };
    }

    case 'REDEEM_VOUCHER': {
      const result = await redeemVoucher({
        merchantId: context.merchantId,
        voucherId: operation.payload.voucherId,
        actorUserId: context.userId,
        occurredAt,
      });
      return { entityId: result.voucher.id, status: 'APPLIED' };
    }
  }
}

export async function processSyncBatch(
  context: SyncContext,
  request: SyncBatchRequest,
): Promise<SyncBatchResponse> {
  const results: SyncItemResult[] = [];

  // Sequential, not parallel: operations from one device are causally ordered — a
  // customer is registered before their card is scanned — and running them
  // concurrently would let the scan outrun the registration it depends on.
  for (const operation of request.operations) {
    try {
      const { entityId, status } = await applyOperation(context, operation);
      results.push({
        operationId: operation.operationId,
        status,
        errorCode: null,
        errorMessage: null,
        entityId,
      });
    } catch (error) {
      const appError = error instanceof AppError ? error : null;
      results.push({
        operationId: operation.operationId,
        status: classify(error),
        errorCode: appError?.code ?? 'INTERNAL_ERROR',
        errorMessage: appError?.message ?? UNEXPECTED_FAILURE_MESSAGE,
        entityId: null,
      });
    }
  }

  return { results, serverTime: new Date().toISOString() };
}

export { isSyncItemSettled };
