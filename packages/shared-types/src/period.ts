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

/** The calendar date an instant falls on in a timezone, as `YYYY-MM-DD`. */
export function localDateKey(instant: Date, timeZone: string): string {
  const { year, month, day } = zonedParts(instant, timeZone);
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * The instant at which a local calendar day begins, and the one at which it ends.
 *
 * The same rule as §13.1, applied to a day instead of a period: **a day boundary is
 * local, never UTC.** Baghdad is UTC+3, so a UTC day begins at 03:00 local and a sale
 * made in the first three hours of a local day is filed under the previous one. Today
 * that error is hidden by opening hours rather than prevented by anything, and it stops
 * being hidden the moment a shop trades late or a merchant is in another timezone.
 *
 * Takes either an instant — "whatever day this moment falls on, locally" — or a local
 * date key, `YYYY-MM-DD`. The second form exists because a caller that has been *given*
 * a calendar date has no instant to convert, and inventing one is where this goes wrong:
 * picking midnight UTC lands in the previous day west of Greenwich, and picking noon
 * lands in the next one at UTC+13. A date key is used as what it is, with no instant in
 * the middle.
 *
 * Built by adding one to the local calendar day rather than 24 hours to the instant,
 * which is the difference that matters on a day a zone changes offset.
 */
export function localDayBounds(
  when: Date | string,
  timeZone: string,
): { start: Date; end: Date } {
  const { year, month, day } =
    typeof when === 'string' ? parseDateKey(when) : zonedParts(when, timeZone);
  return {
    start: localMidnight(year, month, day, timeZone),
    // `Date.UTC` rolls a day past the end of a month over for us, so day + 1 is safe on
    // the 28th of February as well as the 31st of January.
    end: localMidnight(year, month, day + 1, timeZone),
  };
}

/** `YYYY-MM-DD` into calendar parts. */
function parseDateKey(key: string): ZonedParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) throw new Error(`تاريخ غير صالح: ${key}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** The instant of local midnight starting the given local calendar date. */
function localMidnight(year: number, month: number, day: number, timeZone: string): Date {
  const naive = Date.UTC(year, month - 1, day);
  // The zone's offset is read at roughly the right instant and then applied. One
  // correction is enough for every zone whose offset moves by less than a day.
  const offset = zoneOffsetMs(new Date(naive), timeZone);
  return new Date(naive - offset);
}

/** A zone's UTC offset at an instant, in milliseconds. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const read = (type: string): number => {
    const found = parts.find((p) => p.type === type);
    if (!found) throw new Error(`تعذر حساب الوقت للمنطقة الزمنية ${timeZone}`);
    // `hour12: false` can render midnight as 24; Date.UTC handles the rollover.
    return Number.parseInt(found.value, 10);
  };

  return (
    Date.UTC(
      read('year'),
      read('month') - 1,
      read('day'),
      read('hour'),
      read('minute'),
      read('second'),
    ) - instant.getTime()
  );
}

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
