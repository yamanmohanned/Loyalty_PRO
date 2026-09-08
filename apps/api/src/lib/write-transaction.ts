import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma } from '@prisma/client';
import { isBusyError, prisma } from './prisma';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ONE WRITER, AND A QUEUE IN FRONT OF IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ## The failure this closes, measured
 *
 * `POST /scan/card` — the core loop, the thing a customer is standing at a till waiting
 * for — was driven with N simultaneous requests, each attributing a **different**
 * invoice, so no two were competing for the same row:
 *
 * | simultaneous scans | succeeded | 500 INTERNAL_ERROR | wall time |
 * |-------------------:|----------:|-------------------:|----------:|
 * |                  8 |         8 |                  0 |    208 ms |
 * |                 16 |         7 |                  9 |   5,743 ms |
 * |                 32 |         2 |                 30 |  16,759 ms |
 * |                 64 |         0 |                 64 |  28,015 ms |
 *
 * Every one of those 500s is a sale that was not attributed and a discount a customer
 * did not receive, answered with «حدث خطأ غير متوقع».
 *
 * ## What it was, and what it was not
 *
 * It was **not** SQLite's busy timeout. `PRAGMA busy_timeout` was probed across 64
 * parallel queries and every connection reported 5000, so `applySqlitePragmas` reaches
 * every write path for that setting. It was not lock contention on a row either — the
 * invoices were all different.
 *
 * It was Prisma's own interactive-transaction machinery, and the log says so exactly:
 *
 *     52 × Transaction API error: Unable to start a transaction in the given time.
 *     15 × Transaction API error: Transaction already closed … timeout … was 5000 ms
 *      9 × Transaction API error: Transaction not found.
 *
 * `prisma.$transaction(fn)` defaults to `maxWait` 2 s and `timeout` 5 s. SQLite admits
 * one writer, so concurrent interactive transactions queue behind each other inside
 * Prisma — and the ones at the back of the queue burn their own budget waiting and are
 * killed before they ever run. The load that produces this is not exotic: §7.2's offline
 * queue exists so that devices flush a backlog the moment the network returns, and
 * `ingest.routes.ts` says so in as many words.
 *
 * ## Why a queue rather than bigger timeouts
 *
 * Raising the limits moves the cliff; it does not remove it, because the shape of the
 * problem is a thundering herd against a resource that admits one participant.
 * Serialising in this process turns the herd into a line: each transaction starts the
 * instant its turn comes, so neither `maxWait` nor `timeout` is ever approached, and the
 * work per transaction is unchanged. §12.5 already establishes the API as the sole
 * writer — this makes the process behave like the single writer it is.
 *
 * **Reads are untouched.** Only transactions pass through here, so dashboards, lookups
 * and `/identify` keep running in parallel; that is the whole point of WAL.
 *
 * ## The three properties that make it safe
 *
 * **Re-entrant.** A `writeTransaction` reached from inside another joins the outer one
 * with its existing client rather than queueing behind a transaction it is itself
 * holding, which would deadlock. Tracked with `AsyncLocalStorage` so it is exact rather
 * than a guess about call sites.
 *
 * **Retry is bounded and only on contention.** The retried errors are the ones where the
 * transaction provably did not commit — it could not start, or it was closed and rolled
 * back — so re-running the callback cannot double-apply anything. A business failure, a
 * unique violation or a validation error is never retried; it is thrown at once.
 *
 * **A failure never poisons the queue.** The chain advances on rejection as well as on
 * fulfilment, so one bad transaction cannot stop the till.
 */

/**
 * How long a single write transaction may hold the writer.
 *
 * Generous against Prisma's 5 s default because the queue means this is now a ceiling on
 * one transaction's own work rather than a budget shared with everything waiting behind
 * it. The longest transaction here does five statements; the value exists so a stalled
 * disk fails loudly instead of hanging the queue for ever.
 */
export const WRITE_TRANSACTION_TIMEOUT_MS = 15_000;

/**
 * How long Prisma may wait for a connection before starting.
 *
 * Only reached if the pool is exhausted by concurrent *reads*, since writes are already
 * serialised by the time they get here.
 */
export const WRITE_TRANSACTION_MAX_WAIT_MS = 10_000;

/** Attempts, including the first. Four covers a transient collision without hiding a real fault. */
const MAX_ATTEMPTS = 4;

/** Base backoff. Multiplied by the attempt number and jittered, so retries fan out. */
const BACKOFF_BASE_MS = 25;

const active = new AsyncLocalStorage<Prisma.TransactionClient>();

/** The tail of the queue. Never rejects — see the note about poisoning above. */
let tail: Promise<void> = Promise.resolve();

/**
 * Errors meaning "this transaction did not happen, try again".
 *
 * Matched on Prisma's codes first and on message text second. The text fallback is not
 * ideal and is deliberate: `P2028` covers the interactive-transaction errors in current
 * Prisma, but the three messages observed under load are the contract that actually
 * matters here, and a future client version that renumbered them must not silently turn
 * this retry off.
 */
export function isContentionError(error: unknown): boolean {
  if (isBusyError(error)) return true;

  const code = (error as { code?: unknown } | null)?.code;
  // P2028 — transaction API error. P2034 — write conflict / deadlock.
  if (code === 'P2028' || code === 'P2034') return true;

  const message = error instanceof Error ? error.message : '';
  return (
    message.includes('Unable to start a transaction') ||
    message.includes('Transaction already closed') ||
    message.includes('Transaction not found') ||
    message.includes('Transaction API error')
  );
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Runs `body` in a write transaction, one at a time across this process.
 *
 * Use this for every write that spans more than one statement. A single statement is
 * already atomic in SQLite and does not need it.
 */
export async function writeTransaction<T>(
  body: (db: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const outer = active.getStore();
  if (outer) return body(outer);

  const run = async (): Promise<T> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await prisma.$transaction(
          (db) => active.run(db, () => body(db)),
          { timeout: WRITE_TRANSACTION_TIMEOUT_MS, maxWait: WRITE_TRANSACTION_MAX_WAIT_MS },
        );
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS || !isContentionError(error)) throw error;
        await delay(BACKOFF_BASE_MS * attempt * (1 + Math.random()));
      }
    }
  };

  const task = tail.then(run, run);
  tail = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}
