import { CalendarDays } from 'lucide-react';
import { locale } from '../lib/locale';
import { cn } from './ui';

/**
 * The reporting window (Stitch: «آخر 30 يوماً»).
 *
 * Overview and Reports both hardcoded `range=30d` while the API had accepted
 * `7d | 30d | 90d | 365d` since it was written — the control was the only missing
 * part, and a manager asking "how did last quarter go?" had no way to ask it.
 *
 * A segmented control rather than a date-range calendar, deliberately. The API takes
 * four fixed windows, so offering arbitrary dates would promise precision the server
 * does not have; four buttons also answer in one tap, which is how this screen is
 * actually used — glanced at, not studied.
 *
 * **365 days carries a warning in the code, not in the UI.** §12.23 recorded that
 * `getOverview` loads every transaction in the range and reduces in JavaScript,
 * because the timeseries buckets by the merchant's local day and SQLite cannot do
 * that without hardcoding an offset. Thirty days is a few thousand rows; a year is
 * closer to 180,000. It is acceptable at one supermarket's volume and it is the
 * reason the longest window exists at all rather than a free date range.
 */

export const REPORT_RANGES = ['7d', '30d', '90d', '365d'] as const;

export type ReportRange = (typeof REPORT_RANGES)[number];

export function RangePicker({
  value,
  onChange,
}: {
  value: ReportRange;
  onChange: (next: ReportRange) => void;
}) {
  return (
    <div
      className="flex items-center gap-1 rounded-md border border-border bg-surface p-1"
      role="group"
      aria-label={locale.range.label}
    >
      <CalendarDays size={16} className="mx-2 text-steel" aria-hidden />
      {REPORT_RANGES.map((range) => (
        <button
          key={range}
          type="button"
          onClick={() => onChange(range)}
          aria-pressed={range === value}
          className={cn(
            'rounded-sm px-3 py-2 text-sm transition-colors duration-fast',
            range === value
              ? 'bg-accent-tint font-semibold text-accent'
              : 'text-steel hover:bg-canvas hover:text-ink',
          )}
        >
          {locale.range.options[range]}
        </button>
      ))}
    </div>
  );
}
