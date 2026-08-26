import { z } from 'zod';
import { PeriodTypeSchema, type PeriodType } from './enums';

/**
 * Loyalty period keys.
 *
 * Decision (confirmed 2026-08-24): a loyalty period is a **fixed calendar window
 * shared by every customer**, and cumulative spend **resets to zero at each
 * boundary**. Everyone on a MONTHLY rule set resets together on the 1st. This is
 * the version a shop owner can explain to a customer in one sentence, and it makes
 * `period_key` a stable, sortable, cacheable string.
 *
 * Timezone: boundaries are computed in the **merchant's local timezone**, not UTC.
 * A purchase at 01:00 on 1 September in Baghdad is 22:00 on 31 August UTC — computing
 * the key in UTC would file it under the wrong month and silently corrupt the reset.
 * Timestamps are still *stored* in UTC (CLAUDE.md §4.2); only the bucketing is local.
 */

export const DEFAULT_MERCHANT_TIMEZONE = 'Asia/Baghdad';

/** `2026-08` (monthly) · `2026-W35` (weekly) · `custom:2026-08-01..2026-08-31`. */
export const PeriodKeySchema = z
  .string()
  .regex(
    /^(\d{4}-\d{2}|\d{4}-W\d{2}|custom:\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2})$/,
    'صيغة مفتاح الفترة غير صحيحة',
  );

export type PeriodKey = z.infer<typeof PeriodKeySchema>;

/** The calendar parts of an instant, as seen in a given IANA timezone. */
interface ZonedParts {
  year: number;
  month: number;
  day: number;
}

/**
 * Projects a UTC instant into a timezone's calendar date using the platform ICU data.
 * Avoids pulling a date library in for what is three integers.
 */
function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);

  const read = (type: 'year' | 'month' | 'day'): number => {
    const found = parts.find((p) => p.type === type);
    if (!found) throw new Error(`تعذر حساب التاريخ للمنطقة الزمنية ${timeZone}`);
    return Number.parseInt(found.value, 10);
  };

  return { year: read('year'), month: read('month'), day: read('day') };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * ISO-8601 week number and week-year for a calendar date.
 * Weeks start Monday; week 1 is the week containing the first Thursday of the year.
 */
function isoWeek({ year, month, day }: ZonedParts): { weekYear: number; week: number } {
  // Work in UTC on a date carrying the *local* calendar parts, so no offset math leaks in.
  const date = new Date(Date.UTC(year, month - 1, day));
  const dayOfWeek = date.getUTCDay() || 7; // Sunday 0 -> 7
  date.setUTCDate(date.getUTCDate() + 4 - dayOfWeek); // shift to the week's Thursday
  const weekYear = date.getUTCFullYear();
  const jan1 = new Date(Date.UTC(weekYear, 0, 1));
  const week = Math.ceil(((date.getTime() - jan1.getTime()) / 86_400_000 + 1) / 7);
  return { weekYear, week };
}

export interface PeriodKeyInput {
  periodType: PeriodType;
  /** The instant the purchase occurred (stored UTC). */
  occurredAt: Date;
  /** IANA zone the merchant trades in. */
  timeZone?: string;
  /** Required when `periodType` is CUSTOM — the fixed window's bounds. */
  customStart?: Date | null;
  customEnd?: Date | null;
}

/**
 * Computes the period bucket a transaction belongs to. Pure and deterministic:
 * the same instant always maps to the same key, on the device and on the server —
 * which is what lets the offline assistant app compute a provisional balance.
 */
export function computePeriodKey(input: PeriodKeyInput): PeriodKey {
  const timeZone = input.timeZone ?? DEFAULT_MERCHANT_TIMEZONE;
  const parts = zonedParts(input.occurredAt, timeZone);

  switch (input.periodType) {
    case 'MONTHLY':
      return `${parts.year}-${pad2(parts.month)}`;

    case 'WEEKLY': {
      const { weekYear, week } = isoWeek(parts);
      return `${weekYear}-W${pad2(week)}`;
    }

    case 'CUSTOM': {
      if (!input.customStart || !input.customEnd) {
        throw new Error('الفترة المخصصة تتطلب تاريخ بداية ونهاية');
      }
      const start = zonedParts(input.customStart, timeZone);
      const end = zonedParts(input.customEnd, timeZone);
      const fmt = (p: ZonedParts) => `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
      return `custom:${fmt(start)}..${fmt(end)}`;
    }
  }
}

/** Narrowing helper for callers holding an unvalidated string. */
export const parsePeriodType = (value: unknown): PeriodType => PeriodTypeSchema.parse(value);
