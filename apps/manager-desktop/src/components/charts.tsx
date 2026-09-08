import { useId, useState, type ReactNode } from 'react';
import { BarChart3, CheckCircle2, Table2 } from 'lucide-react';
import { GLOW, VIZ } from '../lib/viz';
import { locale } from '../lib/locale';
import { cn, Skeleton } from './ui';

/** Grouped, so an ungrouped count never sits beside a grouped amount. */
const group = (value: number): string => new Intl.NumberFormat('en-US').format(value);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  CHART PRIMITIVES (2026-09-02)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Built here rather than reached for from Recharts for each screen, because the
 * rules that make these charts readable are not per-screen decisions and should not
 * be re-made per screen:
 *
 *  - **Every chart has a table view.** Not a nicety: the palette carries one
 *    contrast WARN (magenta at 2.69:1), and the relief for that is a channel that
 *    is not colour. It also answers "never carry meaning by colour alone" for a
 *    reader who simply prefers numbers.
 *  - **Every series is labelled where it is drawn.** A legend alone puts the
 *    identity a glance away from the mark.
 *  - **Every state is drawn in the same language** — empty, one point, long labels,
 *    huge values, gaps. A chart that only looks right with good data is a chart
 *    that will look broken on the day it matters.
 *
 * The bars are drawn as HTML rather than SVG. They are horizontal, RTL, and
 * label-bearing, and every attempt to get that out of a chart library ends in
 * fighting its text layout; a flex row with a percentage width is honest, styles
 * with the app's own tokens, and mirrors correctly for free.
 */

/* ── Frame ─────────────────────────────────────────────────────────────────── */

export interface ChartFrameProps {
  title: string;
  subtitle?: string;
  /**
   * Rendered when there is nothing to draw — its own sentence, never "no data".
   *
   * A node rather than a string, because "empty" is not always the same statement:
   * a panel that verified something and found nothing wrong should say so, and that
   * takes more than one line. `VerifiedEmpty` below is the affirmative variant.
   */
  empty?: ReactNode;
  isLoading?: boolean;
  /** True when the data loaded and contains nothing. */
  isEmpty?: boolean;
  /**
   * Held at reduced opacity during a refetch rather than replaced by a skeleton.
   * A skeleton flash on every range change is a layout jump the reader has to
   * re-anchor after.
   */
  isStale?: boolean;
  /** The same figures as a table. Always provided; the toggle is always offered. */
  table: ReactNode;
  /**
   * Rendered below whichever view is showing.
   *
   * For the figure that belongs *beside* a chart rather than in it — the attribution
   * rate under capture health, the settlement strategy under today's funnel. Putting
   * those in `children` made them vanish the moment the reader switched to the table,
   * which is the one view they most need a caption in.
   */
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function ChartFrame({
  title,
  subtitle,
  empty,
  isLoading = false,
  isEmpty = false,
  isStale = false,
  table,
  footer,
  children,
  className,
}: ChartFrameProps) {
  const [showTable, setShowTable] = useState(false);
  const headingId = useId();

  return (
    <section
      className={cn('rounded-lg border border-border bg-surface shadow-card', className)}
      aria-labelledby={headingId}
    >
      <header className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
        <div className="min-w-0">
          <h2 id={headingId} className="text-lg font-semibold text-ink">
            {title}
          </h2>
          {subtitle ? (
            <p className="mt-0.5 text-sm leading-relaxed text-steel">{subtitle}</p>
          ) : null}
        </div>

        {/* Offered on every chart, not only the ones that look hard to read. A
            reader who wants numbers should not have to work out which charts were
            judged to need the escape hatch. */}
        {!isLoading && !isEmpty ? (
          <button
            type="button"
            onClick={() => setShowTable((open) => !open)}
            aria-pressed={showTable}
            className="flex min-h-control shrink-0 items-center gap-2 rounded-md border border-border px-3 text-sm text-steel transition-colors duration-fast hover:bg-canvas hover:text-ink"
          >
            {showTable ? <BarChart3 size={16} aria-hidden /> : <Table2 size={16} aria-hidden />}
            {showTable ? locale.viz.showChart : locale.viz.showTable}
          </button>
        ) : null}
      </header>

      <div className="p-6">
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-4/5" />
            <Skeleton className="h-6 w-3/5" />
          </div>
        ) : isEmpty ? (
          // A string gets the standard treatment — flat grey rules where the bars
          // would be, then the sentence. Anything else takes the space over, because
          // a panel saying "checked, nothing wrong" must not sit under a skeleton
          // that reads as "no data".
          typeof empty === 'string' || empty === undefined ? (
            <EmptyChart message={empty ?? locale.viz.empty} />
          ) : (
            empty
          )
        ) : (
          <div className={cn('transition-opacity duration-normal', isStale && 'opacity-45')}>
            {showTable ? table : children}
            {footer}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * The empty state, in the same visual language as a populated chart.
 *
 * Three flat rules where the bars would be, and one sentence. Not "لا توجد بيانات":
 * an empty capture-health panel and an empty tier panel mean different things and
 * each caller says which.
 */
function EmptyChart({ message }: { message: ReactNode }) {
  return (
    <div className="py-2">
      {/*
        **Empty TRACKS, not grey bars — and the difference is the whole point.**

        These ghost rules used to be filled: `bg-border/60` and `bg-border/40` blocks
        at three decreasing widths. That is very close to what the loading branch
        directly above renders, and the only thing separating them was the skeleton's
        shimmer. In a screenshot the shimmer is not there, and the two states became
        indistinguishable — a reviewer reading the Reports page could not tell «لم
        تصدر قسائم اليوم» from a panel still waiting on the server, and reported it
        as a stuck skeleton.

        An outlined track reads as "a bar could be here and there isn't one", which
        is the actual statement. A filled one reads as "a bar is being drawn".
      */}
      <div className="space-y-3" aria-hidden>
        {[0.55, 0.35, 0.2].map((width) => (
          <div key={width} className="flex items-center gap-3">
            <div className="h-2 w-20 rounded-pill border border-dashed border-border-strong" />
            <div
              className="h-2 rounded-pill border border-dashed border-border-strong"
              style={{ width: `${width * 100}%` }}
            />
          </div>
        ))}
      </div>
      <p className="mt-5 text-base text-steel">{message}</p>
    </div>
  );
}

/**
 * "We checked, and there is nothing here" — as distinct from "there is nothing".
 *
 * A zero that was arrived at by measuring something is a different fact from a zero
 * that means nothing has happened yet, and a bare empty state collapses the two. The
 * denominator is what turns the first into a statement: *no sale was capped, out of
 * the 44 that earned a discount*. Without it the reader cannot tell a working
 * guardrail from a panel that is not wired up.
 *
 * Success tone, and it carries an icon **and** words — never colour alone.
 */
export function VerifiedEmpty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-success/20 bg-success-tint px-5 py-4">
      <CheckCircle2 size={20} aria-hidden className="mt-0.5 shrink-0 text-success" />
      <div>
        <p className="text-base font-semibold text-success">{title}</p>
        <p className="mt-1 text-sm leading-relaxed text-ink">{detail}</p>
      </div>
    </div>
  );
}

/* ── Horizontal bars ───────────────────────────────────────────────────────── */

export interface BarDatum {
  /** Stable identity. The colour is looked up from this, never from the index. */
  key: string;
  label: string;
  value: number;
  color: string;
  /** Rendered beside the value — a share, a currency, a count's unit. */
  note?: string;
  /** Overrides the printed value, for money and other formatted figures. */
  display?: string;
}

/**
 * A horizontal bar per row, scaled against the largest value present.
 *
 * Horizontal rather than vertical because the labels are Arabic words of very
 * different lengths — «مراقبة قائمة الطباعة» beside «جسر COM» — and a vertical
 * chart would either clip them or rotate them. Scaled against the widest bar rather
 * than a total, because the question these panels answer is "how do these compare",
 * and scaling to a total flattens every one of them when a single row dominates.
 */
export function BarRows({
  data,
  /** A one-point chart is drawn at its true share of the scale, never full width. */
  scaleTo,
  glow = true,
}: {
  data: readonly BarDatum[];
  scaleTo?: number;
  glow?: boolean;
}) {
  const widest = scaleTo ?? Math.max(...data.map((d) => d.value), 1);

  return (
    <ul className="space-y-4">
      {data.map((row) => {
        const pct = widest > 0 ? (row.value / widest) * 100 : 0;
        return (
          <li key={row.key}>
            <div className="mb-1.5 flex items-baseline justify-between gap-4">
              {/* The identity, in ink — never in the series colour. A coloured swatch
                  beside a label carries the identity; coloured text just makes the
                  text harder to read. */}
              <span className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                  style={{ backgroundColor: row.color }}
                />
                <span className="truncate text-base text-ink">{row.label}</span>
              </span>

              {/* The direct label. This is the relief channel the palette's contrast
                  WARN obligates, so it is present on every row without exception. */}
              <span className="flex shrink-0 items-baseline gap-2">
                <span className="amount text-base text-ink">{row.display ?? group(row.value)}</span>
                {row.note ? <span className="text-sm text-steel">{row.note}</span> : null}
              </span>
            </div>

            {/* The track is the canvas colour, so the 2px separation between a bar
                and what surrounds it is surface rather than a drawn border. */}
            <div className="h-2.5 w-full overflow-hidden rounded-pill bg-canvas">
              <div
                className="h-full rounded-pill transition-[width] duration-normal ease-native motion-reduce:transition-none"
                style={{
                  width: `${Math.max(pct, row.value > 0 ? 2 : 0)}%`,
                  backgroundColor: row.color,
                  // The glow: a shadow cast beneath the bar, tinted with its own hue.
                  // It never touches the fill, so the validated contrast stands.
                  boxShadow: glow
                    ? `0 1px 2px rgba(17,24,39,0.16), 0 6px 14px -6px ${row.color}80`
                    : undefined,
                }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The table twin of `BarRows`.
 *
 * Identical figures, no colour needed to read it. `tabular-nums` here and not on the
 * hero figures: this is exactly the case for it — numbers aligning down a column.
 */
export function BarTable({
  data,
  valueHeader,
  labelHeader,
}: {
  data: readonly BarDatum[];
  labelHeader: string;
  valueHeader: string;
}) {
  return (
    <table className="w-full text-start">
      <thead>
        <tr className="border-b border-border text-sm text-steel">
          <th className="py-2 text-start font-medium">{labelHeader}</th>
          <th className="py-2 text-start font-medium">{valueHeader}</th>
        </tr>
      </thead>
      <tbody>
        {data.map((row) => (
          <tr key={row.key} className="border-b border-border last:border-0">
            <td className="py-2.5 text-base text-ink">{row.label}</td>
            <td className="py-2.5">
              <span className="amount text-base text-ink">{row.display ?? group(row.value)}</span>
              {row.note ? <span className="ms-2 text-sm text-steel">{row.note}</span> : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ── Funnel ────────────────────────────────────────────────────────────────── */

export interface FunnelStep {
  key: string;
  label: string;
  value: number;
  display?: string;
  color: string;
  /** Said in words, so the drop between stages is not inferred from two widths. */
  note?: string;
}

/**
 * An ordered set of stages, each a share of the first.
 *
 * Ordinal by construction — issued, then redeemed, then outstanding — so the colour
 * is one hue getting darker rather than five identities. Scaled to the FIRST stage,
 * not the largest, because that is what makes a funnel a funnel: every bar is read
 * as a fraction of the top.
 */
export function Funnel({ steps }: { steps: readonly FunnelStep[] }) {
  const top = steps[0]?.value ?? 0;

  return (
    <ol className="space-y-4">
      {steps.map((step) => {
        const pct = top > 0 ? (step.value / top) * 100 : 0;
        return (
          <li key={step.key}>
            <div className="mb-1.5 flex items-baseline justify-between gap-4">
              <span className="text-base text-ink">{step.label}</span>
              <span className="flex items-baseline gap-2">
                <span className="amount text-base text-ink">{step.display ?? group(step.value)}</span>
                {step.note ? <span className="text-sm text-steel">{step.note}</span> : null}
              </span>
            </div>
            <div className="h-3 w-full overflow-hidden rounded-pill bg-canvas">
              <div
                className="h-full rounded-pill transition-[width] duration-normal ease-native motion-reduce:transition-none"
                style={{
                  width: `${Math.max(pct, step.value > 0 ? 2 : 0)}%`,
                  backgroundColor: step.color,
                  boxShadow: `0 1px 2px rgba(17,24,39,0.16), 0 6px 14px -6px ${step.color}80`,
                }}
              />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* ── The shared SVG filter ─────────────────────────────────────────────────── */

/**
 * The drop shadow Recharts marks use, defined once per page.
 *
 * HTML bars get their glow from `box-shadow`; an SVG mark cannot, so the same
 * effect is expressed as a filter and referenced by id. Kept in one place so the
 * two never drift into looking like different products.
 */
export function VizDefs() {
  return (
    <svg width="0" height="0" aria-hidden focusable="false" className="absolute">
      <defs>
        <filter id={GLOW.id} x="-25%" y="-25%" width="150%" height="150%">
          <feDropShadow
            dx={GLOW.shadow.dx}
            dy={GLOW.shadow.dy}
            stdDeviation={GLOW.shadow.stdDeviation}
            floodColor={GLOW.shadow.flood}
          />
        </filter>
      </defs>
    </svg>
  );
}

export { VIZ };
