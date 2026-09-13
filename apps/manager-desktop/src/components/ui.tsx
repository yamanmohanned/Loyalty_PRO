import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { createContext, useContext, useId, type ReactElement, type ReactNode } from 'react';
import { AlertTriangle, Minus, TrendingDown, TrendingUp, type LucideIcon } from 'lucide-react';
import { describeFailure } from '../lib/failure';
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

/**
 * The button's classes, without the button.
 *
 * Extracted so a `<Link>` that has to LOOK like a primary action can wear the exact
 * same treatment instead of a hand-copied approximation that drifts the first time
 * the hover state changes. A navigation is an anchor and an action is a button — the
 * two must not be swapped for the sake of styling, which is what this exists to
 * prevent.
 */
export function buttonClass(variant: ButtonVariant = 'primary', className?: string) {
  return cn(
    // Flat, no glow, 1px press-down, 48px minimum (§6.4).
    'inline-flex min-h-control items-center justify-center gap-2 rounded-md px-4 text-base font-semibold',
    'transition-[transform,background-color,border-color] duration-fast ease-native',
    'active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 disabled:active:translate-y-0',
    /*
      A vertical gradient in ONE hue, not a flat fill.

      `login.png`'s primary button is darker at the bottom than the top, and that
      is what gives it weight next to the flat fields it sits under. It is depth,
      not decoration: both stops are the brand accent, so the button is still one
      colour, and §6.4's "flat, no glow" is about the neon rim the reference also
      draws — which is refused (§11 bans it by name).

      The top stop is `accent` itself, so every contrast figure already measured
      against #0F6E56 still holds at the lightest point of the fill.
    */
    variant === 'primary' &&
      'bg-gradient-to-b from-accent to-[#0B5A46] text-white hover:from-[#0d6650] hover:to-[#094a3a]',
    /*
      An accent-TINTED border, not a neutral one.

      `login.png`'s secondary button is outlined in rgb(147,173,163) — a green-grey,
      plainly not the same token as its field borders. That tint is what stops the
      two stacked full-width buttons from reading as a pair of equals: one is
      filled and one is outlined, but both belong to the brand.

      `accent/40` lands on rgb(159,197,187) over white — the red channel matches the
      reference exactly, green and blue sit a little lighter. Approximated rather
      than hard-coded, so it tracks the accent if the brand colour ever moves.
    */
    variant === 'secondary' &&
      'border border-accent/40 bg-surface text-ink hover:border-accent/70 hover:bg-accent-tint/40',
    variant === 'ghost' && 'text-steel hover:bg-canvas hover:text-ink',
    variant === 'danger' && 'bg-danger text-white hover:bg-[#9a2b28]',
    className,
  );
}

export function Button({
  variant = 'primary',
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button className={buttonClass(variant, className)} {...props}>
      {children}
    </button>
  );
}

/* ── Field ─────────────────────────────────────────────────────────────────── */

/**
 * What a `Field` tells the control inside it.
 *
 * The error message was rendered *beside* the input and never reached it: a field in
 * the wrong state showed red words underneath and a perfectly normal border, and
 * nothing in the accessibility tree said the value was rejected. A control cannot
 * read the props of the wrapper it happens to be nested in, so the wrapper has to
 * hand the fact down — one boolean, through context, rather than an `invalid` prop
 * that every call site would have to remember to keep in step with `error`.
 *
 * The default is the honest one for a control rendered outside any `Field`: not
 * invalid, because nobody said it was.
 */
const FieldContext = createContext<{ invalid: boolean }>({ invalid: false });

/**
 * Label ABOVE, helper/error BELOW — never placeholder-only (§6.4).
 *
 * ── `required` says so before the button is pressed ──────────────────────────
 *
 * A merchant filled in what he could reach on an unscrollable setup form, pressed the
 * button, and was told his data was wrong. Two things had to change for that not to
 * happen again, and this is the first: a field that must be filled says so while he is
 * looking at it, in a word rather than an asterisk nobody has explained.
 *
 * `hint` is the other half — the rule, under the field, before it is broken. Both are
 * the same argument: a form that states its requirements only in a refusal is a form
 * that refuses first and explains second.
 */
export function Field({
  label,
  hint,
  error,
  required,
  children,
  className,
}: {
  label: string;
  hint?: string;
  error?: string;
  /** Renders «مطلوب» beside the label. Not the HTML attribute — see `Input`. */
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <FieldContext.Provider value={{ invalid: Boolean(error) }}>
      <label className={cn('block', className)}>
        {/* 12px to the input (reference: 11px, snapped to the 4px rhythm of §6.5),
            and the label at 15px — `login.png`'s label is the same size as its body
            text, not a step down from it. */}
        <span className="mb-3 flex items-baseline gap-2 text-[0.9375rem] font-medium text-ink">
          {label}
          {/* A word, not a `*`. The asterisk convention needs a legend somewhere on
              the page to be readable, every form that uses it forgets the legend, and
              a shop owner has never been told what it means. */}
          {required ? (
            <span className="text-xs font-normal text-steel">{locale.common.requiredMark}</span>
          ) : null}
        </span>
        {children}
        {/*
          8px below, not 4.

          The label sits 12px above the control and the helper sat 4px below it, so
          the two lines that belong to the same field were spaced unequally and the
          helper read as if it belonged to whatever came next. 8px is the §6.5 step
          under 12 and puts the pair inside one visual group. The error occupies the
          same slot as the hint by construction — one message position per field,
          which is what stops a screen from having three of them (§6.4).
        */}
        {error ? (
          <span className="mt-2 block text-sm text-danger">{error}</span>
        ) : hint ? (
          <span className="mt-2 block text-sm leading-relaxed text-steel">{hint}</span>
        ) : null}
      </label>
    </FieldContext.Provider>
  );
}

/* ── The control shell ─────────────────────────────────────────────────────── */

/*
 * ONE box, shared by every text control, and its decorations are LAID OUT rather
 * than positioned.
 *
 * ── The bug this replaces ────────────────────────────────────────────────────
 *
 * The old shell was `position: relative` with the glyph pinned by *logical* insets
 * (`end-4`, `start-1.5`) and its space reserved by *logical* padding (`pe-12`,
 * `ps-12`) on the `<input>`. Those two utilities look like they belong to the same
 * axis. They do not: a logical property resolves against the direction of the
 * element it is written on, the insets were on a wrapper inheriting the page's
 * `dir="rtl"`, and the padding was on an input the caller had marked `dir="ltr"`
 * because its content is Latin or numeric. So the component held **two direction
 * frames pointing opposite ways**, and the padding was reserved on the side the
 * glyph was not on.
 *
 * Measured in the running app before the change:
 *
 *   | field                | glyph occupies      | padding reserved     | result   |
 *   |----------------------|---------------------|----------------------|----------|
 *   | Login username       | left 16 → 35        | left 18, right 48    | 17px over |
 *   | Login password lock  | left 16 → 35        | left 48, right 48    | ok by luck |
 *   | Login reveal button  | right 6 → 50        | right 48             | 2px over  |
 *   | Setup server URL     | left 16 → 34        | left 18, right 48    | 16px over |
 *   | Customers phone      | right 12 → 30       | left 40, right 18    | 12px over |
 *   | AmountInput, dir=ltr | left 12 → 31.5      | left 12, right 56    | 19.5px over |
 *
 * ── Why a flex row and not corrected insets ──────────────────────────────────
 *
 * Correcting the numbers — flipping `pe-12` to `ps-12` when the input's `dir`
 * disagrees with the page's, or deriving physical `left`/`right` from the input's
 * direction — leaves the component reasoning about two coordinate systems, which is
 * the thing that produced the bug. It also leaves the reservation a *guess*: `ps-12`
 * reserved 48px for a control that occupies 50, which is how a 44px button ended up
 * 2px under the text with its whole hit area over it.
 *
 * As a flex row there is no reservation and no arithmetic. The decorations are
 * siblings of the input, so the input's box **cannot** extend under them — the
 * layout enforces what the padding was trying to promise. And the input's `dir`
 * goes back to meaning only what `dir` means: the direction of the text inside that
 * one element. It cannot move anything, so it cannot move anything to the wrong
 * place.
 *
 * The row's own order still follows the page (`ps`/`pe` here and the flex order both
 * resolve against this wrapper's direction, which is the document's), so the glyph
 * stays at the END edge and the control at the START edge exactly as `login.png`
 * draws them, whatever the input's `dir` says.
 *
 * ── The numbers, and where they came from ────────────────────────────────────
 *
 * `pe-4` + `gap-3` puts a 19px glyph at 16 → 35 from the end edge and stops the text
 * at 47 — the geometry the reference has and the old code reached only when the two
 * frames happened to agree. `ps-1.5` + `gap-3` seats the 44px reveal button at
 * 6 → 50 and starts the text at 62, so the button's hit area is now entirely its
 * own. With no decoration on a side, that side is the reference's plain 18px.
 */
function controlShell({
  icon,
  adornment,
  invalid,
  disabled,
}: {
  icon?: boolean;
  adornment?: boolean;
  invalid?: boolean;
  disabled?: boolean | undefined;
}) {
  return cn(
    // 56px tall, 12px radius — the reference's fields measure 58 × 12.
    // `border-strong` rather than `border`: an input's edge is a target, not a seam.
    'flex min-h-field w-full items-stretch gap-3 rounded-md border bg-surface',
    'transition-[border-color,box-shadow] duration-fast ease-native',
    adornment ? 'ps-1.5' : 'ps-[18px]',
    icon ? 'pe-4' : 'pe-[18px]',
    invalid ? 'border-danger' : 'border-border-strong',
    // Hover is a live-target signal, so it is withheld from a control that is not a
    // live target and from one already shouting in red.
    !disabled && !invalid && 'hover:border-[rgba(17,24,39,0.2)]',
    /*
      Focus: the border goes accent AND a soft ring appears outside it. Two channels,
      because a border colour alone is a colour-only signal.

      `/20`, not an arbitrary fraction. Tailwind only generates opacity modifiers for
      values on its scale (…,10,20,25,30,40,…); `ring-accent/12` and `border-accent/45`
      both compiled to NOTHING and the states were silently absent — found by reading
      the generated rules out of `document.styleSheets`, not by looking at the class.

      `focus-within` rather than `focus`, because the focusable element is now a child
      of the box being lit.
    */
    invalid
      ? 'focus-within:border-danger focus-within:ring-4 focus-within:ring-danger/20'
      : 'focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/20',
    disabled && 'bg-canvas',
  );
}

/**
 * The `<input>` inside the shell.
 *
 * Zero horizontal padding and no box of its own: the shell owns the border, the
 * ground and the spacing, so a decorated field and a bare one are the same object.
 *
 * `focus-visible:ring-0` cancels the global `:focus-visible` ring from `globals.css`
 * on this element only. That rule is right for a button and wrong here — it would
 * draw a second, offset ring *inside* the ring the shell already draws.
 */
const controlText = cn(
  'h-auto w-full min-w-0 flex-1 bg-transparent px-0 text-base text-ink',
  'placeholder:text-steel/70',
  'focus:outline-none focus-visible:ring-0 focus-visible:ring-offset-0',
  'disabled:cursor-not-allowed disabled:text-steel',
);

/**
 * A text field.
 *
 * **`icon` is the reference's treatment and it is taken.** `login.png` seats a glyph
 * inside each field at the END edge, which does two things worth having: it makes a
 * stack of identical boxes tell itself apart at a glance, and it gives the field a
 * visual weight the bare 1px outline did not have. `aria-hidden`, because the label
 * above already says what the field is — nothing is signalled by the glyph alone.
 *
 * `adornment` is the start-edge slot, for a control rather than a decoration.
 *
 * Both slots are flex siblings of the input — see `controlShell` for why that is the
 * fix and not a style.
 */
export function Input({
  className,
  icon,
  adornment,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  icon?: ReactNode;
  adornment?: ReactNode;
}) {
  const { invalid } = useContext(FieldContext);

  return (
    <div
      className={controlShell({
        icon: Boolean(icon),
        adornment: Boolean(adornment),
        invalid,
        disabled: props.disabled,
      })}
    >
      {adornment ? <span className="flex shrink-0 items-center">{adornment}</span> : null}
      <input
        aria-invalid={invalid || undefined}
        className={cn(controlText, className)}
        {...props}
      />
      {icon ? (
        <span className="pointer-events-none flex shrink-0 items-center text-steel" aria-hidden>
          {icon}
        </span>
      ) : null}
    </div>
  );
}

/**
 * A rule with a word set into it — `login.png`'s separator between the primary action
 * and the secondary path below it.
 *
 * It exists because the reference's two full-width buttons need something between them
 * to stop reading as a pair of equals; the word is what says one of these is the way
 * out, not the other way in.
 */
export function Divider({ label }: { label?: string }) {
  if (!label) return <hr className="border-0 border-t border-border" />;
  return (
    <div className="flex items-center gap-4" role="separator">
      <span className="h-px flex-1 bg-border-strong" />
      <span className="text-sm text-steel">{label}</span>
      <span className="h-px flex-1 bg-border-strong" />
    </div>
  );
}

/**
 * Oversized monospace with the currency pinned inside (§6.4).
 *
 * **The same shell as `Input`, and that is the point.** It used to carry its own
 * copy: a 48px box where a field is 56, `border-border` where a field uses
 * `border-border-strong`, a 2px focus ring at `/30` where a field draws 4 at `/20`,
 * and no hover or disabled state at all. Two controls sitting in the same row of the
 * same form disagreed about how tall a field is and about what focus looks like.
 * Sharing the shell is also what carries the direction fix here: with `dir="ltr"`
 * this input's suffix and its reserved space pointed opposite ways exactly as the
 * login field's did.
 *
 * The suffix is a flex sibling, so the digits can never run under it however long
 * the number gets.
 */
export function AmountInput({
  className,
  suffix = 'د.ع',
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { suffix?: string }) {
  const { invalid } = useContext(FieldContext);

  return (
    <div className={controlShell({ icon: true, invalid, disabled: props.disabled })}>
      <input
        inputMode="numeric"
        aria-invalid={invalid || undefined}
        className={cn(controlText, 'font-mono text-lg font-bold tabular-nums', className)}
        {...props}
      />
      {/* Not `aria-hidden`: the unit is part of what the reader is being asked for,
          not a decoration about it. */}
      <span className="pointer-events-none flex shrink-0 items-center text-sm font-medium text-steel">
        {suffix}
      </span>
    </div>
  );
}

/**
 * A native `<select>`, wearing the field shell's treatment.
 *
 * **Native on purpose.** An `appearance-none` select needs a hand-drawn chevron,
 * which is one more thing positioned inside a box — the exact shape of the bug this
 * file just removed — in exchange for a triangle nobody looks at. The UA already
 * draws its arrow at the inline end and mirrors it under RTL for free.
 *
 * It is a single element rather than a shell plus a child because it has no
 * decoration slot to conflict with: there is only one direction frame here, its own.
 * Everything else — height, border weight, focus, hover, disabled, invalid — is the
 * same set of values `controlShell` uses, so a `Select` and an `Input` side by side
 * in a filter bar are the same box.
 */
export function Select({
  className,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const { invalid } = useContext(FieldContext);

  return (
    <select
      aria-invalid={invalid || undefined}
      className={cn(
        'block min-h-field w-full rounded-md border bg-surface px-[18px] text-base text-ink',
        'transition-[border-color,box-shadow] duration-fast ease-native',
        invalid ? 'border-danger' : 'border-border-strong',
        !props.disabled && !invalid && 'hover:border-[rgba(17,24,39,0.2)]',
        invalid
          ? 'focus:border-danger focus:ring-danger/20'
          : 'focus:border-accent focus:ring-accent/20',
        'focus:outline-none focus:ring-4',
        'disabled:cursor-not-allowed disabled:bg-canvas disabled:text-steel',
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
    // `rounded-card` — 20px, the brief's 16–24 band and the step below the 24 the
    // pre-session panel uses, so a working card never out-rounds the shell it sits
    // in. It was written inline here as `rounded-[20px]`, which is a magic number in
    // the one component every other surface copies its shape from.
    <div className={cn('rounded-card border border-border bg-surface shadow-card', className)}>
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
 * **The sparkline is drawn where a real series backs it, and nowhere else.** It was
 * refused outright, on the grounds that there is no per-KPI series — which was half
 * right: `OverviewReport.timeseries` carries a genuine daily figure for captured
 * sales and for both invoice counts, and those tiles were declining to draw data they
 * already held. The tiles with no series (registered customers, discounts granted)
 * still get nothing, so the row is honest rather than uniform.
 *
 * **The reference's "+18٪ عن الفترة السابقة" is still refused**, and that half of the
 * original reasoning stands: `/reports/overview` accepts a window and no offset, so
 * the previous period is not in the response and cannot be. A comparison the caller
 * can genuinely compute from the window it holds is a different thing, and goes in
 * `delta` under its own honest wording.
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
  progressPct,
  tone = 'neutral',
  sparkline,
  sparklineDomain,
  sparklineFill,
  seriesColor,
  delta,
}: {
  icon?: LucideIcon;
  label: string;
  value?: string | number | null;
  money?: number;
  hint?: string;
  loading?: boolean;
  /** Dimmed while a refetch is in flight, so a figure is never silently out of date. */
  stale?: boolean;
  /** Only for a figure that is already a percentage of a measured whole. */
  progressPct?: number;
  tone?: 'neutral' | 'accent' | 'warning';
  /**
   * The figure's own daily series, where one genuinely exists.
   *
   * Pass the values only — the tile decides the mark. Omit it and the tile keeps its
   * former shape exactly; three of this product's four screens with tiles have no
   * per-figure series and must not grow a decorative one.
   */
  sparkline?: readonly number[];
  /** Passed straight through to `Sparkline` — see the reasoning on those props. */
  sparklineDomain?: readonly [number, number];
  sparklineFill?: boolean;
  /**
   * The hue for that mark, from `viz.ts`.
   *
   * A chart colour rather than the UI accent, and the distinction is §6.2.1's: the
   * brand teal measures under the chroma floor for a data mark and reads as grey.
   * Defaults to the accent for a caller that has no series and therefore no mark.
   */
  seriesColor?: string;
  /** A `DeltaPill`, where a comparison is honestly derivable from the data at hand. */
  delta?: ReactNode;
}) {
  return (
    <Card className="flex flex-col p-5">
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

      <div className={cn('mt-2 transition-opacity duration-base', stale && 'opacity-45')}>
        {loading ? (
          <Skeleton className="h-8 w-28" />
        ) : money !== undefined ? (
          <Money value={money} className="text-stat-sm 2xl:text-stat" />
        ) : (
          <p
            className={cn(
              'amount text-stat-sm 2xl:text-stat',
              tone === 'warning' ? 'text-amber' : tone === 'accent' ? 'text-accent' : 'text-ink',
            )}
          >
            {value ?? '—'}
          </p>
        )}
      </div>

      {/*
        A progress track, and it appears ONLY when the figure is genuinely a
        proportion of a known whole.

        The reference gives every tile a trend line and a "+18% عن الفترة السابقة".
        The trend line is now drawn where a real series backs it — see `sparkline`
        below — but the **prior-period delta is still refused**: `/reports/overview`
        takes a window, not an offset, so there is no previous period anywhere in the
        response to compare against, and a fabricated delta is indistinguishable from
        a real one (§10.9). What the caller may pass instead is a comparison it can
        actually compute from the window in hand, said in the words of what it is.

        A percentage that already IS a fraction of a measured total is a different
        thing again: the bar restates the number, it does not add one.
      */}
      {progressPct !== undefined ? (
        <div
          className="mt-3 h-1.5 overflow-hidden rounded-pill bg-canvas"
          role="img"
          aria-label={`${progressPct}٪`}
        >
          <div
            className={cn('h-full rounded-pill', tone === 'warning' ? 'bg-amber' : 'bg-accent')}
            style={{ width: `${Math.max(0, Math.min(100, progressPct))}%` }}
          />
        </div>
      ) : null}

      {/*
        The footer carries the words at the START edge and the mark at the END.

        **`mt-3`, not `mt-auto` — and that is a correction with a screenshot behind
        it.** Pinning the footer to the card floor aligned the sparklines across the
        row, which looked right at 1440 and wrong everywhere else: the grid stretches
        every tile to the tallest, so on a tile holding one short number the pin
        opened a ~200 px hole between the figure and its caption. At 1024 that was the
        worst frame in the review set. Top-packing collects the same slack at the
        bottom of the card, where it reads as breathing room instead of a gap.

        The mark is a fraction of the tile rather than a fixed 96 px, for the same
        reason: at 430 px wide a fixed sparkline floats in the middle of nowhere.
      */}
      {hint || delta || (sparkline && sparkline.length > 1) ? (
        <div className="mt-3 flex items-end justify-between gap-3">
          <div className={cn('min-w-0 flex-1 transition-opacity duration-base', stale && 'opacity-45')}>
            {delta ? <div className="mb-1">{delta}</div> : null}
            {hint ? <p className="text-[13px] leading-relaxed text-steel">{hint}</p> : null}
          </div>
          {sparkline ? (
            <div className="w-1/3 min-w-[4rem] max-w-[8rem] shrink-0">
              <Sparkline
                points={sparkline}
                color={seriesColor ?? '#0F6E56'}
                domain={sparklineDomain}
                fill={sparklineFill}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
/* ── Sparkline ─────────────────────────────────────────────────────────────── */

/**
 * The shape of a figure across the selected window, at tile scale.
 *
 * **Hand-drawn SVG rather than a fifth Recharts instance on the page**, and that is a
 * measurement rather than a preference: at 96×32 there is no axis, no tooltip and no
 * legend to configure, while every `ResponsiveContainer` costs a ResizeObserver and a
 * re-render on each resize for a mark that never needs to re-measure. Recharts still
 * draws both real charts on this screen — this is not a replacement for it, it is the
 * case it is the wrong tool for.
 *
 * **It draws the SAME array the big chart draws, deliberately.** The series is sparse
 * — a day with no captures produces no point — and zero-filling it here would make
 * the tile disagree with the chart beneath it about what the month looked like. A
 * summary that contradicts the detail is worse than no summary.
 *
 * Point 0 renders at the RIGHT edge, matching the `reversed` axis on every chart in
 * this app: under RTL time runs right-to-left, and a sparkline that ran the other way
 * would read as a decline where the chart below it reads as a rise.
 *
 * `aria-hidden`: the figure above and the delta beside it already carry the meaning
 * in text (§2.3 — never meaning by a mark alone).
 */
export function Sparkline({
  points,
  color,
  domain,
  fill = true,
  className,
}: {
  points: readonly number[];
  color: string;
  /**
   * A fixed vertical range, for a figure that HAS one.
   *
   * Without it the mark is normalised to its own min and max, which is right for a
   * quantity (money has no ceiling, so the series' own extremes are the only scale
   * there is) and wrong for a rate. An attribution rate that reads 100, 100, 100, 96
   * normalises into a cliff: four points of drift drawn as the full height of the
   * box. On a fixed `[0, 100]` the same series reads as what it is — pinned near the
   * top, with one small dip.
   */
  domain?: readonly [number, number];
  /**
   * The gradient under the line. **On by default, off for a rate.**
   *
   * A filled area asserts that the distance down to the baseline means something,
   * which is true of a sum and false of a percentage — and a rate that sits near its
   * ceiling fills the whole box, so the mark stops being a line and becomes a grey
   * rectangle. Observed in the running app on the enrolment tile before this existed.
   */
  fill?: boolean;
  className?: string;
}) {
  // Before the early return — a hook cannot sit behind a condition.
  const gradientId = useId();

  // Two points is the minimum that has a direction. One is a dot pretending to be a
  // trend, and an empty series is not a flat line, it is the absence of a line.
  if (points.length < 2) return null;

  const min = domain ? domain[0] : Math.min(...points);
  const max = domain ? domain[1] : Math.max(...points);
  const span = max - min;

  const coords = points.map((value, index) => {
    const x = 100 - (index / (points.length - 1)) * 100;
    // A flat series sits on the centre line rather than on the floor: pinned to the
    // bottom it would read as zero, which is a different fact.
    const t = span === 0 ? 0.5 : (value - min) / span;
    return { x, y: 29 - t * 24 };
  });

  const line = coords.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
  const area = fill
    ? `${line} L${coords[coords.length - 1]!.x.toFixed(2)},32 L${coords[0]!.x.toFixed(2)},32 Z`
    : '';

  return (
    <svg
      viewBox="0 0 100 32"
      // Non-uniform scaling is what lets one path fill any tile width; the stroke is
      // held at its true weight by `non-scaling-stroke` below, which is the pairing
      // that keeps it from smearing into a wedge.
      preserveAspectRatio="none"
      className={cn('h-8 w-full overflow-visible', className)}
      aria-hidden
      focusable="false"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.22} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      {fill ? <path d={area} fill={`url(#${gradientId})`} /> : null}
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/**
 * A strip of mini bars — the same job as `Sparkline` for a figure that is a count of
 * discrete events rather than a continuous quantity.
 *
 * Drawn as flex children rather than as SVG for the reason `charts.tsx` gives: an
 * HTML bar mirrors under `dir="rtl"` for free, where an SVG one needs its coordinate
 * system inverted by hand. Row direction is the document's, so the newest bar lands
 * at the start edge exactly as the axis does.
 */
export function MiniBars({
  values,
  color,
  className,
}: {
  values: readonly number[];
  color: string;
  className?: string;
}) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);

  return (
    <div className={cn('flex h-8 items-end gap-[2px]', className)} aria-hidden>
      {values.map((value, index) => (
        <span
          key={index}
          className="min-w-[2px] flex-1 rounded-[1px]"
          style={{
            // A floor of 12%, so a day with one capture is still a mark. A bar of
            // zero height reads as missing data, which is a different statement from
            // a quiet day.
            height: `${Math.max(12, (value / max) * 100)}%`,
            backgroundColor: color,
            // The oldest end fades out: a strip of 30 equal bars reads as a pattern,
            // and the recent end is the one being asked about.
            opacity: 0.35 + 0.65 * (index / Math.max(1, values.length - 1)),
          }}
        />
      ))}
    </div>
  );
}

/* ── Trend pill ────────────────────────────────────────────────────────────── */

/**
 * A signed change, with its direction stated twice.
 *
 * The arrow is not decoration — it is the relief channel for the colour (§2.3). Green
 * and red carry the same meaning to a reader who cannot separate them, so the glyph
 * and the sign in the text both say it independently.
 *
 * `text` is passed in already formatted rather than built here, because the unit
 * differs by metric — a percentage change for money, percentage *points* for a rate —
 * and that wording belongs in the locale file, not in a primitive.
 *
 * Used ONLY where a rise is unambiguously good. A pill that goes green when discount
 * spending climbs would be asserting a judgement the data does not support.
 */
export function DeltaPill({
  value,
  text,
  unit,
  className,
}: {
  value: number;
  /**
   * The signed numeric token and nothing else — `+12.4٪`, `-5.6`.
   *
   * Rendered inside a `<bdi dir="ltr">`, and that is load-bearing rather than tidy.
   * Under `dir="rtl"` a leading `+` has no European number to its left to bind to, so
   * the bidi algorithm resolves it to the paragraph direction and paints it at the
   * far END of the run: `+685.0٪` came out as `685.0٪+` in the running app. A sign on
   * the wrong side of a figure is not a blemish, it is the opposite reading.
   */
  text: string;
  /** An Arabic unit word, kept OUTSIDE the isolate so it stays in the RTL flow. */
  unit?: string;
  className?: string;
}) {
  const direction = value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
  const Icon = direction === 'up' ? TrendingUp : direction === 'down' ? TrendingDown : Minus;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-[13px] font-semibold tabular-nums',
        direction === 'up' && 'bg-success-tint text-success',
        direction === 'down' && 'bg-danger-tint text-danger',
        direction === 'flat' && 'bg-canvas text-steel',
        className,
      )}
    >
      <Icon size={13} strokeWidth={2.5} aria-hidden />
      <bdi dir="ltr">{text}</bdi>
      {unit ? <span>{unit}</span> : null}
    </span>
  );
}

/* ── Compact metric ────────────────────────────────────────────────────────── */

/**
 * The second tier of figure: real, worth a card, not worth a headline.
 *
 * These four numbers — captured invoices, attributed invoices, average basket, new
 * customers — were already on the payload and already on the screen, as grey hint
 * sentences under the KPI tiles. A number set in 13px steel beside a 32px figure is a
 * number nobody reads. This is the same data at the weight it deserves, which is the
 * §10.9 check applied to hierarchy rather than to presence.
 *
 * Half the height of a `StatTile` and no icon square, so the row reads as a band of
 * supporting detail rather than as a second, competing headline row.
 */
export function MiniStat({
  icon: Icon,
  label,
  value,
  money,
  caption,
  visual,
  loading = false,
  stale = false,
}: {
  icon?: LucideIcon;
  label: string;
  value?: string | number | null;
  money?: number;
  caption?: string;
  /** A `Sparkline` or `MiniBars`, where the figure has a real daily series. */
  visual?: ReactNode;
  loading?: boolean;
  stale?: boolean;
}) {
  return (
    <Card className="flex items-center justify-between gap-4 p-4">
      <div className={cn('min-w-0 transition-opacity duration-base', stale && 'opacity-45')}>
        <p className="flex items-center gap-2 text-[13px] leading-tight text-steel">
          {Icon ? <Icon size={15} strokeWidth={2} aria-hidden className="shrink-0" /> : null}
          {/* Wraps rather than truncates. A clipped label on a compact card costs the
              reader the one word that says what the number is, and these cards are
              short enough that a second line is cheaper than an ellipsis. */}
          <span>{label}</span>
        </p>
        {loading ? (
          <Skeleton className="mt-2 h-6 w-24" />
        ) : money !== undefined ? (
          <Money value={money} className="mt-1.5 block text-xl leading-none" />
        ) : (
          <p className="amount mt-1.5 text-xl leading-none text-ink">{value ?? '—'}</p>
        )}
        {caption ? <p className="mt-1 text-xs text-steel">{caption}</p> : null}
      </div>
      {visual ? <div className="w-20 shrink-0 sm:w-24">{visual}</div> : null}
    </Card>
  );
}

/* ── Section label ─────────────────────────────────────────────────────────── */

/**
 * A quiet rule with a name on it, between bands of a long page.
 *
 * The Overview is six bands deep now, and without a boundary the activity row reads
 * as a fifth KPI row rather than as supporting detail. A heading rather than extra
 * whitespace: `<h2>` gives the page a real outline for a screen reader, where a gap
 * gives it nothing.
 */
export function SectionLabel({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-4">
      {/* No `uppercase`: Arabic is unicameral, so the utility would be dead styling
          that only fires if an English word ever lands in here. The rule beside the
          word is what makes it read as a band label rather than as a heading. */}
      <h2 className="shrink-0 text-sm font-semibold tracking-wide text-steel">{title}</h2>
      <span className="h-px flex-1 bg-border" aria-hidden />
      {action}
    </div>
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

/**
 * A `<th>` that stays put while its rows scroll under it.
 *
 * The ground is repeated on the cell rather than left to `tableHeadRow`: a sticky
 * `<th>` lifts out of its row's stacking context, so a background painted on the
 * `<tr>` scrolls away and leaves the labels floating over the data. The boundary line
 * comes back as an inset shadow, because a `border-b` on a sticky cell is painted at
 * the cell's own edge and can clip against a scroll container.
 *
 * **It sticks to the page's scroller, not to a box of its own**, and that was a
 * correction. Wrapping the table in a bounded `overflow-auto` also makes the header
 * stick, but it puts a second wheel target inside a page that already scrolls — and
 * for the sake of the four rows past the cap, the reader's scroll gesture changes
 * meaning depending on where the pointer happens to be. Left to the page, the labels
 * simply ride down the column as you read it.
 *
 * The consequence, and it is the price: `overflow-x: auto` on an ancestor would
 * compute `overflow-y` to `auto` as well and take the sticking back, so this table
 * cannot also be a horizontal scroller. Its seven columns were measured down to 1024
 * before the cap came off.
 */
export const thSticky = cn(
  th,
  'sticky top-0 z-10 bg-canvas shadow-[inset_0_-1px_0_rgba(17,24,39,0.08)]',
);

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
  /**
   * An element — `<CreditCard size={22} aria-hidden />` — never the component itself.
   *
   * Typed `ReactNode` it accepted `icon={CreditCard}`: a lucide icon is a forwardRef
   * object, which React refuses to render as a child, so the Cards screen crashed on
   * every visit with no batches yet — the merchant's «حدث خطأ». `ReactElement` makes
   * that a compile error.
   */
  icon?: ReactElement;
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
/**
 * A screen whose data could not be loaded.
 *
 * ── It renders the server's sentence when there is one ───────────────────────
 *
 * It rendered one fixed body for every failure — «تحقّق من الاتصال بالخادم» — while the
 * `ApiRequestError` it was handed usually carried the API's own Arabic explanation:
 * a role refusal, a missing record, a full disk. Ten screens threw that away. The fixed
 * body is now the fallback for the two cases with nothing better to say: a request that
 * never completed (status 0 — the backend went away mid-session, and reopening routes to
 * `BackendGate`) and a failure that is not an API error at all.
 */
/*
 * ── And it now says WHAT failed and WHY, which is the class fix ──────────────
 *
 * The title was «حدث خطأ» on every screen. `what` is required — a call site cannot
 * render this without naming what it was loading — and the body comes from
 * `describeFailure`, which names the cause and its remedy: the banner's own words for
 * a full disk, the file's permissions, a failing disk, a damaged database, a service
 * that stopped answering, or — for a defect of ours — the reference support looks up.
 * `error` is required too, because a failure rendered without its cause is the generic
 * message by another route (Reports did exactly that).
 */
export function ErrorState({
  what,
  error,
  onRetry,
}: {
  what: string;
  error: unknown;
  onRetry?: () => void;
}) {
  const failure = describeFailure(error);
  return (
    <EmptyState
      icon={<AlertTriangle size={22} aria-hidden />}
      title={locale.failure.loadTitle(what)}
      body={failure.body}
      action={
        <div className="flex flex-col items-center gap-3">
          {failure.reference ? <FailureReference value={failure.reference} /> : null}
          {onRetry ? (
            <Button variant="ghost" onClick={onRetry}>
              {locale.common.retry}
            </Button>
          ) : null}
        </div>
      }
    />
  );
}

/**
 * The same, sized for a panel inside a screen that otherwise loaded — the staff list in
 * Settings, the rules card on a customer. A full-height empty state there would push the
 * working half of the screen out of view.
 */
export function InlineFailure({
  what,
  error,
  onRetry,
}: {
  what: string;
  error: unknown;
  onRetry?: () => void;
}) {
  const failure = describeFailure(error);
  return (
    <Notice tone="danger" title={locale.failure.loadTitle(what)}>
      <div className="space-y-2">
        <p>{failure.body}</p>
        {failure.reference ? <FailureReference value={failure.reference} /> : null}
        {onRetry ? (
          <Button variant="ghost" onClick={onRetry}>
            {locale.common.retry}
          </Button>
        ) : null}
      </div>
    </Notice>
  );
}

/** «الرقم المرجعي: 3f9a1c2b» — the server's request id, which finds the log line. */
export function FailureReference({ value }: { value: string }) {
  return (
    <p className="text-sm text-steel">
      {locale.failure.reference}:{' '}
      <bdi className="font-mono text-ink" dir="ltr">
        {value}
      </bdi>
    </p>
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
