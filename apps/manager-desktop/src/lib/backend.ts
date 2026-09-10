import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './config';
import { APP_VERSION } from './version';

/**
 * What the backend says about itself, read from disk by the shell process.
 *
 * ── Why this exists at all ───────────────────────────────────────────────────
 *
 * When the API refuses to start it writes a precise Arabic sentence saying why and
 * what to do. When it is not running, nothing can ask it anything — so the dashboard
 * fell back to «تعذّر تحميل البيانات. تحقّق من الاتصال بالخادم وأعد المحاولة.», which
 * describes a pulled network cable and almost never described what was wrong. The
 * correct message existed on disk the whole time and no surface could reach it.
 *
 * The shell process is alive precisely because the API is not, so it is the one
 * channel that does not depend on the failed component. It reads the two status files
 * and hands them over through a narrow command — not an `fs` capability, which would
 * mean granting a webview the filesystem in order to read two known paths.
 */

export type BackendState =
  | 'starting'
  | 'running'
  | 'failed'
  | 'terminal'
  | 'stopped'
  | 'unknown';

export interface BackendStatus {
  state: BackendState;
  /** The API's own explanation, verbatim and already in Arabic. */
  reason: string | null;
  attempts: number;
  at: string | null;
  /** The files consulted, named even when empty. */
  checked: string[];
  port: number | null;
  demo: boolean;

  /* ── What this MACHINE has, as distinct from what the service is doing ─────

     Reported by the shell (`src-tauri/src/status.rs`) because the frontend was
     inferring it from a missing port and inferring it wrongly. A manager PC whose
     `walaa.env` had gone answered `backend_port → null`, which the dashboard read as
     "no address configured" and answered with «لم يُعثر على خادم ولاء» and a box
     asking the shop owner to type a server address — on the machine that IS the
     server, for a fault no address could fix. */

  /** `walaa-service.exe` is installed here. False only on a second machine. */
  hostsService: boolean;
  /** `walaa.env` is present. Its absence is its own failure with its own remedy. */
  configPresent: boolean;
  /** A database for this build exists in the data directory. */
  databasePresent: boolean;
}

const UNKNOWN: BackendStatus = {
  state: 'unknown',
  reason: null,
  attempts: 0,
  at: null,
  checked: [],
  port: null,
  demo: false,
  /*
    Outside Tauri there is no shell to ask, so nothing about the installation is
    established. `false` here means "not known to host a service", which routes to the
    screen that OFFERS an address field — the safe direction: a browser pointed at a
    dev server genuinely does need one, and withholding it there would leave no way in.
  */
  hostsService: false,
  configPresent: false,
  databasePresent: false,
};

export async function readBackendStatus(): Promise<BackendStatus> {
  if (!isTauri()) return UNKNOWN;
  try {
    return await invoke<BackendStatus>('backend_status');
  } catch {
    // The shell could not answer either. Saying "unknown" is honest; inventing a
    // cause here would be the same defect this module exists to remove.
    return UNKNOWN;
  }
}

/**
 * The port the bundled backend was told to use, for a demo build.
 *
 * Null in a production build, where the port is fixed at install time and the app is
 * pointed at a configured address instead.
 */
export async function readBackendPort(): Promise<number | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<number | null>('backend_port');
  } catch {
    return null;
  }
}

/**
 * What is at an address, in the four ways it can fail to be this product.
 *
 * ── Why a boolean was not enough ─────────────────────────────────────────────
 *
 * `isBackendHealthy` returned true or false, and `BackendGate` therefore had exactly
 * two states to render: healthy, or a screen that guessed. "Nothing is listening",
 * "something is listening and it is not ولاء" and "a ولاء at a version this build
 * cannot talk to" are three different problems with three different next moves, and
 * they were one sentence.
 *
 * The distinctions already existed — `testApiUrl` in `lib/config.ts` has drawn them
 * since V5 — but only on the Settings path, at the moment somebody types an address.
 * A machine that had one saved met the guess instead. Same four answers, now on both.
 */
export type ProbeResult =
  | { ok: true }
  | { ok: false; why: 'unreachable' | 'not-walaa' | 'version' };

export async function probeBackend(base: string, timeoutMs = 2500): Promise<ProbeResult> {
  let response: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    response = await fetch(`${base}/health`, { signal: controller.signal });
    clearTimeout(timer);
  } catch {
    // The request never completed: nothing listening, host down, firewall, DNS.
    return { ok: false, why: 'unreachable' };
  }

  let body: { service?: string; version?: string };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // Something answered and it was not JSON — a router's login page, a proxy error.
    return { ok: false, why: 'not-walaa' };
  }

  if (!response.ok || body.service !== 'walaa-api') return { ok: false, why: 'not-walaa' };

  /*
    Major.minor only, matching `testApiUrl` deliberately: a patch release must not lock
    a shop out of its own data over a version digit. `undefined` counts as a mismatch —
    a server too old to report a version is too old to talk to.
  */
  const pair = (v: string | undefined): string => (v ? v.split('.').slice(0, 2).join('.') : '');
  if (pair(body.version) !== pair(APP_VERSION)) return { ok: false, why: 'version' };

  return { ok: true };
}

/**
 * Whether the API is actually serving — not whether we launched something.
 *
 * Kept as the thin boolean for callers that only need one bit.
 */
export async function isBackendHealthy(base: string, timeoutMs = 2500): Promise<boolean> {
  return (await probeBackend(base, timeoutMs)).ok;
}
