import { getAccessToken } from './api';
import { getStoredApiUrl } from './config';
import { flush, setLinkUp } from './queue';

/**
 * The station's persistent connection to the manager machine (CLAUDE_v3.md §7.2).
 *
 * The station is mostly a *producer* of events rather than a consumer — the dashboard
 * is what needs live updates. So the socket earns its place here for a different
 * reason: it is the only honest answer to "is the manager machine reachable right
 * now?".
 *
 * `navigator.onLine` cannot answer that. It reports whether the OS believes it has a
 * network, which on a shop's wifi stays true while the manager PC is asleep, rebooting,
 * or on the wrong side of a router that has started isolating clients. An open socket
 * is evidence; anything else is a guess, and the operator makes decisions from that
 * indicator — "did that scan go through?" is answered by scanning again if they do not
 * trust it.
 *
 * Reconnection backs off, and every successful reconnect flushes the queue: coming
 * back online is exactly the moment the queued scans should go.
 */

const INITIAL_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

let socket: WebSocket | null = null;
/** True once the server has greeted this connection — see the message handler. */
let linkConfirmed = false;
let delay = INITIAL_DELAY_MS;
let timer: number | null = null;
let stopped = false;

function websocketUrl(): string | null {
  const base = getStoredApiUrl();
  const token = getAccessToken();
  if (!base || !token) return null;

  // The token travels as a query parameter because browsers cannot set headers on a
  // WebSocket handshake — the tradeoff the API documents (§12.9): short-lived token,
  // LAN-internal traffic.
  const url = new URL(base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/realtime';
  url.searchParams.set('token', token);
  return url.toString();
}

function scheduleReconnect(): void {
  if (stopped || timer !== null) return;

  timer = window.setTimeout(() => {
    timer = null;
    connect();
  }, delay);

  delay = Math.min(delay * 2, MAX_DELAY_MS);
}

function connect(): void {
  if (stopped || socket) return;

  const url = websocketUrl();
  if (!url) {
    // No session yet. Try again rather than giving up: the operator may be mid-login.
    scheduleReconnect();
    return;
  }

  let next: WebSocket;
  try {
    next = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }
  socket = next;

  // Deliberately NOT on 'open'. The server accepts the upgrade first and validates
  // the token after, closing with 4401 if it fails — so an open socket proves a TCP
  // path exists, not that this station is talking to an API that knows it. The
  // server's greeting is the first thing that only an authenticated connection sees.
  next.addEventListener('message', (event) => {
    if (linkConfirmed) return;
    try {
      const payload = JSON.parse(String(event.data)) as { type?: string };
      if (payload.type !== 'CONNECTED') return;
    } catch {
      return;
    }

    linkConfirmed = true;
    delay = INITIAL_DELAY_MS;
    setLinkUp(true);
    // Reconnection is precisely when anything queued should be sent.
    void flush();
  });

  const dropped = (): void => {
    if (socket === next) socket = null;
    linkConfirmed = false;
    setLinkUp(false);
    scheduleReconnect();
  };

  next.addEventListener('close', dropped);
  next.addEventListener('error', dropped);
}

/** Opens the connection and keeps it open. Returns a stop function. */
export function startRealtime(): () => void {
  stopped = false;
  delay = INITIAL_DELAY_MS;
  connect();

  return () => {
    stopped = true;
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    socket?.close();
    socket = null;
    linkConfirmed = false;
  };
}
