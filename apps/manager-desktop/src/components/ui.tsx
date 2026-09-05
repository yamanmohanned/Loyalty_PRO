import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { ReactNode } from 'react';
import { AlertTriangle, type LucideIcon } from 'lucide-react';
import { locale } from '../lib/locale';

/**
 * UI primitives, built to the design system in CLAUDE.md §6.4.
 *
 * Deliberately hand-written rather than pulled from shadcn/ui: the token set is
 * specific (one accent, semantic colours for status only), the anti-patterns list
 * is strict (no circular spinners, no glow, no emoji), and a generic component
 * library would need overriding on nearly every prop anyway.
 *
 * Every horizontal utility here is **logical** (ps/pe/ms/me/start/end) so the whole
 * app mirrors under `dir="rtl"` without a second stylesheet.
 */

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

/* ── Button ────────────────────────────────────────────────────────────────── */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  variant = 'primary',
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      className={cn(
        // Flat, no glow, 1px press-down, 48px minimum (§6.4).
        'inline-flex min-h-control items-center justify-center gap-2 rounded-md px-4 text-base font-semibold',
        'transition-[transform,background-color,border-color] duration-fast ease-native',
        'active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 disabled:active:translate-y-0',
        variant === 'primary' && 'bg-accent text-white hover:bg-[#0c5c48]',
        variant === 'secondary' && 'border border-border bg-surface text-ink hover:bg-canvas',
        variant === 'ghost' && 'text-steel hover:bg-canvas hover:text-ink',
        variant === 'danger' && 'bg-danger text-white hover:bg-[#9a2b28]',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/* ── Field ─────────────────────────────────────────────────────────────────── */

/** Label ABOVE, helper/error BELOW — never placeholder-only (§6.4). */
export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn('block', className)}>
      <span className="mb-1 block text-sm font-medium text-ink">{label}</span>
      {children}
      {error ? (
        <span className="mt-1 block text-sm text-danger">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-sm leading-relaxed text-steel">{hint}</span>
      ) : null}
    </label>
  );
}

export function Input({
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'block min-h-control w-full rounded-md border border-border bg-surface px-3 text-base text-ink',
        'placeholder:text-steel/70 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30',
        'disabled:bg-canvas disabled:text-steel',
        className,
      )}
      {...props}
    />
  );
}

/** Oversized monospace with the currency pinned inside (§6.4). */
export function AmountInput({
  className,
  suffix = 'د.ع',
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { suffix?: string }) {
  return (
    <div className="relative">
      <input
        inputMode="numeric"
        className={cn(
          'block min-h-control w-full rounded-md border border-border bg-surface ps-3 pe-14',
          'font-mono text-lg font-bold tabular-nums text-ink',
          'focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30',
          className,
        )}
        {...props}
      />
      <span className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-sm font-medium text-steel">
        {suffix}
      </span>
    </div>
  );
}

export function Select({
  className,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'block min-h-control w-full rounded-md border border-border bg-surface px-3 text-base text-ink',
        'focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}

/* ── Card ──────────────────────────────────────────────────────────────────── */

export function Card({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('rounded-lg border border-border bg-surface shadow-card', className)}>
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
      <div>
        <h2 className="text-lg font-semibold text-ink">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-sm leading-relaxed text-steel">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  );
}

/* ── Status chip ───────────────────────────────────────────────────────────── */

type ChipTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

/** Pill, tinted background, text in the darker stop. Never black on a colour (§6.4). */
export function Chip({
  tone = 'neutral',
  dot = false,
  children,
  className,
}: {
  tone?: ChipTone;
  /**
   * A small filled dot before the label — the reference's status-chip treatment.
   *
   * **Reinforcement, never the signal.** The word is still there and still carries
   * the meaning; the dot only makes a column of chips scannable without reading each
   * one. §2.3: never meaning by colour alone. `aria-hidden`, because a screen reader
   * that announced it would be announcing a decoration.
   */
  dot?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-pill px-3 py-1 text-sm font-medium',
        tone === 'neutral' && 'bg-canvas text-steel',
        tone === 'accent' && 'bg-accent-tint text-accent',
        tone === 'success' && 'bg-success-tint text-success',
        // Ink rather than amber, and only for this tone. §6.2 describes a chip as a
        // tinted ground with "text in its darkest stop" — but the palette has ONE
        // stop per semantic, and amber #B26B00 on amber-tint #FDF3E3 measures
        // **3.82:1** against a 4.5 floor. Every other tone clears it; amber is the
        // one whose single token is too light against its own tint, so ink is the
        // darkest stop actually available. The tinted ground still carries the tone.
        tone === 'warning' && 'bg-amber-tint text-ink',
        tone === 'danger' && 'bg-danger-tint text-danger',
        className,
      )}
    >
      {dot ? (
        <span
          className={cn(
            'size-1.5 shrink-0 rounded-pill',
            tone === 'neutral' && 'bg-steel',
            tone === 'accent' && 'bg-accent',
            tone === 'success' && 'bg-success',
            tone === 'warning' && 'bg-amber',
            tone === 'danger' && 'bg-danger',
          )}
          aria-hidden
        />
      ) : null}
      {children}
    </span>
  );
}

/* ── Stat tile ─────────────────────────────────────────────────────────────── */

/**
 * One headline figure, in the shape `dashboard.png` and `customers.png` both use.
 *
 * **Shared rather than copied.** Overview and Reports each had their own tile with
 * its own padding and its own type scale, which is how two screens in one product end
 * up not looking like one product — and it is the §12.27 duplication argument applied
 * to styling instead of to data.
 *
 * **Taken from the reference:** the tinted rounded icon square, the hard jump from a
 * small quiet label to a dominant figure, and a supporting line beneath.
 *
 * **Refused: the sparkline and the "+18٪ عن الفترة السابقة" delta** that sit in every
 * one of the reference's tiles. There is no per-KPI series and no prior-period
 * comparison anywhere in our reports, and a delta is exactly the figure that would
 * have to be invented to fill a shape. A fabricated percentage is indistinguishable
 * from a real one — that is what makes it worse than an empty space, not merely
 * dishonest.
 *
 * **The figure has its own full-width row, which is a fix rather than a preference.**
 * With the icon and the label sharing its line there were about 161 px for it in a
 * four-across grid, and `1,062,000 د.ع` needs about 181; it overflowed the card in
 * the seed data. Given the row it has 217 px, which also holds the largest value
 * these screens can produce (§6.5: no horizontal overflow).
 *
 * The icon is `aria-hidden` — the label carries the meaning, so nothing is signalled
 * by the glyph alone.
 */
export function StatTile({
  icon: Icon,
  label,
  value,
  money,
  hint,
  loading = false,
  stale = false,
  tone = 'neutral',
}: {
  icon?: LucideIcon;
  label: string;
  value?: string | number | null;
  money?: number;
  hint?: string;
  loading?: boolean;
  /** Dimmed while a refetch is in flight, so a figure is never silently out of date. */
  stale?: boolean;
  tone?: 'neutral' | 'accent' | 'warning';
}) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-[13px] leading-tight text-steel">{label}</p>
        {Icon ? (
          <span
            className={cn(
              'flex size-11 shrink-0 items-center justify-center rounded-xl',
              tone === 'warning' ? 'bg-amber-tint text-amber' : 'bg-accent-tint text-accent',
            )}
          >
            <Icon size={22} aria-hidden />
          </span>
        ) : null}
      </div>

      <div
        className={cn('mt-2 transition-opacity duration-base', stale && 'opacity-45')}
      >
        {loading ? (
          <Skeleton className="h-8 w-28" />
        ) : money !== undefined ? (
          <Money value={money} className="text-[1.75rem] leading-none" />
        ) : (
          <p
            className={cn(
              'amount text-[1.75rem] leading-none',
              tone === 'warning' ? 'text-amber' : tone === 'accent' ? 'text-accent' : 'text-ink',
            )}
          >
            {value ?? '—'}
          </p>
        )}
      </div>

      {hint ? <p className="mt-2 text-[13px] leading-relaxed text-steel">{hint}</p> : null}
    </Card>
  );
}

/* ── Monogram ──────────────────────────────────────────────────────────────── */

/**
 * The reference's avatar circle, with the photo taken out of it.
 *
 * `dashboard.png` and `customers.png` both put a round avatar beside every person —
 * a ranked list row, a table row, the user card in the rail. The **treatment** is
 * worth having: it gives a list of names a left-edge rhythm and makes a row findable
 * by shape before it is readable by text. The **photograph** is refused, and not on
 * taste: we hold no customer images, §0.4 keeps stored data minimal, and adding an
 * upload to satisfy a circle would be building a feature to fill a shape.
 *
 * So the circle is drawn from the first character of a name we already have.
 *
 * White on `accent` measures **6.20:1**, computed from the painted colours
 * (#FFFFFF on #0F6E56) rather than assumed.
 */
export function Monogram({
  name,
  size = 'md',
  className,
}: {
  name: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const initial = name.trim().charAt(0) || '؟';
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-pill bg-accent font-display font-bold text-white',
        size === 'sm' ? 'size-8 text-sm' : 'size-10 text-base',
        className,
      )}
      aria-hidden
    >
      {initial}
    </span>
  );
}

/* ── Table recipes ─────────────────────────────────────────────────────────── */

/*
 * Class recipes rather than <Table> components.
 *
 * Six screens already own their own `<table>`, each with its own column set, its own
 * cell contents and its own comments about why a particular cell is the way it is.
 * Wrapping those in generic components would either flatten that detail or need a
 * prop per exception. Recipes lift every table to the same styling in one edit and
 * leave the markup where its reasons live.
 *
 * What they take from the reference: a header row on the canvas tint rather than on
 * white, so the head reads as a boundary instead of as a first row; header labels a
 * step smaller and quieter than the body; and taller rows — the reference's tables
 * breathe, and ours were tight enough that a name and its phone number ran together.
 */

/**
 * `<thead>`'s row: tinted ground, quiet labels.
 *
 * **Measured on the surface it renders on, not assumed (§12.34):** `steel` #6B7280 on
 * `canvas` #F7F8FA is **4.55:1** at 13px — a pass, read out of the running app rather
 * than inferred. It is a pass by 0.05, which is the margin §12.34 exists to flag: if
 * this row's ground ever moves off `canvas`, the number has to be taken again before
 * the class is reused.
 */
export const tableHeadRow =
  'border-b border-border bg-canvas text-[13px] font-medium text-steel';

/** A `<th>`. Start-aligned, since RTL start is the right edge. */
export const th = 'px-6 py-3 text-start font-medium';

/** A `<td>`. */
export const td = 'px-6 py-4 align-middle';

/** A `<tr>` in the body: separated, and lit on hover so the row under the cursor is
 *  unambiguous when a table is this wide. */
export const tableRow =
  'border-b border-border last:border-0 transition-colors duration-fast hover:bg-canvas';

/* ── Loading and empty states ──────────────────────────────────────────────── */

/**
 * Skeletal shimmer matching the layout it replaces. Circular spinners are banned
 * (§6.4) — a spinner tells you nothing is ready, a skeleton tells you what is coming.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn('relative overflow-hidden rounded-md bg-canvas', className)}>
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-l from-transparent via-white/60 to-transparent" />
    </div>
  );
}

export function SkeletonTable({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className="space-y-2 p-6">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-4">
          {Array.from({ length: columns }, (_, c) => (
            <Skeleton key={c} className={cn('h-6 flex-1', c === 0 && 'flex-[2]')} />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Composed empty state — an illustration, one line, one action. Never a bare
 * "no data" (§6.4).
 */
export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      {icon ? (
        <div className="flex h-14 w-14 items-center justify-center rounded-pill bg-canvas text-steel">
          {icon}
        </div>
      ) : null}
      <p className="text-base font-semibold text-ink">{title}</p>
      {body ? <p className="max-w-sm text-sm leading-relaxed text-steel">{body}</p> : null}
      {action}
    </div>
  );
}

/**
 * The state a screen shows when its data could not be fetched.
 *
 * **Its absence was a defect on five screens.** Each one branched on `isLoading` and
 * then fell back to a skeleton or to nothing at all, so a dead backend rendered as a
 * shimmer that never resolved. That is worse than an error: a merchant watching a
 * skeleton concludes the machine is slow and waits, where an error tells them the
 * service is down and gives them the retry. The screens were not crashing, so nothing
 * in a healthy-API sweep could have found it — which is §12.20's point, applied to a
 * condition rather than to a rendering.
 *
 * `errorBody` names the actual first suspect ("تحقّق من الاتصال بالخادم"), because on
 * this product the overwhelmingly likely cause is that the API on the manager PC has
 * not started yet.
 */
export function ErrorState({ onRetry }: { onRetry?: () => void }) {
  return (
    <EmptyState
      icon={<AlertTriangle size={22} aria-hidden />}
      title={locale.common.error}
      body={locale.common.errorBody}
      action={
        onRetry ? (
          <Button variant="ghost" onClick={onRetry}>
            {locale.common.retry}
          </Button>
        ) : undefined
      }
    />
  );
}

/* ── Notices ───────────────────────────────────────────────────────────────── */

/**
 * A notice that carries meaning, not decoration. `warning` and `danger` are used
 * only where money or data is genuinely at risk — the margin warning and the
 * single-machine backup risk.
 */
export function Notice({
  tone = 'neutral',
  title,
  children,
}: {
  tone?: 'neutral' | 'accent' | 'warning' | 'danger';
  title?: string;
  children: ReactNode;
}) {
  return (
    <div
      /*
        **The text is ink on every tone, and the tone is carried by the ground and
        the start-border instead.**

        It used to be the semantic colour on that colour's tint — which §6.2
        describes for a *chip*, where the text is a word or two at chip weight. On a
        sentence at 14px it fails: amber #B26B00 on amber-tint #FDF3E3 measures
        **3.82:1** against a 4.5 floor, and neutral's `text-steel` on canvas is 4.55,
        which is passing by 0.05 and fails the moment the surface changes (§12.34's
        scoping note, which this is the second instance of).

        Meaning is still not carried by colour alone (§2.3): the 4px start-border and
        the tinted ground both change with the tone, and every Notice that matters
        also has a title. What changes is that the words are legible.
      */
      className={cn(
        'rounded-md border-s-4 px-4 py-3 text-sm leading-relaxed text-ink',
        tone === 'neutral' && 'border-s-border bg-canvas',
        tone === 'accent' && 'border-s-accent bg-accent-tint',
        tone === 'warning' && 'border-s-amber bg-amber-tint',
        tone === 'danger' && 'border-s-danger bg-danger-tint',
      )}
    >
      {title ? <p className="mb-1 font-semibold">{title}</p> : null}
      {children}
    </div>
  );
}

/* ── Page scaffolding ──────────────────────────────────────────────────────── */

/**
 * The page title block.
 *
 * The tinted rounded square beside the title is the reference's treatment on every
 * screen, and it is worth taking: it gives each page a fixed visual anchor at the
 * start edge, so the eye lands in the same place after a nav change. It is
 * decorative — `aria-hidden`, with the title carrying the meaning — and it stays on
 * the one accent rather than the reference's per-page hue, because §6.2 gives this
 * product one accent and colour-as-decoration is exactly what it rules out.
 */
export function PageHeader({
  title,
  subtitle,
  icon,
  lead,
  action,
}: {
  title: string;
  subtitle?: string;
  /** A lucide glyph. Wrapped in the tinted square. */
  icon?: ReactNode;
  /**
   * An element that brings its own ground — a `Monogram` on a person's page. Rendered
   * bare, since wrapping a filled circle in a tinted square gives two rings.
   */
  lead?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="mb-6 flex items-start justify-between gap-6">
      <div className="flex items-start gap-4">
        {lead}
        {icon ? (
          <span
            className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-accent-tint text-accent"
            aria-hidden
          >
            {icon}
          </span>
        ) : null}
        <div>
          <h1 className="text-2xl font-bold leading-tight text-ink">{title}</h1>
          {subtitle ? (
            <p className="mt-1.5 text-base leading-relaxed text-steel">{subtitle}</p>
          ) : null}
        </div>
      </div>
      {action}
    </header>
  );
}

/** Money is always monospace so digits align down a column (§6.3). */
export function Money({ value, className }: { value: number; className?: string }) {
  return (
    <span className={cn('amount selectable', className)}>
      {new Intl.NumberFormat('en-US').format(value)}
      {/* The unit is part of the figure, not a caption about it — so it carries its
          hierarchy by SIZE and WEIGHT rather than by colour. It was `text-steel`,
          which measured **4.24:1** at 13px against a 4.5 floor on the surfaces this
          actually renders on: a real failure, found by computing contrast from the
          painted colours rather than trusting that steel passes because §12.34 says
          it does on canvas. §2.3 — contrast and legibility beat effects. */}
      <span className="ms-1 text-xs font-normal text-ink">د.ع</span>
    </span>
  );
}
