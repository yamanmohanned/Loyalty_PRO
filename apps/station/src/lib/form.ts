import { useCallback, useEffect, useRef, useState } from 'react';
import { summarizeFieldErrors } from '@walaa/shared-types';
import { ApiRequestError } from './api';
import { locale } from './locale';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A REJECTION AT THE TILL NAMES ITS FIELD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Station's twin of the dashboard's `lib/form.ts`, and it exists for the same
 * reason with a shorter fuse: there is a customer standing at the counter.
 *
 * ── What was wrong here specifically ─────────────────────────────────────────
 *
 * `Register` rendered `error_.fields?.[0]?.message` under the PHONE field, whatever
 * field the API had actually rejected. A name too short — the other thing this form
 * can get wrong — put «الاسم مطلوب» under a phone number that was perfectly fine, and
 * the operator retyped the phone.
 *
 * Duplicated rather than shared because the two apps have separate `ApiRequestError`
 * classes and separate locales; the schemas they validate against are the shared ones,
 * which is the part that must not drift.
 */

/** As much of a Zod schema as this needs — see `validate` for why not `z.ZodType`. */
interface SchemaLike<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: Array<{ path: Array<string | number>; message: string }> } };
}

export type FieldErrors = Readonly<Record<string, string>>;

export interface FormErrorState {
  fields: FieldErrors;
  summary: string | null;
}

const EMPTY: FormErrorState = { fields: {}, summary: null };

export function toFormErrors(caught: unknown): FormErrorState {
  if (caught instanceof ApiRequestError) {
    const fields: Record<string, string> = {};
    for (const entry of caught.fields ?? []) {
      if (!(entry.path in fields)) fields[entry.path] = entry.message;
    }
    return { fields, summary: caught.message };
  }
  console.error('[form] submit failed', caught);
  return { fields: {}, summary: locale.errors.unexpected };
}

/** Field errors for one form, plus the focus that makes them findable. */
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

  const reject = useCallback((next: FormErrorState) => {
    setState(next);
    setRejectedAt((n) => n + 1);
  }, []);

  const fail = useCallback((caught: unknown) => reject(toFormErrors(caught)), [reject]);

  /*
    Typed structurally rather than against `zod`, which this app does not depend on
    directly — it gets its schemas through `@walaa/shared-types`, and adding a second
    copy of zod to the Station's dependency tree to name one type would be a real risk
    for no benefit: two zod instances means two error-map registries, and the Arabic
    one is installed on exactly one of them.
  */
  const validate = useCallback(
    <T>(schema: SchemaLike<T>, value: unknown): T | null => {
      const result = schema.safeParse(value);
      if (result.success) {
        setState(EMPTY);
        return result.data;
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
      return { fields: next, summary: Object.keys(next).length > 0 ? current.summary : null };
    });
  }, []);

  const rejectField = useCallback(
    (path: string, message: string) => reject({ fields: { [path]: message }, summary: message }),
    [reject],
  );

  /** For a rejection with no field to point at — a wrong password, a duplicate. */
  const rejectForm = useCallback(
    (message: string) => setState({ fields: {}, summary: message }),
    [],
  );

  return { ref, fields: state.fields, summary: state.summary, clear, fail, validate, rejectField, rejectForm, clearField };
}
