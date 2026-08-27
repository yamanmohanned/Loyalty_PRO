import {
  isSyncItemSettled,
  type SyncBatchRequest,
  type SyncBatchResponse,
  type SyncItemResult,
  type SyncOperation,
} from '@walaa/shared-types';
import { AppError } from '../lib/errors';
import { createCustomer } from './customer.service';
import { redeemCoupon } from './coupon.service';
import { linkTransaction, type LinkTransactionContext } from './transaction.service';

/**
 * Offline sync reconciliation (CLAUDE.md §5, §8).
 *
 * The device is the temporary source of truth until a batch is confirmed, so two
 * properties govern this file:
 *
 *  - **Per-item isolation.** One bad operation must never poison the batch. Each
 *    item is applied independently and reports its own outcome; there is
 *    deliberately no enclosing transaction across items.
 *
 *  - **The device clears only what is settled.** APPLIED, DUPLICATE and REJECTED
 *    are all terminal — the device drops them. FAILED means "transient, try again"
 *    and stays queued. Getting this classification wrong either loses a sale or
 *    retries it forever, so `isSyncItemSettled` in shared-types is the one place
 *    it is decided, shared with the device.
 */

/**
 * Classifies a failure as permanent or transient.
 *
 * A validation error or a duplicate will fail identically forever, so retrying
 * wastes the device's battery and never succeeds — those are REJECTED/DUPLICATE.
 * An internal error might be a database blip, so it stays queued as FAILED.
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
    default:
      return 'FAILED';
  }
}

async function applyOperation(
  context: LinkTransactionContext,
  operation: SyncOperation,
): Promise<{ entityId: string | null }> {
  switch (operation.type) {
    case 'LINK_TRANSACTION': {
      // The device's own operationId doubles as the network idempotency key, so a
      // batch replayed after a dropped response returns the original outcome
      // instead of a duplicate error.
      const response = await linkTransaction(context, {
        ...operation.payload,
        idempotencyKey: operation.payload.idempotencyKey ?? operation.operationId,
      });
      return { entityId: response.transaction.id };
    }

    case 'CREATE_CUSTOMER': {
      const customer = await createCustomer(
        { merchantId: context.merchantId, actorUserId: context.userId },
        operation.payload,
      );
      return { entityId: customer.id };
    }

    case 'REDEEM_COUPON': {
      const result = await redeemCoupon({
        merchantId: context.merchantId,
        couponId: operation.payload.couponId,
        actorUserId: context.userId,
      });
      return { entityId: result.coupon.id };
    }
  }
}

export async function processSyncBatch(
  context: LinkTransactionContext,
  request: SyncBatchRequest,
): Promise<SyncBatchResponse> {
  const results: SyncItemResult[] = [];

  // Sequential, not parallel: operations from one device are causally ordered
  // (register a customer, then link their invoice), and running them concurrently
  // would let the link outrun the registration it depends on.
  for (const operation of request.operations) {
    try {
      const { entityId } = await applyOperation(
        { ...context, userId: context.userId },
        operation,
      );
      results.push({
        operationId: operation.operationId,
        status: 'APPLIED',
        errorCode: null,
        errorMessage: null,
        entityId,
      });
    } catch (error) {
      const status = classify(error);
      const appError = error instanceof AppError ? error : null;
      results.push({
        operationId: operation.operationId,
        status,
        errorCode: appError?.code ?? 'INTERNAL_ERROR',
        errorMessage: appError?.message ?? 'حدث خطأ غير متوقع',
        entityId: null,
      });
    }
  }

  return { results, serverTime: new Date().toISOString() };
}

export { isSyncItemSettled };
