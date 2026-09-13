/**
 * Asking this process to restart itself, cleanly.
 *
 * A restore is applied at boot, before anything opens the database — the only moment
 * the live file is certainly not held open (Windows will not rename an open file, and
 * swapping a database under a live connection is how a shop loses a day). So applying
 * one means ending this process and starting a new one.
 *
 * Under the Windows service host that is an exit with `RESTART_EXIT_CODE`: the host
 * starts the API again at once, without counting it as a failure or backing off
 * (`packaging/service-host/src/main.rs`, which carries the same number). Nothing else
 * restarts a process, so `canRestart()` is false outside the host and the caller says
 * the restore will be applied at the next start instead of promising a restart.
 */
export const RESTART_EXIT_CODE = 75;

type RestartListener = (reason: string) => void;

let listener: RestartListener | null = null;

/** Registered by `main.ts`, which owns the graceful shutdown. */
export function onRestartRequested(fn: RestartListener): void {
  listener = fn;
}

/** True when a restart will actually happen: a shutdown to run, and a host to start us again. */
export function canRestart(): boolean {
  return listener !== null && process.env.WALAA_SUPERVISED === '1';
}

/**
 * Schedules the restart after `delayMs`, so the HTTP response that asked for it is sent
 * first. Returns false when there is nobody to carry it out.
 */
export function requestRestart(reason: string, delayMs = 400): boolean {
  if (!listener) return false;
  const fire = listener;
  setTimeout(() => fire(reason), delayMs);
  return true;
}
