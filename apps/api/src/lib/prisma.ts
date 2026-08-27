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

/** Prisma's code for a unique-constraint violation. The idempotency guard fires as this. */
export const PRISMA_UNIQUE_VIOLATION = 'P2002';
/** Postgres serialization failure — the caller should retry the whole transaction. */
export const PG_SERIALIZATION_FAILURE = '40001';

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

export const isSerializationFailure = (error: unknown): boolean => {
  const code = prismaErrorCode(error);
  if (code === PG_SERIALIZATION_FAILURE) return true;
  // Prisma wraps raw Postgres errors; the SQLSTATE surfaces in the message.
  return error instanceof Error && error.message.includes(PG_SERIALIZATION_FAILURE);
};
