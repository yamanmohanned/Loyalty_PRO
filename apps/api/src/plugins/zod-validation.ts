import type { FastifyInstance, FastifySchemaCompiler } from 'fastify';
import { ZodError, type ZodTypeAny } from 'zod';
import { AppError } from '../lib/errors';

/**
 * Zod validation on every request boundary (CLAUDE.md §7.4).
 *
 * Rather than pulling in a type-provider package, this teaches Fastify to treat a
 * Zod schema in a route's `schema` block as the validator directly. It is a dozen
 * lines, has no dependency to keep in step with Zod and Fastify majors, and — the
 * reason that matters — it lets a validation failure become our own error envelope
 * instead of Fastify's AJV-shaped one.
 *
 * Unknown-field rejection comes from the schemas themselves: every request schema in
 * `@walaa/shared-types` is `.strict()`, so an unexpected field is a 400 rather than a
 * value silently dropped on the floor.
 */

const isZodSchema = (schema: unknown): schema is ZodTypeAny =>
  typeof schema === 'object' && schema !== null && 'safeParse' in schema;

export const zodValidatorCompiler: FastifySchemaCompiler<ZodTypeAny> =
  ({ schema }) =>
  (data) => {
    if (!isZodSchema(schema)) {
      // A non-Zod schema on a route is a programming mistake, not a bad request.
      return { error: new Error('route schema is not a Zod schema') as never };
    }

    const result = schema.safeParse(data);
    if (result.success) {
      // Return the PARSED value, not the input: this is what applies defaults,
      // coercions and transforms — notably PhoneInputSchema emitting E.164.
      return { value: result.data };
    }
    return { error: toAppError(result.error) as never };
  };

function toAppError(error: ZodError): AppError {
  return new AppError('VALIDATION_FAILED', 'البيانات المُرسلة غير صحيحة', {
    fields: error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  });
}

export function registerZodValidation(app: FastifyInstance): void {
  app.setValidatorCompiler(zodValidatorCompiler);
}
