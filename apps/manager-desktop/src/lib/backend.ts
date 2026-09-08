import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './config';

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
}

const UNKNOWN: BackendStatus = {
  state: 'unknown',
  reason: null,
  attempts: 0,
  at: null,
  checked: [],
  port: null,
  demo: false,
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
 * Whether the API is actually serving — not whether we launched something.
 *
 * The distinction is the whole point of health-gating: a process that has been spawned
 * and a process that is answering requests are different claims, and the merchant only
 * cares about the second.
 */
export async function isBackendHealthy(base: string, timeoutMs = 2500): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`${base}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return false;
    const body = (await response.json()) as { service?: string };
    return body.service === 'walaa-api';
  } catch {
    return false;
  }
}
