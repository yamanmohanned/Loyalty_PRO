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
    /* `auth-atmosphere` adds the reference's ornament layer — a faint dot matrix,
        thin orbit rings and three sparkles — entirely in pseudo-elements at z-index
        -1, so it is invisible to assistive tech and can never sit above a control.
        Every alpha is at or below 0.03, which is the computed ceiling for staying
        under a 5% luma delta on this ground; the arithmetic is in the preset. */
    <div className="auth-atmosphere min-h-[100dvh] bg-auth-ground">
      {/* Proportions and the side order both come from measuring `login.png` at its
          native 1448 px — see the manager app's `AuthLayout` for the table. The card
          sits on the RIGHT there, which is the START edge of a natively-RTL design, so
          the card is the FIRST child and takes the FIRST (fixed) track. */}
      <div className="mx-auto grid min-h-[100dvh] max-w-[76rem] items-center gap-12 px-6 py-10 lg:grid-cols-[40rem_1fr]">
        <div className="order-1 w-full justify-self-center lg:justify-self-start">
          {/* Near-white with the reference's barely-there vertical gradient (~5 levels),
              24px radius, 56px padding, and the measured elevation. Solid, not `glass`. */}
          <div className="mx-auto w-full rounded-xl bg-gradient-to-b from-white to-[#FAFAFB] p-14 shadow-panel">
            {/* The card leads with the identity block, as the reference's does. */}
            <div className="mb-11 flex flex-col items-center text-center">
              <BrandMark size={72} />
              <h1 className="mt-5 font-display text-[2.375rem] font-bold leading-none text-accent">
                {locale.app.name}
              </h1>
              <p className="mt-3 text-lg text-steel">{locale.app.station}</p>
            </div>
            {children}
          </div>
        </div>

        <div className="relative order-2 flex flex-col items-center text-center lg:items-start lg:text-start">
          {/* The illustration is refused (stock raster we do not own); what replaces it
              is ambient light rather than another graphic, because light is not a
              picture of anything. */}
          <span
            className="pointer-events-none absolute -start-24 -top-24 -z-10 h-[26rem] w-[26rem] rounded-pill bg-[radial-gradient(circle,rgba(15,110,86,0.14)_0%,rgba(15,110,86,0.05)_45%,transparent_70%)]"
            aria-hidden
          />

          {/* The identity block lives in the CARD now, as the reference has it, so this
              column carries the headline and the strip — `login.png`'s left column
              below its illustration. Rendering the mark and wordmark in both places
              put the shop's name on screen twice; caught by looking at the render. */}
          <h2 className="font-display text-[clamp(1.875rem,3.2vw,2.375rem)] font-bold leading-[1.25] text-ink">
            {locale.app.station}
          </h2>
          {/* Ink rather than steel, measured: this side sits on `bg-auth-ground`,
              whose warm stop takes `steel` to 4.39:1 against a 4.5 floor (§12.34 —
              a clearance is scoped to the surface it was measured on). */}
          <p className="mt-4 max-w-sm text-lg leading-relaxed text-ink/80">
            {locale.login.tagline}
          </p>

          <ul className="mt-9 flex items-stretch divide-x divide-x-reverse divide-border">
            <StripItem icon={<ScanLine size={22} aria-hidden />} label={locale.login.stripScan} />
            <StripItem icon={<Ticket size={22} aria-hidden />} label={locale.login.stripPrint} />
            <StripItem icon={<WifiOff size={22} aria-hidden />} label={locale.login.stripOffline} />
          </ul>
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
