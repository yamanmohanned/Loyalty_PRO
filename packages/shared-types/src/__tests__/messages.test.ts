import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as shared from '../index';
import { FIELD_LABELS, describeFieldError, fieldLabel, summarizeFieldErrors } from '../messages';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  NO SCHEMA IN THIS PRODUCT MAY REJECT A MERCHANT IN ENGLISH
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── Why this is a test and not a review note ─────────────────────────────────
 *
 * Zod's default messages are English, and a schema author only writes an Arabic one
 * for the rules they happen to be thinking about. Swept with the values a person
 * actually produces, this package produced **136 distinct English messages** before
 * the error map existed — «Required» alone across 312 field positions, all of them
 * reachable by a shop owner leaving a box empty.
 *
 * A review catches those on the day and not on the day somebody adds a schema. This
 * asks the schemas themselves, so the 137th cannot ship.
 *
 * ── What it measures, and what it deliberately does not ──────────────────────
 *
 * It parses REAL values through REAL schemas and reads the messages that come out.
 * It does not grep the source for Arabic characters, which would pass for a file full
 * of `.min(2, 'مطلوب')` while `Required` still came out of the untouched `.max(120)`
 * beside it. The thing that reaches the merchant is the parse result, so the parse
 * result is what is asserted.
 */

/** Latin letters anywhere in a merchant-facing sentence. */
const LATIN = /[A-Za-z]/;

/**
 * The values a person, a mistyped client and a broken caller actually send.
 *
 * Includes the empty object and `undefined` deliberately: "the field was not sent"
 * and "the field was sent empty" are the two most common rejections in the product
 * and were both «Required» before this.
 */
const PROBES: readonly unknown[] = [
  undefined,
  null,
  {},
  '',
  0,
  [],
  { merchantName: '', branchName: '', branchCode: '', ownerName: '', username: '', password: '' },
  { name: '', phone: '', category: '' },
  { name: 'x'.repeat(500), phone: 'ليس رقماً', amount: -1, code: '' },
  { amount: 'كثير', quantity: 'ثلاثة', id: 'not-a-uuid', at: 'أمس' },
  { unexpectedField: 1 },
  { tiers: [] },
  { tiers: [{}] },
];

function everySchema(): Array<[string, z.ZodTypeAny]> {
  return Object.entries(shared)
    .filter(([name]) => name.endsWith('Schema'))
    .filter(([, value]) => typeof (value as { safeParse?: unknown })?.safeParse === 'function')
    .map(([name, value]) => [name, value as z.ZodTypeAny]);
}

describe('every rejection a merchant can reach', () => {
  it('is written in Arabic, from every schema in this package', () => {
    const offenders: string[] = [];

    for (const [name, schema] of everySchema()) {
      for (const probe of PROBES) {
        const result = schema.safeParse(probe);
        if (result.success) continue;
        for (const issue of result.error.issues) {
          if (!LATIN.test(issue.message)) continue;
          offenders.push(`${name}.${issue.path.join('.') || '(root)'} → «${issue.message}»`);
        }
      }
    }

    expect([...new Set(offenders)].sort()).toEqual([]);
  });

  it('names the field it is about, for every path a request schema can report', () => {
    /*
      A message with no field name beside it is the generic failure wearing a
      different sentence. Request schemas are the ones whose paths reach a form, so
      those are the ones whose every path must have an Arabic name.
    */
    const unnamed = new Set<string>();

    for (const [name, schema] of everySchema()) {
      if (!name.endsWith('RequestSchema')) continue;
      for (const probe of PROBES) {
        const result = schema.safeParse(probe);
        if (result.success) continue;
        for (const issue of result.error.issues) {
          const path = issue.path.join('.');
          // A root-level issue is about the whole body, not a field: an unrecognised
          // key, or a body that is not an object at all. Those have their own
          // sentences and no field to point at.
          if (!path) continue;
          if (!fieldLabel(path)) unnamed.add(`${name}.${path}`);
        }
      }
    }

    expect([...unnamed].sort()).toEqual([]);
  });
});

describe('the error map itself', () => {
  it('answers for a rule with no message of its own', () => {
    const schema = z.object({ password: z.string().min(10).max(200) });
    const issues = schema.safeParse({ password: 'short' }).error?.issues ?? [];
    expect(issues[0]?.message).toBe('أدخل 10 أحرف على الأقل');
  });

  it('does not override a message the schema author wrote', () => {
    const schema = z.object({ branchCode: z.string().min(2, 'رمز الفرع مطلوب') });
    const issues = schema.safeParse({ branchCode: '' }).error?.issues ?? [];
    expect(issues[0]?.message).toBe('رمز الفرع مطلوب');
  });

  it('says a missing field is missing rather than describing its type', () => {
    const issues = z.object({ name: z.string() }).safeParse({}).error?.issues ?? [];
    expect(issues[0]?.message).toBe('هذا الحقل مطلوب');
  });

  it('counts in Arabic, which is not the same as counting in English', () => {
    const one = z.string().max(1).safeParse('ab').error?.issues[0]?.message;
    const two = z.string().max(2).safeParse('abc').error?.issues[0]?.message;
    const five = z.string().max(5).safeParse('abcdef').error?.issues[0]?.message;
    const twenty = z.string().max(20).safeParse('x'.repeat(21)).error?.issues[0]?.message;
    expect([one, two, five, twenty]).toEqual([
      'الحد الأقصى حرف واحد',
      'الحد الأقصى حرفان',
      'الحد الأقصى 5 أحرف',
      'الحد الأقصى 20 حرفاً',
    ]);
  });
});

describe('the sentence a screen renders', () => {
  it('names the one field when there is one', () => {
    expect(summarizeFieldErrors([{ path: 'branchCode', message: 'أحرف إنجليزية فقط' }])).toBe(
      'رمز الفرع: أحرف إنجليزية فقط',
    );
  });

  it('lists the fields when there are several, without repeating their rules', () => {
    expect(
      summarizeFieldErrors([
        { path: 'branchCode', message: 'أحرف إنجليزية فقط' },
        { path: 'password', message: '10 أحرف على الأقل' },
      ]),
    ).toBe('راجع هذه الحقول: رمز الفرع، كلمة المرور');
  });

  it('does not print the field name twice when the rule already opens with it', () => {
    expect(describeFieldError('branchCode', 'رمز الفرع مطلوب')).toBe('رمز الفرع مطلوب');
  });

  it('resolves an indexed path to the field it is under', () => {
    expect(fieldLabel('tiers.0.discountPct')).toBe(FIELD_LABELS.discountPct);
  });

  it('omits the name rather than printing a path when there is none', () => {
    expect(describeFieldError('someFieldNobodyNamed', 'القيمة غير صالحة')).toBe('القيمة غير صالحة');
  });
});
