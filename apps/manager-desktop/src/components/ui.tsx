import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { ReactNode } from 'react';

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
  children,
  className,
}: {
  tone?: ChipTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-pill px-3 py-1 text-sm font-medium',
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
      {children}
    </span>
  );
}

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

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <header className="mb-6 flex items-start justify-between gap-6">
      <div>
        <h1 className="text-2xl font-bold text-ink">{title}</h1>
        {subtitle ? <p className="mt-1 text-base leading-relaxed text-steel">{subtitle}</p> : null}
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
