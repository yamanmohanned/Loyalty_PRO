import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  CreditCard,
  ListChecks,
  LogIn,
  UserPlus,
  Wifi,
  X,
} from 'lucide-react';
import { GUIDE_PAGES, type GuidePage } from '../lib/guide';
import { locale } from '../lib/locale';
import { Button, cn } from './ui';

/**
 * The in-app walkthrough (operator request, 2026-09-02).
 *
 * Five screens of plain Arabic, opened from the login screen and closed again. It
 * has no controls except next, back and close, and it changes nothing — see the
 * comment on `lib/guide.ts` for why that limit is load-bearing rather than a
 * stylistic preference.
 *
 * ── The panel is deliberately NOT glass ────────────────────────────────────
 *
 * The scrim behind it is; the panel is not. Its body text is `steel` sitting over a
 * dimmed backdrop, and that combination does not reach 4.5:1 through a translucent
 * surface at any alpha worth using — the preset's glass comment carries the
 * measurements. A help screen that is harder to read than the app it explains would
 * be a poor trade for a texture.
 *
 * ── RTL ────────────────────────────────────────────────────────────────────
 *
 * The chevrons are the thing auto-generated designs get wrong (§6.7 #4). On an
 * RTL page **"back" points right** and "next" points left, because that is the
 * direction the reader is travelling. `ChevronRight` is therefore on the back
 * control and `ChevronLeft` on the forward one — the opposite of what the component
 * names suggest, and correct.
 */

const ICONS = {
  login: LogIn,
  steps: ListChecks,
  outcomes: CreditCard,
  register: UserPlus,
  connection: Wifi,
} as const;

export function Guide({ onClose }: { onClose: () => void }): JSX.Element {
  const [index, setIndex] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // `noUncheckedIndexedAccess` is on: the index is clamped rather than asserted, so
  // a future page count change cannot produce an undefined page at runtime.
  const page = GUIDE_PAGES[Math.min(index, GUIDE_PAGES.length - 1)] ?? GUIDE_PAGES[0]!;
  const first = index === 0;
  const last = index === GUIDE_PAGES.length - 1;

  const go = useCallback((next: number) => {
    setIndex(next);
    // A new page starts at its own top. Without this, page 4 opens halfway down
    // because the scroll position of page 3 survived.
    bodyRef.current?.scrollTo({ top: 0 });
  }, []);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const Icon = ICONS[page.icon];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={locale.guide.title}
      className="glass-scrim fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-surface shadow-[0_24px_64px_-16px_rgba(17,24,39,0.35)] focus:outline-none"
      >
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <header className="flex items-start gap-4 border-b border-border px-6 py-5">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-accent-tint text-accent">
            <Icon size={24} aria-hidden />
          </span>

          <div className="min-w-0 flex-1">
            <h2 className="font-display text-2xl font-bold leading-tight text-ink">{page.title}</h2>
            <p className="mt-1 text-base text-steel">{page.intro}</p>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label={locale.actions.close}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-border text-steel"
          >
            <X size={20} aria-hidden />
          </button>
        </header>

        {/* ── Body ───────────────────────────────────────────────────────── */}
        <div ref={bodyRef} className="flex-1 overflow-y-auto px-6 py-5">
          <PageBody page={page} />
        </div>

        {/* ── Footer ─────────────────────────────────────────────────────── */}
        <footer className="flex items-center gap-4 border-t border-border px-6 py-4">
          <Button
            variant="ghost"
            onClick={() => go(index - 1)}
            disabled={first}
            className="min-h-[48px] px-4"
          >
            {/* Right, not left: on an RTL page "back" points the way the reader came. */}
            <ChevronRight size={18} aria-hidden />
            {locale.guide.previous}
          </Button>

          <ol className="flex flex-1 items-center justify-center gap-2" aria-hidden>
            {GUIDE_PAGES.map((candidate, position) => (
              <li key={candidate.title}>
                <button
                  type="button"
                  onClick={() => go(position)}
                  className={cn(
                    'h-2.5 rounded-pill transition-all duration-fast',
                    position === index ? 'w-7 bg-accent' : 'w-2.5 bg-border',
                  )}
                  tabIndex={-1}
                />
              </li>
            ))}
          </ol>

          {/* The last page's forward control closes, rather than sitting disabled and
              leaving the reader to find the × they arrived past five screens ago. */}
          {last ? (
            <Button onClick={onClose} className="min-h-[48px] px-5">
              {locale.guide.done}
            </Button>
          ) : (
            <Button onClick={() => go(index + 1)} className="min-h-[48px] px-5">
              {locale.guide.next}
              <ChevronLeft size={18} aria-hidden />
            </Button>
          )}
        </footer>

        {/* Announced rather than drawn: the dots above carry the same information
            visually, and a reader on a screen reader gets the count in words. */}
        <p className="sr-only" role="status">
          {locale.guide.pageOf(index + 1, GUIDE_PAGES.length)}
        </p>
      </div>
    </div>
  );
}

function PageBody({ page }: { page: GuidePage }): JSX.Element {
  return (
    <div className="space-y-6">
      {page.sections.map((section) => (
        <section key={section.heading ?? 'main'}>
          {section.heading ? (
            <h3 className="mb-3 text-lg font-bold text-ink">{section.heading}</h3>
          ) : null}

          <ul className="space-y-3">
            {section.items.map((item) => (
              <li key={item} className="flex gap-3">
                {/* A dot rather than a number: these are things to know, and numbering
                    them would imply an order that most of the lists do not have. */}
                <span
                  aria-hidden
                  className="mt-[0.6em] h-1.5 w-1.5 shrink-0 rounded-pill bg-accent"
                />
                <span className="text-base leading-relaxed text-ink">{item}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
