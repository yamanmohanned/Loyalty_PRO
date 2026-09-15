import {
  isSyncItemSettled,
  type SyncBatchResponse,
  type SyncOperation,
  type SyncState,
} from '@walaa/shared-types';
import { api, ApiRequestError } from './api';

/**
 * The station's offline queue (CLAUDE_v3.md §7.2).
 *
 * "No work stoppage, no data loss": a scan taken while the manager machine is
 * unreachable is written here and flushed when it comes back. The queue lives on the
 * client by design — it exists precisely for the times the server cannot be reached,
 * so a table on the server would be no use at all (§5.2).
 *
 * **What the operator is told matters as much as the queue itself.** A queued scan
 * credits the customer's spend but issues no discount, because the sale will have
 * been settled in cash by the time it replays and a voucher with no printed slip is
 * an accounting discrepancy (§0 rule 3). The station says so plainly rather than
 * implying a slip is coming.
 *
 * `localStorage`, not memory: a tablet that is restarted, or a browser that reloads,
 * must not lose sales that were taken while the network was down.
 *
 * ## What deliberately does NOT belong in this queue
 *
 * **Only a request that never reached the server is queued** — `isNetworkFailure`,
 * status 0. A write the server *answered* and did not store (a 5xx; see
 * `ApiRequestError.isUnsavedWrite`) is shown to the operator as a failure and
 * dropped, and that is not an oversight waiting to be tidied up (§12.16).
 *
 * The two situations look similar and are opposites. A network failure is benign:
 * the manager machine is unreachable, the operation settles when it returns, and
 * queueing tells the truth. A 5xx means the machine is reachable and its datastore
 * cannot accept writes — a full disk being the case this was written for. Queueing
 * that would retry against a server that will keep refusing, hide the failure behind
 * a sync indicator that looks like ordinary catching-up, and let every following
 * sale go unrecorded while the one person able to raise the alarm is told it is all
 * in hand. The failure has to reach a human, and the operator at the till is the
 * only human present.
 *
 * If you are here because "failed scans should be retried", that is the feature this
 * comment exists to refuse.
 */

const QUEUE_KEY = 'walaa.station.queue';
const DEVICE_KEY = 'walaa.station.device';
/** Matches the server's per-batch cap. */
const MAX_BATCH = 100;
/**
 * The most this station holds while the manager PC's licence is read-only.
 *
 * By then the shop has been read-only for days — at a few hundred linked sales a day,
 * about a week — and holding more helps nobody: it is a person's problem (activate, or
 * phone the provider for an emergency code), and the cashier is told so. The cap also
 * keeps the queue far from the browser's storage limit (2,000 items is about 430,000
 * characters), which a queue must never reach: a write refused there loses the sale
 * being written.
 */
export const HELD_CAP = 2000;

/** Raised when the manager PC refuses a sale for the licence, so the read-only strip re-checks at once. */
export const LICENSE_REFUSED_EVENT = 'walaa:license-refused';

type Listener = (snapshot: QueueSnapshot) => void;

export interface QueueSnapshot {
  state: SyncState;
  pending: number;
  /**
   * What waits for the manager PC's licence: every queued item, once its last answer
   * refused anything for the licence — it is reachable, so nothing here waits for the
   * network. Kept, never dropped, sent on every flush, credited once the program is
   * activated (or at once if it happened while licensed). Counted apart so the pill
   * says why they wait rather than implying the network is down.
   */
  held: number;
}

let listeners: Listener[] = [];
let flushing = false;
let lastFailed = false;
/** Operation ids the server has answered with LICENSE_READ_ONLY and not yet settled. */
let heldIds = new Set<string>();
/** Whether the server's latest answer refused anything for the licence. */
let readOnlyAnswer = false;
/**
 * Whether the persistent socket is open (see `realtime.ts`).
 *
 * `null` before the first connection attempt settles, so a station that has just
 * started does not claim to be offline before it has tried.
 */
let linkUp: boolean | null = null;

/** Called by the realtime connection as it opens and drops. */
export function setLinkUp(up: boolean): void {
  linkUp = up;
  notify();
}

/** A stable id for this station, so the server can attribute a flush to a device. */
export function deviceId(): string {
  let id = window.localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = `station-${crypto.randomUUID().slice(0, 8)}`;
    window.localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

function read(): SyncOperation[] {
  try {
    const raw = window.localStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as SyncOperation[]) : [];
  } catch {
    // A corrupt queue must not brick the station. Losing an unsynced scan is bad;
    // a station that will not start is worse, and the operator can rescan.
    window.localStorage.removeItem(QUEUE_KEY);
    return [];
  }
}

function write(operations: SyncOperation[]): void {
  window.localStorage.setItem(QUEUE_KEY, JSON.stringify(operations));
  notify();
}

export function pendingCount(): number {
  return read().length;
}

function currentState(): SyncState {
  if (flushing) return 'SYNCING';
  // The socket is the strongest signal available: it says the manager machine is
  // reachable, where `navigator.onLine` only says the OS has *a* network — which
  // stays true while the manager PC is asleep or behind an isolating router.
  if (linkUp === false) return 'OFFLINE';
  if (!navigator.onLine || lastFailed) return 'OFFLINE';
  return 'ONLINE';
}

export function snapshot(): QueueSnapshot {
  const queued = read();
  return {
    state: currentState(),
    pending: queued.length,
    held: readOnlyAnswer ? queued.length : 0,
  };
}

function notify(): void {
  const value = snapshot();
  for (const listener of listeners) listener(value);
}

export function subscribe(listener: Listener): () => void {
  listeners.push(listener);
  listener(snapshot());
  return () => {
    listeners = listeners.filter((entry) => entry !== listener);
  };
}

/**
 * Adds an operation and tries to flush immediately.
 *
 * Returns false when it could not be kept — a link refused for the licence while this
 * station already holds `HELD_CAP`, or a browser that refused the write — so the caller
 * tells the operator the truth instead of implying the sale is saved.
 */
export function enqueue(operation: SyncOperation, options: { forLicence?: boolean } = {}): boolean {
  const queued = read();
  if (options.forLicence && queued.length >= HELD_CAP) return false;
  try {
    write([...queued, operation]);
  } catch {
    return false;
  }
  void flush();
  return true;
}

/**
 * Sends what is queued, then clears exactly what the server settled.
 *
 * Per-item results are the whole point: a partial failure must leave the rest of the
 * queue intact rather than replaying settled work or dropping unsettled work.
 * `DUPLICATE` counts as settled — the server already has it, so keeping it queued
 * would retry forever.
 */
export async function flush(): Promise<void> {
  if (flushing) return;

  const queued = read();
  if (queued.length === 0) {
    lastFailed = false;
    notify();
    return;
  }

  flushing = true;
  notify();
  let drainAgain = false;

  try {
    // Held items last: a sale that can be credited now must not wait behind a hundred
    // the licence is holding.
    const batch = [
      ...queued.filter((operation) => !heldIds.has(operation.operationId)),
      ...queued.filter((operation) => heldIds.has(operation.operationId)),
    ].slice(0, MAX_BATCH);
    const response = await api.post<SyncBatchResponse>('/sync/batch', {
      deviceId: deviceId(),
      operations: batch,
    });

    const settled = new Set(
      response.results
        .filter((result) => isSyncItemSettled(result.status))
        .map((r) => r.operationId),
    );
    // Refused for the licence and NOT held on the manager PC — only those wait here.
    const refused = response.results
      .filter((result) => result.errorCode === 'LICENSE_READ_ONLY' && !isSyncItemSettled(result.status))
      .map((r) => r.operationId);
    heldIds = new Set([...[...heldIds].filter((id) => !settled.has(id)), ...refused]);
    readOnlyAnswer = refused.length > 0;
    const remaining = read().filter((operation) => !settled.has(operation.operationId));
    write(remaining);
    lastFailed = false;
    // Once the program is activated, two thousand held sales drain in one go rather
    // than a hundred every thirty seconds.
    drainAgain = settled.size > 0 && remaining.length > 0;
  } catch (error) {
    // Only a network failure means "still offline". A rejected batch is a bug worth
    // surfacing, but the operations stay queued either way — nothing is dropped here
    // that the server did not explicitly settle.
    lastFailed = error instanceof ApiRequestError ? error.isNetworkFailure : true;
  } finally {
    flushing = false;
    notify();
  }
  if (drainAgain) void flush();
}

/**
 * Starts flushing on reconnection and on a slow timer.
 *
 * The timer matters more than the event: `online` fires when the OS thinks there is
 * a network, which on a shop's wifi is not the same as the manager machine being
 * reachable. Polling every half minute recovers from the cases the event misses,
 * without being a load on anything.
 */
export function startQueue(): () => void {
  const onOnline = (): void => {
    void flush();
  };
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', notify);

  const timer = window.setInterval(() => {
    if (pendingCount() > 0) void flush();
  }, 30_000);

  void flush();

  return () => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', notify);
    window.clearInterval(timer);
  };
}
