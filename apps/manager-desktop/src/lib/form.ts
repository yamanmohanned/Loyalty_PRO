import { useCallback, useRef, useState } from 'react';
import type { z } from 'zod';
import { summarizeFieldErrors } from '@walaa/shared-types';
import { ApiRequestError } from './api';
import { locale } from './locale';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A REJECTION NAMES ITS FIELD, MARKS IT, AND PUTS THE CURSOR IN IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── The failure this closes ──────────────────────────────────────────────────
 *
 * «إعداد المتجر لأول مرة» answered «البيانات المرسلة غير صحيحة» and nothing else. The
 * API had already said which field and why — it puts a per-field Arabic sentence in
 * the envelope's `fields` array — and every screen in this app read `message` and threw
 * `fields` away. `Field` has taken an `error` prop and drawn a red border since it was
 * written; nothing was ever passed to it from a server rejection.
 *
 * So this is not a new capability. It is the wire that was never run between two
 * halves that were both already built.
 *
 * ── Client rules and server rules are the same object ────────────────────────
 *
 * `validate()` parses with a schema out of `@walaa/shared-types` — the SAME schema the
 * route validates with, not a copy of its rules. A value this form accepts therefore
 * cannot be refused by the API for a shape reason, because the two are one definition.
 * Copying the rules into the component is what produced the password field that
 * accepted ten characters and a server that then refused nine of them.
 *
 * ── Why focus moves, and why it is not a nicety ──────────────────────────────
 *
 * The merchant who hit this was tabbing through a form he could not scroll. A red
 * border on a field below the fold is a red border he never sees. Moving focus scrolls
 * it into view as a side effect of the thing that was needed anyway — the cursor being
 * where the correction has to be typed.
 */

/** A rejection, per field path, exactly as the API reports paths. */
export type FieldErrors = Readonly<Record<string, string>>;

export interface FormErrorState {
  /** Per-field messages, keyed by path. Passed straight to `Field`'s `error`. */
  fields: FieldErrors;
  /** One sentence for the panel above the button. Never a generic one. */
  summary: string | null;
}

const EMPTY: FormErrorState = { fields: {}, summary: null };

/**
 * Turns anything a submit can throw into fields plus a sentence.
 *
 * Exported separately from the hook because a few call sites do their submitting
 * inside a mutation and only want the mapping.
 */
export function toFormErrors(caught: unknown): FormErrorState {
  if (caught instanceof ApiRequestError) {
    const fields: Record<string, string> = {};
    for (const entry of caught.fields ?? []) {
      // First message per path wins: a field with a length rule and a format rule
      // reports both for one empty value, and the second is noise.
      if (!(entry.path in fields)) fields[entry.path] = entry.message;
    }
    return { fields, summary: caught.message };
  }

  /*
    Not an API rejection at all — a bug in this app, or something `lib/api.ts` did not
    convert. It has already logged the real thing to the console; the merchant gets the
    one sentence in the product that means "this is not your fault".
  */
  console.error('[form] submit failed', caught);
  return { fields: {}, summary: locale.common.errorBody };
}

/**
 * Field errors for one form, plus the focus behaviour that makes them findable.
 *
 * ```tsx
 * const form = useFormErrors();
 * <form ref={form.ref} onSubmit={...}>
 *   <Field label="..." error={form.fields.branchCode}>…</Field>
 *   {form.summary ? <Notice tone="danger">{form.summary}</Notice> : null}
 * ```
 */
export function useFormErrors() {
  const [state, setState] = useState<FormErrorState>(EMPTY);
  const ref = useRef<HTMLFormElement | null>(null);

  /**
   * Puts the cursor in the first field the browser considers invalid.
   *
   * Queried out of the DOM rather than tracked per field: `Field` already sets
   * `aria-invalid` on its control through context, so every form gets this without a
   * ref per input and without a registry that can fall out of step with the fields
   * actually rendered. Deferred a frame because the marks are set in the same update.
   */
  const focusFirstInvalid = useCallback(() => {
    requestAnimationFrame(() => {
      const first = ref.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
      if (!first) return;
      first.focus({ preventScroll: true });
      first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }, []);

  const clear = useCallback(() => setState(EMPTY), []);

  /** Records a rejection — from the API or from a client-side parse — and finds it. */
  const reject = useCallback(
    (next: FormErrorState) => {
      setState(next);
      focusFirstInvalid();
    },
    [focusFirstInvalid],
  );

  const fail = useCallback((caught: unknown) => reject(toFormErrors(caught)), [reject]);

  /**
   * Parses a value with the schema the API uses, before anything is sent.
   *
   * Returns the PARSED value on success, because the schemas trim, lowercase and
   * normalise (`PhoneInputSchema` emits E.164), and sending the raw form state would
   * mean the client validated one value and posted another.
   */
  const validate = useCallback(
    <T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> | null => {
      const result = schema.safeParse(value);
      if (result.success) {
        setState(EMPTY);
        return result.data as z.infer<T>;
      }

      const fields: Record<string, string> = {};
      const issues: Array<{ path: string; message: string }> = [];
      for (const issue of result.error.issues) {
        const path = issue.path.join('.');
        if (path in fields) continue;
        fields[path] = issue.message;
        issues.push({ path, message: issue.message });
      }
      reject({ fields, summary: summarizeFieldErrors(issues) });
      return null;
    },
    [reject],
  );

  /**
   * Marks one field this app checked itself — a mistyped password confirmation, say,
   * which the server cannot detect because it only ever sees one of the two strings.
   */
  const rejectField = useCallback(
    (path: string, message: string) => reject({ fields: { [path]: message }, summary: message }),
    [reject],
  );

  /**
   * A rejection that belongs to the whole form rather than to one box.
   *
   * A wrong password is the case this exists for: WHICH of the two boxes was wrong is
   * precisely what a sign-in may not disclose, so marking one would be a security
   * defect dressed as a usability improvement.
   */
  const rejectForm = useCallback(
    (message: string) => setState({ fields: {}, summary: message }),
    [],
  );

  return {
    ref,
    fields: state.fields,
    summary: state.summary,
    clear,
    fail,
    validate,
    rejectField,
    rejectForm,
  };
}
