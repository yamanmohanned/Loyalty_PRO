import type { RealtimeEvent } from '@walaa/shared-types';

/**
 * Real-time broadcast (CLAUDE_v3.md §7.2).
 *
 * The Station and Agent hold persistent WebSocket connections; the manager
 * dashboard updates in under a second with no polling. This module owns the
 * subscriber registry so services can publish without knowing about sockets — a
 * service that imported Fastify's websocket types would be much harder to test.
 *
 * Subscribers are keyed by merchant so a future multi-merchant deployment cannot
 * leak one store's activity into another's dashboard.
 */

export type RealtimeSubscriber = (event: RealtimeEvent) => void;

const subscribers = new Map<string, Set<RealtimeSubscriber>>();

/** Registers a subscriber. Returns the unsubscribe function. */
export function subscribe(merchantId: string, subscriber: RealtimeSubscriber): () => void {
  const set = subscribers.get(merchantId) ?? new Set<RealtimeSubscriber>();
  set.add(subscriber);
  subscribers.set(merchantId, set);

  return () => {
    const current = subscribers.get(merchantId);
    if (!current) return;
    current.delete(subscriber);
    if (current.size === 0) subscribers.delete(merchantId);
  };
}

/**
 * Publishes to every subscriber of a merchant.
 *
 * **Never throws.** A broken socket must not fail the sale that triggered the
 * event: the transaction is already committed, and a dashboard that missed an
 * update will catch up on its next read. Losing a notification is a cosmetic
 * problem; losing the sale is not.
 */
export function publish(merchantId: string, event: RealtimeEvent): void {
  const set = subscribers.get(merchantId);
  if (!set) return;

  for (const subscriber of set) {
    try {
      subscriber(event);
    } catch {
      // A dead socket is removed by its own close handler; swallow here so one
      // bad subscriber cannot deny the event to the others.
    }
  }
}

/** Live subscriber count, for the connection-health panel. */
export const subscriberCount = (merchantId: string): number =>
  subscribers.get(merchantId)?.size ?? 0;

/** Clears every subscriber. Used between tests so state cannot leak across cases. */
export function resetSubscribers(): void {
  subscribers.clear();
}
