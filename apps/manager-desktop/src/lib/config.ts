import { invoke } from '@tauri-apps/api/core';
import { load, type Store } from '@tauri-apps/plugin-store';
import { DEMO_API_FALLBACK_PORT, IS_DEMO } from './demo';
import { locale } from './locale';
import { APP_VERSION } from './version';

/**
 * Where the dashboard's backend is, and who is allowed to be asked about it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  V5 — the manager machine resolves its own backend, with zero configuration
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * **The defect this closes is a question, not a crash.** The manager PC runs the API:
 * the installer put it there, registered it with the Service Control Manager and fixed
 * its port. The dashboard nevertheless opened on a first-run screen asking the shop
 * owner to type a server address, and kept a «تغيير الخادم» button under the login
 * form for the rest of the product's life. Neither could tell him anything the machine
 * did not already know — and a control that offers to change something working is how
 * a merchant talks himself into believing the software is broken. He changes it,
 * nothing connects, and now it really is broken.
 *
 * So there are two distinct situations and they are no longer conflated:
 *
 *   **This machine hosts the backend** (the overwhelming case — the manager PC).
 *   Nothing is configured, nothing is asked. The shell reports the port the service is
 *   actually listening on and the address is derived from it.
 *
 *   **This machine points at another one** (a second manager PC, or a workstation
 *   beside the till). An address is configured — once, deliberately, in Settings, never
 *   on the way in. `testApiUrl` below still guards that path with its four distinct
 *   failures and the version check.
 *
 * ── How the port is known without asking ─────────────────────────────────────
 *
 * It is in `walaa.env`, which is locked to SYSTEM and Administrators because it also
 * holds the JWT signing keys — the logged-on user cannot read it and should not be able
 * to. The service, which runs as SYSTEM, publishes the port alone into `status.json` in
 * the log directory, which the logged-on user *can* read. `backend_port` in the shell
 * reads it back. A port is not a secret: the firewall rule beside it announces the same
 * number to the whole shop LAN.
 *
 * `null` from that command means genuinely unknown, never a guess. A wrong port
 * produces a confident "the server is not responding" screen, which is worse than an
 * honest "I could not determine it".
 */

const STORE_FILE = 'app_config.json';

/**
 * The address of a backend on ANOTHER machine.
 *
 * Absent on the manager PC, which is the normal case. The key name is unchanged from
 * when it meant "the server address": an existing install that already has one keeps
 * working, and it keeps working for the right reason — a value in here now means
 * exactly what it used to mean, "do not use the local backend, use this".
 */
const REMOTE_URL_KEY = 'api_url';

let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
  storePromise ??= load(STORE_FILE, { autoSave: true });
  return storePromise;
}

/** True when running inside Tauri rather than a plain browser dev server. */
export const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * The port this machine's own backend is serving on, or null if it has none.
 *
 * Resolved once per process: the port is fixed for the lifetime of the service, and
 * re-reading it on every request would only create opportunities for two callers to
 * disagree about it.
 *
 * It used to be the literal 4000 — a number this product does not own. Anything else on
 * the merchant's PC can already be holding it (on the machine this was built on,
 * something is), and the result was an app that could never work, with no way for the
 * merchant to change it and nothing on screen explaining why.
 */
let localPortPromise: Promise<number | null> | null = null;

async function localBackendPort(): Promise<number | null> {
  localPortPromise ??= (async () => {
    if (!isTauri()) return IS_DEMO ? DEMO_API_FALLBACK_PORT : null;
    try {
      return await invoke<number | null>('backend_port');
    } catch {
      // The shell could not answer. Saying "unknown" is honest; inventing a port here
      // would be the same defect this module exists to remove.
      return null;
    }
  })();
  return localPortPromise;
}

/** The address of the backend this machine hosts, or null if it hosts none. */
export async function getLocalApiUrl(): Promise<string | null> {
  const port = await localBackendPort();
  return port ? `http://127.0.0.1:${port}` : null;
}

/**
 * The configured address of a backend on another machine, or null when there is none.
 *
 * Read by Settings, which is the only surface that may present it.
 */
export async function getRemoteApiUrl(): Promise<string | null> {
  if (IS_DEMO) return null;
  if (!isTauri()) return window.localStorage.getItem(REMOTE_URL_KEY);
  const store = await getStore();
  return (await store.get<string>(REMOTE_URL_KEY)) ?? null;
}

/**
 * The address the app will actually talk to.
 *
 * A configured remote wins, because configuring one is a deliberate statement that the
 * local backend is not the one wanted. Otherwise the local service, resolved from the
 * shell. `null` only when this machine hosts nothing and nothing has been configured —
 * a state a correctly installed manager PC is never in, and which Settings explains
 * rather than the login screen demanding it be fixed.
 */
export async function getApiUrl(): Promise<string | null> {
  /*
    A demo build talks to the bundled service and to nothing else. Loopback only,
    whatever the port: a demo that can be pointed at a shop's live server is a demo
    that can write to it.
  */
  if (IS_DEMO) return getLocalApiUrl();

  // Outside Tauri (browser dev), there is no shell to ask and no service to find, so
  // the stored value is the only source. This is the branch the dev server runs on.
  if (!isTauri()) return window.localStorage.getItem(REMOTE_URL_KEY);

  return (await getRemoteApiUrl()) ?? (await getLocalApiUrl());
}

/**
 * Points this app at a backend on another machine.
 *
 * Reachable only from Settings. Refused outright in a demo build — not hidden at the
 * caller, refused here, so the guarantee holds at the function rather than depending on
 * every surface remembering it.
 */
export async function setRemoteApiUrl(url: string): Promise<void> {
  if (IS_DEMO) return;

  const normalized = url.trim().replace(/\/+$/, '');
  if (!isTauri()) {
    window.localStorage.setItem(REMOTE_URL_KEY, normalized);
    return;
  }
  const store = await getStore();
  await store.set(REMOTE_URL_KEY, normalized);
  await store.save();
}

/**
 * Returns the app to using the backend this machine hosts.
 *
 * The undo for `setRemoteApiUrl`, and the reason that control is safe to offer: a
 * merchant who points the app at the wrong machine can put it back without knowing an
 * address, because the address it returns to is one the machine works out for itself.
 */
export async function clearRemoteApiUrl(): Promise<void> {
  if (!isTauri()) {
    window.localStorage.removeItem(REMOTE_URL_KEY);
    return;
  }
  const store = await getStore();
  await store.delete(REMOTE_URL_KEY);
  await store.save();
}

/**
 * Confirms a URL actually answers, and answers as the right thing, before it is saved.
 *
 * ── Four failures, four sentences ────────────────────────────────────────────
 *
 * This used to collapse two genuinely different problems into one message. "Nothing is
 * listening here" and "something is listening but it is not ولاء" both produced
 * «تعذّر الوصول إلى الخادم — تحقّق من العنوان والشبكة», and they need opposite next
 * moves: the first means start the service or fix the port, the second means the
 * address belongs to something else entirely. A third case did not exist at all — a
 * ولاء server at a version this dashboard cannot talk to answered `service: walaa-api`
 * and was accepted, and the failure surfaced later as unexplained empty screens.
 *
 * Checking reachability at the moment the address is entered is the difference between
 * a merchant seeing a precise reason once, in Settings, with the address in front of
 * him — and seeing an unexplained blank dashboard every day after.
 */
export async function testApiUrl(url: string): Promise<{ ok: boolean; message: string }> {
  const base = url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/.+/.test(base)) {
    return { ok: false, message: locale.setup.errors.malformed };
  }

  let response: Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    response = await fetch(`${base}/health`, { signal: controller.signal });
    clearTimeout(timeout);
  } catch {
    // The fetch itself never completed: nothing is listening, the host is down, DNS
    // failed, or a firewall dropped it. All of them mean "there is no server there".
    return { ok: false, message: locale.setup.errors.unreachable };
  }

  // Something answered. From here on the address is occupied, and every remaining
  // failure is about WHAT answered — a distinction the old single message erased.
  let body: { service?: string; version?: string; demo?: boolean };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return { ok: false, message: locale.setup.errors.notWalaa };
  }

  if (!response.ok || body.service !== 'walaa-api') {
    return { ok: false, message: locale.setup.errors.notWalaa };
  }

  /*
    A demo backend holds a fabricated shop. A real dashboard pointed at one would show
    a merchant six months of trading that never happened, and it would look entirely
    convincing — which is exactly why this is refused out loud rather than tolerated.
  */
  if (body.demo === true) {
    return { ok: false, message: locale.setup.errors.demoServer };
  }

  /*
    Compared on the major.minor pair, not the full string. A patch release is not
    allowed to lock a shop out of its own data over a version digit, and the wire
    contract does not change within one. `undefined` is treated as a mismatch: a
    server old enough not to report a version is old enough to be incompatible.
  */
  if (majorMinor(body.version) !== majorMinor(APP_VERSION)) {
    return { ok: false, message: locale.setup.errors.versionMismatch };
  }

  return { ok: true, message: locale.setup.connected };
}

const majorMinor = (version: string | undefined): string =>
  version ? version.split('.').slice(0, 2).join('.') : '';
