import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { API_VERSION } from '../config/version';
import { resolveRuntimeStatePath } from '../config/paths';
import { prisma as defaultClient } from './prisma';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  IS THE FILE SOUND? — MEASURED, THEN DECIDED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * SQLite offers three checks with very different costs, and the honest way to choose
 * between them is to time them on a database the size a shop will actually have.
 * Measured on this machine (NVMe, warm cache), three passes each, page size 4096:
 *
 * | database | `quick_check` | `integrity_check` | `foreign_key_check` |
 * |---------:|--------------:|------------------:|--------------------:|
 * |   5.4 MB |     13–15 ms  |         44–60 ms  |            6–7 ms   |
 * |   111 MB |   222–232 ms  |       656–702 ms  |            6–9 ms   |
 * |   533 MB | 1081–1254 ms  |     4768–5270 ms  |            6–8 ms   |
 *
 * Both page checks scale linearly with page count, and `integrity_check` is roughly
 * four times `quick_check` because it additionally verifies that every index entry
 * matches its row.
 *
 * **The decision.** `quick_check` and `foreign_key_check` run on every boot; the full
 * `integrity_check` runs only when it is earned. Five seconds added to every service
 * start on a large database is five seconds the shop cannot open, paid daily, to
 * re-answer a question that was answered the same way yesterday. One second is not.
 *
 * A full check is earned by any of:
 *
 *   - **the previous shutdown was not clean.** That is the condition under which
 *     SQLite was interrupted mid-write, which is the condition page corruption comes
 *     from. Detected by a marker file left saying `running` (see below).
 *   - **seven days since the last full check.** Bit-rot and a failing disk do not
 *     announce themselves, and a weekly full pass costs one slow start a week.
 *   - **`LOYALTY_FULL_INTEGRITY_CHECK=1`**, for a support engineer who has a reason.
 *
 * **Caveat on the foreign-key numbers, stated rather than buried.** The 111 MB and
 * 533 MB fixtures were grown with a bulk table carrying no foreign keys, so those two
 * rows understate `foreign_key_check` on a real database of that size — it walks
 * FK-bearing rows, and there were few. The 5.4 MB row (six months of real seeded
 * trading, 6–7 ms) is the trustworthy one; scaled linearly from it, a decade of that
 * shop's data is on the order of 150 ms. Cheap either way, which is why it is
 * unconditional.
 *
 * ── What each failure means, and what happens ────────────────────────────────
 *
 * A page check that fails means the file is damaged: the only safe move is to stop
 * before writing more on top of it, and restore. That refusal costs nothing — the
 * data is exactly where it was and the previous build still runs — and is the same
 * trade §12.18 makes for backups and `lib/migrate.ts` makes for migrations.
 *
 * A foreign-key violation is a different animal. The pages are sound; some row points
 * at a parent that is not there. That is worth knowing about loudly, and it is *not*
 * worth refusing to open the shop over: the till would stop for a condition that in
 * every plausible instance affects one historical row and nothing the cashier is
 * about to do. It is logged with the offending tables and reported in the result.
 */

/** How long a full `integrity_check` may go un-run before the next boot pays for one. */
const FULL_CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export interface RuntimeState {
  /** `running` in a file found at boot means the last process did not stop cleanly. */
  state: 'running' | 'stopped';
  pid: number;
  productVersion: string;
  startedAt: string;
  stoppedAt: string | null;
  lastFullIntegrityCheckAt: string | null;
}

/**
 * The marker as it was left by the previous process, or `null` when there is none.
 *
 * Best-effort by construction. A missing, unreadable or malformed marker means "we do
 * not know how the last run ended", and not knowing is treated exactly like an unclean
 * stop — the conservative direction, and the direction that costs only time.
 */
export function readRuntimeState(path = resolveRuntimeStatePath()): RuntimeState | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8').replace(/^/, '');
    const parsed = JSON.parse(raw) as Partial<RuntimeState>;
    if (parsed.state !== 'running' && parsed.state !== 'stopped') return null;
    return {
      state: parsed.state,
      pid: Number(parsed.pid ?? 0),
      productVersion: String(parsed.productVersion ?? ''),
      startedAt: String(parsed.startedAt ?? ''),
      stoppedAt: parsed.stoppedAt ? String(parsed.stoppedAt) : null,
      lastFullIntegrityCheckAt: parsed.lastFullIntegrityCheckAt
        ? String(parsed.lastFullIntegrityCheckAt)
        : null,
    };
  } catch {
    return null;
  }
}

/** Writes the marker. Never throws: a marker that cannot be written is not a reason to refuse a boot. */
export function writeRuntimeState(state: RuntimeState, path = resolveRuntimeStatePath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    // A BOM for the same reason `startup-error.ts` writes one: PowerShell 5.1 and
    // Notepad read a BOM-less UTF-8 file as ANSI, and this file gets opened by hand
    // on a support call.
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch {
    /* Not worth failing a start over. The next boot simply assumes an unclean stop. */
  }
}

/** Records that this process has taken the database, and returns what the last one left. */
export function markRunning(path = resolveRuntimeStatePath()): RuntimeState | null {
  const previous = readRuntimeState(path);
  writeRuntimeState(
    {
      state: 'running',
      pid: process.pid,
      productVersion: API_VERSION,
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      lastFullIntegrityCheckAt: previous?.lastFullIntegrityCheckAt ?? null,
    },
    path,
  );
  return previous;
}

/** Records a clean stop, so the next boot does not pay for a full check it has not earned. */
export function markStopped(path = resolveRuntimeStatePath()): void {
  const current = readRuntimeState(path);
  writeRuntimeState(
    {
      state: 'stopped',
      pid: process.pid,
      productVersion: API_VERSION,
      startedAt: current?.startedAt ?? new Date().toISOString(),
      stoppedAt: new Date().toISOString(),
      lastFullIntegrityCheckAt: current?.lastFullIntegrityCheckAt ?? null,
    },
    path,
  );
}

/** Remembers that a full check has just been done, so the seven-day clock restarts. */
function recordFullCheck(path = resolveRuntimeStatePath()): void {
  const current = readRuntimeState(path);
  writeRuntimeState(
    {
      state: current?.state ?? 'running',
      pid: process.pid,
      productVersion: API_VERSION,
      startedAt: current?.startedAt ?? new Date().toISOString(),
      stoppedAt: current?.stoppedAt ?? null,
      lastFullIntegrityCheckAt: new Date().toISOString(),
    },
    path,
  );
}

export interface IntegrityDecision {
  full: boolean;
  reason: 'unclean-shutdown' | 'no-previous-run' | 'weekly' | 'forced' | 'quick-is-enough';
}

/**
 * Whether this boot pays for the full check.
 *
 * Pure and exported for its own test: the whole value of the cheap path is that it is
 * cheap *and* still catches the case that matters, and getting the condition wrong
 * either way is invisible until the day it is not.
 */
export function decideIntegrityDepth(
  previous: RuntimeState | null,
  now: number = Date.now(),
): IntegrityDecision {
  if (process.env.LOYALTY_FULL_INTEGRITY_CHECK === '1') return { full: true, reason: 'forced' };
  if (!previous) return { full: true, reason: 'no-previous-run' };
  if (previous.state === 'running') return { full: true, reason: 'unclean-shutdown' };

  const last = previous.lastFullIntegrityCheckAt
    ? Date.parse(previous.lastFullIntegrityCheckAt)
    : NaN;
  if (!Number.isFinite(last) || now - last > FULL_CHECK_INTERVAL_MS) {
    return { full: true, reason: 'weekly' };
  }
  return { full: false, reason: 'quick-is-enough' };
}

export interface ForeignKeyViolation {
  table: string;
  rowid: number | null;
  parent: string;
  fkid: number;
}

export interface IntegrityResult {
  file: string;
  depth: 'quick' | 'full';
  reason: IntegrityDecision['reason'];
  pageCheckMs: number;
  foreignKeyCheckMs: number;
  foreignKeyViolations: ForeignKeyViolation[];
}

type Log = (message: string, extra?: Record<string, unknown>) => void;

/**
 * Runs the checks and refuses the boot if the file is damaged.
 *
 * `file` is passed in rather than re-derived: the caller has already asked SQLite
 * which file it opened (`db-identity.openDatabaseFile`), and every message here has to
 * name that same file — the whole class of failure this area is about is one where two
 * parts of the system are looking at different files and each is internally consistent.
 */
export async function verifyDatabaseIntegrity(options: {
  client?: PrismaClient;
  file: string;
  previous: RuntimeState | null;
  log: Log;
  statePath?: string;
}): Promise<IntegrityResult> {
  const client = options.client ?? defaultClient;
  const { file, log } = options;
  const decision = decideIntegrityDepth(options.previous);

  const pragma = decision.full ? 'PRAGMA integrity_check' : 'PRAGMA quick_check';
  const startedPages = process.hrtime.bigint();
  const pageRows = await client.$queryRawUnsafe<Array<Record<string, unknown>>>(pragma);
  const pageCheckMs = Number(process.hrtime.bigint() - startedPages) / 1e6;

  // Both pragmas answer with a single row reading `ok`, or one row per problem found.
  const problems = pageRows
    .map((row) => String(Object.values(row)[0] ?? ''))
    .filter((value) => value !== 'ok');

  if (problems.length > 0) {
    log('database page check failed', {
      file,
      pragma,
      problems: problems.slice(0, 20),
      problemCount: problems.length,
      ms: Math.round(pageCheckMs),
    });
    /*
      Two things changed, both found by asking whether following the sentence resolves
      the situation.

      The PATH is gone — it is in the log line above, and a Windows path inside an RTL
      sentence is neither readable nor usable by the person reading it.

      The remedy said «استعد أحدث نسخة احتياطية من شاشة النسخ الاحتياطي». That screen is
      inside the dashboard, behind a login, behind the service this very refusal has
      just stopped. The one person who can restore while the service is down is support,
      with `loyalty-pro-restore.cjs` and the archive in hand — so that is where it sends him,
      with the archive.
    */
    throw new Error(
      `تعذّر تشغيل الخدمة: ملف قاعدة البيانات تالف — فحص السلامة وجد ${problems.length} خطأ. ` +
        'لم يُكتب أي شيء في الملف. **لا تحذف أي ملف.** ' +
        'أحضر أحدث نسخة احتياطية (ملف ‎.walaabk من ذاكرة USB أو من Google Drive) وتواصل مع الدعم الفني لاستعادتها — لا يمكن الاستعادة من داخل البرنامج ما دامت الخدمة متوقفة. ' +
        'التفاصيل التقنية مسجّلة في ملف السجل.',
    );
  }

  const startedFk = process.hrtime.bigint();
  const fkRows = await client.$queryRawUnsafe<Array<Record<string, unknown>>>(
    'PRAGMA foreign_key_check',
  );
  const foreignKeyCheckMs = Number(process.hrtime.bigint() - startedFk) / 1e6;

  const foreignKeyViolations: ForeignKeyViolation[] = fkRows.map((row) => {
    const values = Object.values(row);
    return {
      table: String(values[0] ?? ''),
      rowid: values[1] === null || values[1] === undefined ? null : Number(values[1]),
      parent: String(values[2] ?? ''),
      fkid: Number(values[3] ?? 0),
    };
  });

  if (foreignKeyViolations.length > 0) {
    // Loud, and not fatal — the reasoning is in this module's header. The affected
    // tables are named so a support call starts from a fact rather than a hunt.
    log('database has foreign key violations', {
      file,
      count: foreignKeyViolations.length,
      tables: [...new Set(foreignKeyViolations.map((v) => v.table))],
      sample: foreignKeyViolations.slice(0, 10),
      ms: Math.round(foreignKeyCheckMs),
    });
  }

  if (decision.full) recordFullCheck(options.statePath);

  log('database integrity verified', {
    file,
    depth: decision.full ? 'integrity_check' : 'quick_check',
    reason: decision.reason,
    pageCheckMs: Math.round(pageCheckMs),
    foreignKeyCheckMs: Math.round(foreignKeyCheckMs),
    foreignKeyViolations: foreignKeyViolations.length,
  });

  return {
    file,
    depth: decision.full ? 'full' : 'quick',
    reason: decision.reason,
    pageCheckMs,
    foreignKeyCheckMs,
    foreignKeyViolations,
  };
}
