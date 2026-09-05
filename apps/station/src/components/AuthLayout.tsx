import type { ReactNode } from 'react';
import { ScanLine, Ticket, WifiOff } from 'lucide-react';
import { BrandMark } from './BrandMark';
import { locale } from '../lib/locale';

/**
 * The shell for the Station's pre-session screens: login and first-run setup.
 *
 * V4-4: converted to `login.png` alongside the manager app's `AuthLayout`. See that
 * file for the full take/refuse audit — it applies here unchanged, and both shells
 * moved together deliberately so the two apps do not drift into two design languages.
 *
 * Three things belong to this app rather than to that one:
 *
 * 1. **It is a till-side appliance, read at arm's length** (§3.2). Every step of the
 *    type scale is one larger and the controls stay at the Station's 52/64 px rather
 *    than the dashboard's 48 — the conversion changes the visual language, never the
 *    ergonomics that were measured for a person standing with a queue behind them.
 * 2. **The strip says what the Station does, not what the console reports.** Scan,
 *    print, and keep working offline — the three facts an operator at this screen
 *    actually needs, and all three are true of the build in front of them.
 * 3. **No server address.** The Station is normally served by the API itself, so the
 *    origin the browser loaded *is* the server (§12.13); printing it would be telling
 *    the operator something they cannot act on and did not ask.
 *
 * It stacks on a tablet in portrait and splits on a desktop screen — the same
 * device-agnostic requirement as everything else here (§3.1).
 */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-[100dvh] bg-auth-ground">
      <div className="mx-auto grid min-h-[100dvh] max-w-5xl items-center gap-10 px-6 py-10 lg:grid-cols-[1fr_1fr]">
        {/* First child → right edge under RTL, which is where the reference's form
            sits once mirrored (§6.7 #4). */}
        <div className="flex flex-col items-center text-center lg:items-start lg:text-start">
          {/* The reference's lit podium with the podium removed: a radial wash behind
              the mark, drawn as a sibling rather than a filter so the halo pools under
              the mark instead of tracing its glyph. */}
          <div className="relative mb-7">
            <span
              className="absolute left-1/2 top-1/2 -z-10 h-56 w-56 -translate-x-1/2 -translate-y-1/2 rounded-pill bg-[radial-gradient(circle,rgba(15,110,86,0.16)_0%,rgba(15,110,86,0.05)_45%,transparent_70%)]"
              aria-hidden
            />
            <BrandMark size={136} />
          </div>

          {/* The wordmark in the ACCENT at display size — the reference's strongest
              type decision, and what makes this read as a product rather than a form. */}
          <h1 className="font-display text-[clamp(2.5rem,5vw,3.25rem)] font-bold leading-[1.15] text-accent">
            {locale.app.name}
          </h1>
          <p className="mt-2 text-xl font-medium text-ink">{locale.app.station}</p>
          {/* Ink rather than steel, measured: this side sits on `bg-auth-ground`,
              whose warm stop takes `steel` to 4.39:1 against a 4.5 floor (§12.34 —
              a clearance is scoped to the surface it was measured on). */}
          <p className="mt-3 max-w-sm text-lg leading-relaxed text-ink/80">
            {locale.login.tagline}
          </p>

          <ul className="mt-9 flex items-stretch divide-x divide-x-reverse divide-border">
            <StripItem icon={<ScanLine size={22} aria-hidden />} label={locale.login.stripScan} />
            <StripItem icon={<Ticket size={22} aria-hidden />} label={locale.login.stripPrint} />
            <StripItem icon={<WifiOff size={22} aria-hidden />} label={locale.login.stripOffline} />
          </ul>
        </div>

        <div className="w-full justify-self-center lg:justify-self-end">
          {/* Solid, not `glass`. The reference's panel is an opaque near-white, and
              converting to it retires the one surface §12.34 recorded as passing by
              0.05 — style and legibility agreeing for once. */}
          <div className="mx-auto w-full max-w-md rounded-xl bg-surface p-9 shadow-panel">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/** One strip cell: a tinted icon square over a short label — the reference's most
 *  repeated device, shared with the manager app's shell. */
function StripItem({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <li className="flex flex-col items-center gap-2 px-5 first:ps-0 last:pe-0">
      <span
        className="flex size-11 items-center justify-center rounded-md bg-accent-tint text-accent"
        aria-hidden
      >
        {icon}
      </span>
      <span className="text-sm font-medium leading-tight text-ink">{label}</span>
    </li>
  );
}
