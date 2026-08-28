import { PrismaClient } from '@prisma/client';
import { loadEnv } from '../config/env';

/**
 * One PrismaClient for the process. Creating more than one exhausts the
 * connection pool under load, and in dev the watcher would leak a client per reload.
 */

const env = loadEnv();

declare global {
  var __walaaPrisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  globalThis.__walaaPrisma ??
  new PrismaClient({
    log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (env.NODE_ENV !== 'production') globalThis.__walaaPrisma = prisma;

/**
 * SQLite connection settings the v3 concurrency decision depends on (§12.5).
 *
 * `journal_mode = WAL` is the important one. SQLite's default (`delete`) takes a
 * whole-database lock for every write, so a dashboard read blocks behind an agent
 * ingestion and vice versa. WAL lets readers proceed concurrently with the single
 * writer, which is precisely the shape of traffic here: many readers, one API
 * service writing.
 *
 * WAL is persisted in the database file header, so it survives restarts — but a
 * freshly created file starts in `delete` mode, so this must run on every
 * bootstrap path (server, seed, tests) or a new install silently gets the slow,
 * lock-prone behaviour.
 *
 * `busy_timeout` gives a blocked writer five seconds to wait rather than failing
 * immediately, and `foreign_keys` is off by default in SQLite — without it the
 * relations declared in the schema would not actually be enforced.
 */
export async function applySqlitePragmas(client: PrismaClient = prisma): Promise<void> {
  // `$queryRawUnsafe`, not `$executeRawUnsafe`: several PRAGMAs return a row
  // (journal_mode answers with the mode it settled on), and Prisma rejects a
  // result set from an execute call.
  await client.$queryRawUnsafe('PRAGMA journal_mode = WAL');
  await client.$queryRawUnsafe('PRAGMA busy_timeout = 5000');
  await client.$queryRawUnsafe('PRAGMA foreign_keys = ON');
  // NORMAL is the recommended durability setting under WAL: it survives an
  // application crash, trading only a power-loss window that a UPS or the
  // mandatory backups (§7.3) already cover.
  await client.$queryRawUnsafe('PRAGMA synchronous = NORMAL');
}

/** Prisma's code for a unique-constraint violation. The idempotency guard fires as this. */
export const PRISMA_UNIQUE_VIOLATION = 'P2002';
/**
 * SQLite reports contention as SQLITE_BUSY rather than a serialization failure.
 * With WAL enabled and the API as the sole writer (CLAUDE_v3.md §12.5) this should
 * be rare, but a busy timeout plus a retry is the correct handling when it happens.
 */
export const SQLITE_BUSY = 'SQLITE_BUSY';

interface PrismaLikeError {
  code?: unknown;
  meta?: unknown;
}

export function prismaErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as PrismaLikeError).code;
  return typeof code === 'string' ? code : null;
}

export const isUniqueViolation = (error: unknown): boolean =>
  prismaErrorCode(error) === PRISMA_UNIQUE_VIOLATION;

export const isBusyError = (error: unknown): boolean => {
  if (prismaErrorCode(error) === SQLITE_BUSY) return true;
  return error instanceof Error && error.message.includes('SQLITE_BUSY');
};
