import { z } from 'zod';

/**
 * Phone numbers are the customer's identity (CLAUDE.md §1.4, §7.11) and carry a
 * per-merchant UNIQUE constraint. That constraint is only meaningful if every write
 * stores the *same* number the same way — otherwise `07701234567` and
 * `+9647701234567` become two accounts for one human.
 *
 * Decision (confirmed 2026-08-24): normalise to **E.164** on write, accept the
 * local `07xx` form (and the other shapes people actually type) on input.
 */

/** Iraq. The platform is single-country today; this is the one place that assumption lives. */
export const DEFAULT_COUNTRY_CALLING_CODE = '964';

/**
 * E.164 for an Iraqi mobile: `+964` followed by `7` and nine more digits.
 * Deliberately not restricted to today's carrier prefixes (075/077/078/079) — new
 * ranges get allocated, and rejecting a real customer at the register is the worse
 * failure than accepting an implausible number.
 */
const E164_IQ_MOBILE = /^\+9647\d{9}$/;

export const PhoneE164Schema = z
  .string()
  .regex(E164_IQ_MOBILE, 'رقم الهاتف غير صالح — يجب أن يكون رقم موبايل عراقي');

export type PhoneE164 = z.infer<typeof PhoneE164Schema>;

/**
 * Converts any of the shapes a human or a keypad produces into E.164.
 * Returns `null` when the input cannot be a valid Iraqi mobile number.
 *
 * Accepts: `07701234567` · `7701234567` · `+9647701234567` · `009647701234567`
 * and any of those with spaces, dashes or parentheses.
 */
export function normalizePhone(input: string): PhoneE164 | null {
  if (typeof input !== 'string') return null;

  // Strip everything that is not a digit or a leading plus.
  let digits = input.trim().replace(/[\s()\-.]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  if (!/^\d+$/.test(digits)) return null;

  // Reduce to the national significant number (10 digits, starting with 7).
  let national: string;
  if (digits.startsWith(DEFAULT_COUNTRY_CALLING_CODE)) {
    national = digits.slice(DEFAULT_COUNTRY_CALLING_CODE.length);
  } else if (digits.startsWith('0')) {
    national = digits.slice(1);
  } else {
    national = digits;
  }
  // A national number may still carry a trunk zero after the country code (+9640770…).
  if (national.startsWith('0')) national = national.slice(1);

  const candidate = `+${DEFAULT_COUNTRY_CALLING_CODE}${national}`;
  return E164_IQ_MOBILE.test(candidate) ? candidate : null;
}

/**
 * Zod schema for phone input at any boundary: accepts the loose forms, emits E.164.
 * Use this on every request body — never `z.string()` for a phone.
 */
export const PhoneInputSchema = z
  .string()
  .min(1, 'رقم الهاتف مطلوب')
  .transform((value, ctx) => {
    const normalized = normalizePhone(value);
    if (!normalized) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'رقم الهاتف غير صالح — يجب أن يكون رقم موبايل عراقي',
      });
      return z.NEVER;
    }
    return normalized;
  });

/** Renders E.164 back to the local form Iraqis read: `+9647701234567` → `0770 123 4567`. */
export function formatPhoneLocal(phone: PhoneE164): string {
  const national = phone.replace(`+${DEFAULT_COUNTRY_CALLING_CODE}`, '');
  if (national.length !== 10) return phone;
  return `0${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`;
}
