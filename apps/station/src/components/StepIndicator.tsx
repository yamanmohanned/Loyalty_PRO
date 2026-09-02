import { Check } from 'lucide-react';
import { cn } from './ui';
import { locale } from '../lib/locale';

/**
 * Where the operator is in the guided flow (operator request, 2026-09-02).
 *
 * Two steps, always both visible, the current one named. The reason it is here at
 * all is interruption: a till is not a quiet desk, and an operator who looks back at
 * the screen after handling a question needs to know whether the card has already
 * been read without having to scan again to find out.
 *
 * The step numbers are set in Arabic-Indic-free Western digits and the sentence
 * carries them ("الخطوة 1 من 2") rather than a bare numeral beside another numeral —
 * §12.27's second instance was two adjacent bare numbers being read as one.
 */
export function StepIndicator({
  current,
  labels,
}: {
  /** 1-based. `labels.length` is the total. */
  current: number;
  labels: readonly string[];
}): JSX.Element {
  const total = labels.length;

  return (
    <nav aria-label={locale.flow.stepOf(current, total)} className="mb-6">
      <ol className="flex items-center gap-3">
        {labels.map((label, index) => {
          const step = index + 1;
          const done = step < current;
          const active = step === current;

          return (
            <li key={label} className="flex flex-1 items-center gap-3">
              <span
                aria-hidden
                className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-pill text-base font-bold',
                  done && 'bg-success text-white',
                  active && 'bg-accent text-white',
                  !done && !active && 'border border-border bg-surface text-steel',
                )}
              >
                {done ? <Check size={18} aria-hidden /> : step}
              </span>

              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    'block truncate text-base font-semibold',
                    active ? 'text-ink' : 'text-steel',
                  )}
                >
                  {label}
                </span>
                {/* The step count as a sentence, not a fraction glyph: read aloud it
                    has to survive being said to somebody standing at the counter. */}
                <span className="block text-sm text-steel">{locale.flow.stepOf(step, total)}</span>
              </span>

              {step < total ? (
                <span
                  aria-hidden
                  className={cn('h-px flex-1 shrink', done ? 'bg-success' : 'bg-border')}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
