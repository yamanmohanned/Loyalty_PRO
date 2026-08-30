import type { RealtimeEvent } from '@walaa/shared-types';
import { getAccessToken } from './api';
import { getApiUrl } from './config';

/**
 * The dashboard's persistent connection to the API service (CLAUDE_v3.md §7.2).
 *
 * §7.2 asks for a manager dashboard that updates in under a second with no manual
 * refresh. The Station's socket exists mostly to answer "is the manager machine
 * reachable"; this one is the consumer side — the events it receives are facts the
 * screens are already showing, arriving before the next poll would have found them.
 *
 * Deliberately a plain subscriber registry rather than anything React-aware. A module
 * that imported hooks would be reconnecting on every render of whatever mounted it, and
 * the socket has to outlive individual screens: the free-space banner lives in the shell
 * and must keep hearing while the manager moves between routes.
 *
 * Reconnection backs off to thirty seconds. A dashboard that has lost the service has
 * nothing useful to do but wait, and hammering a machine that may be mid-reboot is how a
 * client turns a blip into a queue of half-open sockets.
 */

const INITIAL_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

type Handler = (event: RealtimeEvent) => void;
type ConnectHandler = () => void;

const handlers = new Set<Handler>();
const connectHandlers = new Set<ConnectHandler>();

let socket: WebSocket | null = null;
let delay = INITIAL_DELAY_MS;
let timer: number | null = null;
let stopped = true;

/**
 * Which run of the client an in-flight connection belongs to.
 *
 * Resolving the server address is asynchronous — it lives in the Tauri store — so there
 * is a gap between deciding to connect and holding a socket, and a stop that lands in
 * that gap has nothing to close yet.
 *
 * That gap opened a real leak, found by watching the API log rather than by reading the
 * code: React's StrictMode mounts, unmounts and remounts the shell in development, and
 * the API showed **two** `/realtime` upgrades. The first connection completed after its
 * own stop had already run, assigned itself to `socket`, and was then overwritten by the
 * second — leaving an authenticated socket open with nothing referencing it, delivering
 * every event twice.
 *
 * Bumping this on every start and stop lets a connection that finishes after its run has
 * ended recognise that and close itself.
 */
let generation = 0;
/** The generation a connection attempt is already in flight for, or -1. */
let connectingFor = -1;

/**
 * Registers a listener. Returns the unsubscribe function.
 *
 * Subscribing does not open the socket — `startRealtime` does, once, from the shell. A
 * component that opened it would close it again on unmount and take every other
 * listener's connection with it.
 */
export function onRealtimeEvent(handler: Handler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

/**
 * Registers a listener for "the connection is up again". Returns the unsubscribe.
 *
 * The counterpart to `onRealtimeEvent`, and not a nicety: everything that arrives on
 * this socket arrives exactly once, so a screen that was disconnected while something
 * changed has no way to learn of it from the socket itself. Reconnection is the moment
 * to re-read. The Station flushes its queue on the same signal, for the mirror-image
 * reason.
 */
export function onRealtimeConnect(handler: ConnectHandler): () => void {
  connectHandlers.add(handler);
  return () => {
    connectHandlers.delete(handler);
  };
}

async function websocketUrl(): Promise<string | null> {
  const base = await getApiUrl();
  const token = getAccessToken();
  if (!base || !token) return null;

  // The token travels as a query parameter because browsers cannot set headers on a
  // WebSocket handshake — the tradeoff the API documents: short-lived token, LAN-internal
  // traffic (§7.1, §12.9).
  const url = new URL(base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/realtime';
  url.searchParams.set('token', token);
  return url.toString();
}

function scheduleReconnect(): void {
  if (stopped || timer !== null) return;

  const gen = generation;
  timer = window.setTimeout(() => {
    timer = null;
    void connect(gen);
  }, delay);

  delay = Math.min(delay * 2, MAX_DELAY_MS);
}

async function connect(gen: number): Promise<void> {
  if (stopped || socket || gen !== generation || connectingFor === gen) return;
  connectingFor = gen;

  let next: WebSocket;
  try {
    const url = await websocketUrl();
    if (stopped || gen !== generation || socket) return;
    if (!url) {
      // No session yet — the shell mounts before the access token has necessarily been
      // stored on a refresh. Retry rather than give up.
      scheduleReconnect();
      return;
    }
    next = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  } finally {
    // Left alone when the generation has moved on: that value belongs to a run that is
    // over, and clearing it would say something about the current one.
    if (connectingFor === gen) connectingFor = -1;
  }

  // The socket opened for a run that has since ended. Close it here or it stays open,
  // authenticated and unreferenced, for as long as the server tolerates it.
  if (stopped || gen !== generation) {
    next.close();
    return;
  }
  socket = next;

  next.addEventListener('message', (event) => {
    let payload: RealtimeEvent | { type?: string };
    try {
      payload = JSON.parse(String(event.data)) as RealtimeEvent;
    } catch {
      return;
    }

    // The server's greeting, not a domain event. Reaching it is the proof the token was
    // accepted — the upgrade itself is not, because the API accepts the socket first and
    // closes it with 4401 afterwards if the token fails.
    if (payload.type === 'CONNECTED') {
      delay = INITIAL_DELAY_MS;
      for (const handler of connectHandlers) {
        try {
          handler();
        } catch {
          // As below: one listener's failure is not the socket's problem.
        }
      }
      return;
    }

    for (const handler of handlers) {
      try {
        handler(payload as RealtimeEvent);
      } catch {
        // One listener's failure must not deny the event to the others. A screen that
        // mishandles an event is a rendering bug, not a reason to stop the socket.
      }
    }
  });

  const dropped = (): void => {
    if (socket === next) socket = null;
    scheduleReconnect();
  };

  next.addEventListener('close', dropped);
  next.addEventListener('error', dropped);
}

/** Opens the connection and keeps it open. Returns a stop function. */
export function startRealtime(): () => void {
  generation += 1;
  stopped = false;
  delay = INITIAL_DELAY_MS;
  void connect(generation);

  return () => {
    generation += 1;
    stopped = true;
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    socket?.close();
    socket = null;
  };
}
