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
 */

const QUEUE_KEY = 'walaa.station.queue';
const DEVICE_KEY = 'walaa.station.device';
/** Matches the server's per-batch cap. */
const MAX_BATCH = 100;

type Listener = (snapshot: QueueSnapshot) => void;

export interface QueueSnapshot {
  state: SyncState;
  pending: number;
}

let listeners: Listener[] = [];
let flushing = false;
let lastFailed = false;
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
  return { state: currentState(), pending: pendingCount() };
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

/** Adds an operation and tries to flush immediately. */
export function enqueue(operation: SyncOperation): void {
  write([...read(), operation]);
  void flush();
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

  try {
    const batch = queued.slice(0, MAX_BATCH);
    const response = await api.post<SyncBatchResponse>('/sync/batch', {
      deviceId: deviceId(),
      operations: batch,
    });

    const settled = new Set(
      response.results
        .filter((result) => isSyncItemSettled(result.status))
        .map((r) => r.operationId),
    );
    write(read().filter((operation) => !settled.has(operation.operationId)));
    lastFailed = false;
  } catch (error) {
    // Only a network failure means "still offline". A rejected batch is a bug worth
    // surfacing, but the operations stay queued either way — nothing is dropped here
    // that the server did not explicitly settle.
    lastFailed = error instanceof ApiRequestError ? error.isNetworkFailure : true;
  } finally {
    flushing = false;
    notify();
  }
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
