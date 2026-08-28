import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * The station's primitives.
 *
 * Deliberately fewer and larger than the manager dashboard's. This screen is read
 * across a counter, often at arm's length, by someone whose attention is on the
 * customer rather than the app — so controls are at least 52 px tall (§6.5) and
 * nothing relies on a hover state that a touch screen does not have.
 */

export const cn = (...classes: Array<string | undefined | false>): string => twMerge(clsx(classes));

/* ── Button ────────────────────────────────────────────────────────────────── */

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'quiet';
  size?: 'base' | 'large';
}

export function Button({
  variant = 'primary',
  size = 'base',
  className,
  ...props
}: ButtonProps): JSX.Element {
  return (
    <button
      {...props}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-md font-semibold',
        'transition-colors duration-fast ease-native',
        // A 1px press-down instead of a glow or a scale (§6.4).
        'active:translate-y-px disabled:pointer-events-none disabled:opacity-45',
        size === 'large' ? 'min-h-[64px] px-8 text-xl' : 'min-h-[52px] px-6 text-lg',
        variant === 'primary' && 'bg-accent text-white hover:bg-accent/92',
        variant === 'ghost' && 'border border-border bg-surface text-ink hover:bg-canvas',
        variant === 'quiet' && 'text-steel hover:text-ink',
        className,
      )}
    />
  );
}

/* ── Input ─────────────────────────────────────────────────────────────────── */

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      {...props}
      className={cn(
        'w-full rounded-md border bg-surface px-4 text-lg text-ink',
        'min-h-[52px] placeholder:text-steel/70',
        'focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-canvas',
        invalid ? 'border-danger' : 'border-border',
        className,
      )}
    />
  );
});

/* ── Field ─────────────────────────────────────────────────────────────────── */

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}): JSX.Element {
  return (
    <label className="block">
      {/* Label above, helper and error below — one vertical rhythm everywhere (§6.4). */}
      <span className="mb-2 block text-base font-semibold text-ink">{label}</span>
      {children}
      {error ? (
        <span className="mt-2 block text-sm text-danger">{error}</span>
      ) : hint ? (
        <span className="mt-2 block text-sm text-steel">{hint}</span>
      ) : null}
    </label>
  );
}

/* ── Surfaces ──────────────────────────────────────────────────────────────── */

export function Card({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={cn('rounded-lg border border-border bg-surface p-6 shadow-card', className)}>
      {children}
    </div>
  );
}

export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'error' | 'success';
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'rounded-md border px-4 py-3 text-base',
        tone === 'info' && 'border-border bg-canvas text-steel',
        tone === 'warn' && 'border-amber/25 bg-amber-tint text-amber',
        tone === 'error' && 'border-danger/25 bg-danger-tint text-danger',
        tone === 'success' && 'border-success/25 bg-success-tint text-success',
      )}
    >
      {children}
    </div>
  );
}

/* ── Money ─────────────────────────────────────────────────────────────────── */

export function Money({
  value,
  size = 'base',
  className,
}: {
  value: string;
  size?: 'base' | 'hero';
  className?: string;
}): JSX.Element {
  return (
    <span
      className={cn(
        'amount',
        size === 'hero' ? 'text-[clamp(2.5rem,7vw,4.5rem)] leading-none' : 'text-2xl',
        className,
      )}
    >
      {value}
    </span>
  );
}
