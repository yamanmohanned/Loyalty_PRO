import type { ReactNode } from 'react';
import { BrandMark } from './BrandMark';
import { locale } from '../lib/locale';

/**
 * The shell for the Station's pre-session screens: login and first-run setup.
 *
 * The same audit as the manager app's `AuthLayout` — see that file for what
 * `login.png` gives and what it does not. Two differences belong to this app:
 *
 * 1. **It is a till-side appliance, read at arm's length** (§3.2). The type is a step
 *    larger and the touch targets stay at the Station's 52/64 px rather than the
 *    dashboard's 48, because whoever uses this is standing up with a queue behind them.
 * 2. **The brand panel carries no server address.** The Station is normally served by
 *    the API itself, so the origin the browser loaded *is* the server (§12.13) and
 *    printing it would be telling the operator something they cannot act on and did not
 *    ask. The manager app, installed separately and pointed at a machine by hand, is a
 *    different case.
 *
 * It stacks on a tablet in portrait and splits on a desktop screen — the same
 * device-agnostic requirement as everything else here (§3.1).
 */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-[100dvh] bg-canvas">
      <div className="mx-auto grid min-h-[100dvh] max-w-5xl items-center gap-8 px-6 py-10 lg:grid-cols-[1fr_1fr]">
        {/* First child → right edge under RTL, which is where the reference's form
            sits once mirrored (§6.7 #4). */}
        <div className="flex flex-col items-center text-center lg:items-start lg:text-start">
          <BrandMark size={120} className="mb-6 drop-shadow-[0_10px_30px_rgba(15,110,86,0.18)]" />

          <h1 className="font-display text-[clamp(2.25rem,5vw,3rem)] font-bold leading-tight text-accent">
            {locale.app.name}
          </h1>
          <p className="mt-2 text-xl text-ink">{locale.app.station}</p>
          <p className="mt-3 max-w-sm text-lg leading-relaxed text-steel">
            {locale.login.tagline}
          </p>
        </div>

        <div className="w-full justify-self-center lg:justify-self-end">
          {/* Glass, on the canvas, alone — §12.34's one safe placement. */}
          <div className="glass mx-auto w-full max-w-md rounded-lg border border-transparent p-7 shadow-card">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
