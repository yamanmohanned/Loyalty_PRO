import { useCallback, useEffect, useRef, useState } from 'react';
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
  /**
   * What the last action achieved, when it succeeded.
   *
   * Held HERE, beside the failure, rather than in a `notice` state of each screen's own:
   * two independent states were how a green «تم» and a red refusal from a later press
   * came to sit on one card together, each true once and contradicting the other. One
   * holder means an outcome replaces the previous one, and `<FormOutcome>` can only ever
   * show one of them.
   */
  success: string | null;
}

const EMPTY: FormErrorState = { fields: {}, summary: null, success: null };

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
    return { fields, summary: caught.message, success: null };
  }

  /*
    Not an API rejection at all — a bug in this app, or something `lib/api.ts` did not
    convert. It has already logged the real thing to the console; the merchant gets the
    one sentence in the product that means "this is not your fault".
  */
  console.error('[form] submit failed', caught);
  return { fields: {}, summary: locale.common.errorBody, success: null };
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
  /*
    ── Why a counter and an effect, and not a callback ─────────────────────────

    The first version called `focus()` from inside the rejection, on the next animation
    frame. That is a race with React's commit: the frame can fire before the re-render
    that sets `aria-invalid`, so the query finds nothing and focus stays on the button.

    It was not theoretical and it was not caught by reading the code. Driving the setup
    form in a browser, focus DID move; driving the staff form the same way it did not,
    and the only difference between them was how much work React had to do in between.
    A fix that works on the screen you tested it on is the defect this whole pass is
    about.

    An effect runs AFTER the commit, so the marks are in the DOM by definition. The
    counter is what makes two consecutive rejections of the same field re-fire it —
    without it, an identical `fields` object is `===` to the last one and the effect
    never runs a second time.
  */
  const [rejectedAt, setRejectedAt] = useState(0);

  /**
   * Puts the cursor in the first field the browser considers invalid.
   *
   * Queried out of the DOM rather than tracked per field: `Field` already sets
   * `aria-invalid` on its control through context, so every form gets this without a
   * ref per input and without a registry that can fall out of step with the fields
   * actually rendered. Deferred a frame because the marks are set in the same update.
   */
  useEffect(() => {
    if (rejectedAt === 0) return;
    const first = ref.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (!first) return;
    // Focused without scrolling, then scrolled deliberately: `focus()` alone jumps the
    // field to the nearest edge, which on a long form puts it under the header.
    first.focus({ preventScroll: true });
    first.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [rejectedAt]);

  const clear = useCallback(() => setState(EMPTY), []);

  /** Records a rejection — from the API or from a client-side parse — and finds it. */
  const reject = useCallback((next: FormErrorState) => {
    setState(next);
    setRejectedAt((n) => n + 1);
  }, []);

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
      reject({ fields, summary: summarizeFieldErrors(issues), success: null });
      return null;
    },
    [reject],
  );

  /**
   * Marks one field this app checked itself — a mistyped password confirmation, say,
   * which the server cannot detect because it only ever sees one of the two strings.
   */
  /**
   * Drops one field's mark, because the person is now typing in it.
   *
   * A red border that stays red while the value is being corrected is a message that
   * says "still wrong" about something that is not wrong any more — the same defect as
   * a message that sends the reader nowhere, in miniature. The summary goes with it:
   * a sentence naming a field that is no longer marked is worse than no sentence.
   */
  const clearField = useCallback((path: string) => {
    setState((current) => {
      if (!(path in current.fields)) return current;
      const next = { ...current.fields };
      delete next[path];
      return { ...current, fields: next, summary: Object.keys(next).length > 0 ? current.summary : null };
    });
  }, []);

  const rejectField = useCallback(
    (path: string, message: string) => reject({ fields: { [path]: message }, summary: message, success: null }),
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
    (message: string) => setState({ fields: {}, summary: message, success: null }),
    [],
  );

  /** The action worked: its sentence replaces whatever the last outcome was. */
  const succeed = useCallback(
    (message: string) => setState({ fields: {}, summary: null, success: message }),
    [],
  );

  return {
    ref,
    fields: state.fields,
    summary: state.summary,
    success: state.success,
    clear,
    fail,
    validate,
    rejectField,
    rejectForm,
    succeed,
    clearField,
  };
}
