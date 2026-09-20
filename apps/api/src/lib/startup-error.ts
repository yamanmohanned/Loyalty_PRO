import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDataDir } from '../config/paths';

/**
 * Records WHY the process could not start, somewhere a live process can read it.
 *
 * ── The defect this exists to close ──────────────────────────────────────────
 *
 * The API already produced a precise, actionable Arabic sentence when it refused to
 * start — naming the cause and the remedy. It went to stderr, into `api.log`, inside a
 * directory locked to SYSTEM. Meanwhile the dashboard, which cannot reach a dead API to
 * ask it anything, showed «تحقّق من الاتصال بالخادم». The message existed and the
 * person who needed it could not get to it.
 *
 * ── Why this lives in its own module ─────────────────────────────────────────
 *
 * It used to be a function inside `server.ts`, wired up as `main().catch(...)`. That
 * covers every failure inside `main` and misses an entire class in front of it:
 * **configuration is resolved at module scope**, by this module's own imports and by
 * `jwt.ts` and others, so a bad or missing `loyalty-pro.env` throws while the module graph is
 * still being evaluated — before `main` is ever called, and before any `.catch` is
 * attached.
 *
 * That is not hypothetical. A demo install whose environment file had not been written
 * died exactly there, and the supervisor could only report `exit code: 1` because the
 * one function that would have written the real sentence had not been reached. The
 * merchant would have seen a failure with no cause, which is the whole problem this
 * mechanism was built to solve, reappearing one layer earlier.
 *
 * So the recorder is a module with nothing heavy behind it — `node:fs`, `node:path` and
 * the path resolver, none of which read configuration — and `server.ts` imports only
 * this before pulling the rest of the application in dynamically. Anything that throws
 * during that load is caught and written down like any other startup failure.
 */

const FILENAME = 'startup-error.json';

const logsDir = (): string => join(resolveDataDir(), 'logs');

/**
 * Best-effort by construction: this runs while the process is already failing, so a
 * second failure here must not replace a real error with a confusing one.
 */
export function recordStartupFailure(error: unknown): void {
  try {
    const logs = logsDir();
    mkdirSync(logs, { recursive: true });

    // The message only — not the stack. This string is rendered to a shop owner, and
    // every one of these is written in Arabic for exactly that reader.
    const reason = error instanceof Error ? error.message : String(error);

    writeFileSync(
      join(logs, FILENAME),
      // A BOM, for the same reason the service host writes one: PowerShell 5.1 and
      // Notepad read a BOM-less UTF-8 file as ANSI and turn the Arabic into mojibake.
      `\uFEFF${JSON.stringify({ at: new Date().toISOString(), reason }, null, 2)}\n`,
      'utf8',
    );
  } catch {
    /* Already failing. Nothing here is worth masking the real error for. */
  }
}

/** Clears a previous failure once the process is genuinely serving. */
export function clearStartupFailure(): void {
  try {
    rmSync(join(logsDir(), FILENAME), { force: true });
  } catch {
    /* A stale file is a cosmetic problem; refusing to serve over it is not. */
  }
}
