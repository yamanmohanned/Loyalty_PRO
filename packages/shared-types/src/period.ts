/**
 * Local-calendar arithmetic.
 *
 * ## What this module used to be, and what happened to it
 *
 * Until v4 this file also owned **period keys** — `computePeriodKey`, `PeriodKey`,
 * `PeriodKeySchema` and the ISO-week arithmetic behind them — because a discount was
 * earned by cumulative spend inside a fixed calendar window, and every transaction
 * carried the key of the window it counted toward.
 *
 * v4 decides the discount from the invoice amount alone (docs/legacy/CLAUDE_UPDATE_4.md §1.1), so
 * there is no window for spend to accumulate over. All of that is **deleted, not
 * deprecated** (§10.6): reporting windows come from `ReportRange`, and a per-customer
 * figure is now a lifetime total that no calendar bounds.
 *
 * ## What survives, and why it had to
 *
 * The timezone half. **A day boundary is local, never UTC**, and that is not a
 * leftover of the period model — it is the fix for a real bug (§12.23). Baghdad is
 * UTC+3, so a UTC day begins at 03:00 local and a voucher issued before then was being
 * filed under the previous day. End-of-day reconciliation that disagrees with the cash
 * drawer by one day of vouchers is worse than no report at all: it sends somebody
 * looking for a theft that did not happen.
 *
 * `voucher.service.ts` depends on `localDayBounds` and `localDateKey` for exactly that.
 * Deleting this module wholesale along with the period model would have quietly
 * reopened §12.23.
 *
 * Timestamps are still *stored* in UTC (CLAUDE.md §4.2). Only the bucketing is local.
 */

export const DEFAULT_MERCHANT_TIMEZONE = 'Asia/Baghdad';

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
