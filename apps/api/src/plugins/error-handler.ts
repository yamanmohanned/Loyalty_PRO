import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors';
import { isStorageFailure, isUniqueViolation } from '../lib/prisma';
import { isContentionError } from '../lib/write-transaction';

/**
 * The single exit point for every failure (CLAUDE.md §9).
 *
 * Two rules govern this file:
 *
 * 1. **Every response is the shared error envelope.** Clients branch on `code`,
 *    never on a parsed message string.
 * 2. **Unrecognised errors never leak their internals.** A stack trace, a SQL
 *    fragment or a Prisma message can disclose schema and file paths, so unknown
 *    failures log in full server-side and return a flat 500 to the caller.
 */
/** Reads a numeric statusCode off an unknown thrown value, without asserting its shape. */
function statusCodeOf(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === 'number' ? value : null;
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: 'المسار غير موجود',
        requestId: request.id,
      },
    });
  });

  app.setErrorHandler((error, request, reply) => {
    // Deliberate failures: already carry a code, a status and a safe message.
    if (error instanceof AppError) {
      // 5xx means we broke something; anything else is an expected outcome.
      if (error.statusCode >= 500) {
        request.log.error({ err: error, code: error.code }, 'request failed');
      } else {
        request.log.info({ code: error.code }, 'request rejected');
      }
      reply.status(error.statusCode).send(error.toEnvelope(request.id));
      return;
    }

    // Zod failures that escaped the validator compiler (e.g. thrown inside a service).
    if (error instanceof ZodError) {
      reply.status(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'البيانات المُرسلة غير صحيحة',
          fields: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
          requestId: request.id,
        },
      });
      return;
    }

    // @fastify/rate-limit throws its built payload rather than replying directly,
    // so a throttle arrives here and must be recognised by its statusCode.
    const status = statusCodeOf(error);
    if (status === 429) {
      reply.status(429).send({
        error: {
          code: 'RATE_LIMITED',
          message: 'عدد كبير من المحاولات — انتظر قليلاً ثم أعد المحاولة',
          requestId: request.id,
        },
      });
      return;
    }

    // A datastore that cannot store. Checked before the generic 500 because the two
    // demand different things: a bug is ours and the till carries on, whereas a full
    // disk means every sale from now on is unrecorded and the only person who can
    // raise the alarm is the operator looking at this response (§12.15, §12.16).
    // Logged at error with the cause, because the message the client gets deliberately
    // does not carry it.
    if (isStorageFailure(error)) {
      request.log.error({ err: error }, 'datastore could not accept a write');
      reply.status(507).send({
        error: {
          code: 'STORAGE_UNAVAILABLE',
          message: 'تعذّر حفظ العملية — أبلغ الإدارة فوراً',
          requestId: request.id,
        },
      });
      return;
    }

    // A unique violation reaching here is a constraint we did not anticipate.
    // Report it as a conflict rather than a 500, but log loudly: it means some
    // write path is missing its idempotency handling.
    if (isUniqueViolation(error)) {
      request.log.error({ err: error }, 'unhandled unique constraint violation');
      reply.status(409).send({
        error: {
          code: 'DUPLICATE_INVOICE',
          message: 'هذه العملية مسجّلة مسبقاً',
          requestId: request.id,
        },
      });
      return;
    }

    // Fastify's own 4xx (malformed JSON, unsupported media type, …).
    if (status !== null && status >= 400 && status < 500) {
      reply.status(status).send({
        error: {
          code: 'VALIDATION_FAILED',
          // A body the parser could not read — malformed JSON, a wrong content type.
          // Never something a person typed; almost always a page older than the server
          // it is talking to, which a reload fixes. «الطلب غير صالح» said only that
          // something was wrong.
          message: 'تعذّر فهم الطلب — أعد تحميل الصفحة، وإذا تكرّر الأمر حدّث البرنامج على هذا الجهاز.',
          requestId: request.id,
        },
      });
      return;
    }

    /*
      A write that could not get the writer, after `writeTransaction` had already
      retried it. Still a 500 — the sale was not saved and §12.16 says the operator must
      be told so plainly — but logged under its own message, because the two failures it
      would otherwise be filed with demand completely different responses.

      Before the write queue existed this was not rare: 16 simultaneous `/scan/card`
      requests produced nine of these, and 64 produced sixty-four, all of them reading
      «حدث خطأ غير متوقع» in a log full of genuine bugs. It should now be close to
      unreachable, and the distinct line is how anyone finds out it is not.
    */
    if (isContentionError(error)) {
      request.log.error({ err: error }, 'write contention outlasted its retries');
      reply.status(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'حدث خطأ غير متوقع',
          requestId: request.id,
        },
      });
      return;
    }

    // Anything left is a bug. Full detail to the log, nothing to the client.
    request.log.error({ err: error }, 'unhandled error');
    reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'حدث خطأ غير متوقع',
        requestId: request.id,
      },
    });
  });
}
