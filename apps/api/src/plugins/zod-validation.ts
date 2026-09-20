import type { FastifyInstance, FastifySchemaCompiler } from 'fastify';
import { ZodError, type ZodTypeAny } from 'zod';
import { summarizeFieldErrors } from '@loyalty-pro/shared-types';
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
 * `@loyalty-pro/shared-types` is `.strict()`, so an unexpected field is a 400 rather than a
 * value silently dropped on the floor.
 *
 * ── The envelope names the field, and that is a fix ──────────────────────────
 *
 * The top-level `message` was the constant «البيانات المُرسلة غير صحيحة» for every
 * rejection this compiler ever produced. The `fields` array beside it always carried
 * the real answer — «رمز الفرع: أحرف إنجليزية وأرقام وشرطة فقط» — and the screens
 * rendered `message` and dropped `fields`, so a merchant at a counter was told his
 * data was wrong and nothing else.
 *
 * Both halves are fixed. The screens now render the fields (see the dashboard's
 * `lib/form.ts`), and `message` is no longer a constant: it is built from the same
 * issues, so any surface that renders only the sentence still names the field. The
 * two are not duplicates — the sentence carries the field's Arabic NAME, because
 * nothing beside it says which field it is; the per-field entry does not, because it
 * is rendered under a labelled field.
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
  /*
    Deduplicated by (path, message). A field with both a `min` and a `regex` on it
    reports two issues for one empty value — the merchant sees «رمز الفرع مطلوب»
    followed by «رمز الفرع: أحرف إنجليزية…», the second of which is noise while the
    field is empty. The first message per path wins, which is the more specific one
    in every schema here because the length rule is written first.
  */
  const seen = new Set<string>();
  const fields: Array<{ path: string; message: string }> = [];
  for (const issue of error.issues) {
    const path = issue.path.join('.');
    if (seen.has(path)) continue;
    seen.add(path);
    fields.push({ path, message: issue.message });
  }

  return new AppError('VALIDATION_FAILED', summarizeFieldErrors(fields), { fields });
}

export function registerZodValidation(app: FastifyInstance): void {
  app.setValidatorCompiler(zodValidatorCompiler);
}
