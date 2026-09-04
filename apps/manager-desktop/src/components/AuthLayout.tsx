import type { ReactNode } from 'react';
import { BrandMark } from './BrandMark';
import { locale } from '../lib/locale';

/**
 * The shell every pre-session screen sits in: login and first-run setup.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  What this takes from `login.png`, and what it refuses
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * **Taken — arrangement only** (§2.2): the two-column split, brand on one side and a
 * single elevated card on the other; the card's vertical rhythm — mark, wordmark,
 * subtitle, then a greeting line, then the fields, then one full-width primary action,
 * then a secondary path below it; the generous padding; the soft ground behind an
 * elevated surface.
 *
 * **Refused, and each for a reason rather than taste:**
 *
 * - **"نسيت كلمة المرور؟"** — there is no password reset. §12.31 records what the
 *   Station guide tells operators: the password comes from the manager and cannot be
 *   changed here. A link to a flow that does not exist is worse than no link, because
 *   the person who clicks it is the person already locked out.
 * - **The language selector.** The product is Arabic, RTL, one locale (§0.3). A picker
 *   implies translations that do not exist.
 * - **The dark-mode toggle.** §6.2 defines one light palette. A toggle would either do
 *   nothing or ship an unvalidated second palette — and §12.33's contrast numbers were
 *   measured against the light surface.
 * - **The star rating and "تواصل معنا".** No feedback channel, no support desk. Both
 *   are §2.2's "anything implying a feature we do not have".
 * - **The 3D card-on-a-podium illustration, sparkles and plants.** Stock raster art
 *   this product does not own, in a visual language §6 does not define. The brand panel
 *   carries the real mark at size instead.
 * - **The marketing feature strip** («مكافآت حصرية · تقارير ذكية · أمان وموثوقية»).
 *   Copy about a product, not information for the person signing in.
 * - **The © bar.** Dated, and it earns none of the space it takes.
 *
 * **Put there instead, because it is real and it is the question a person actually has
 * at this screen:** the server this app is pointed at. A manager on a new machine wants
 * to know it is talking to their shop before typing a password, and the "change server"
 * control right below it is the answer if it is wrong.
 */
export function AuthLayout({
  /** Sits under the wordmark in the brand panel — what this app is. */
  tagline,
  /** The server address, when it is known. Absent during first-run setup. */
  serverUrl,
  children,
}: {
  tagline: string;
  serverUrl?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="min-h-[100dvh] bg-canvas">
      <div className="mx-auto grid min-h-[100dvh] max-w-6xl items-center gap-10 px-6 py-10 lg:grid-cols-[1fr_1.05fr]">
        {/* Brand. First child, so under `dir="rtl"` it lands at the RIGHT edge — the
            reference puts the form there and the art on the left, which mirrors to
            this. §6.7 #4: auto-generated designs get this backwards, so it is stated
            rather than assumed. */}
        <div className="flex flex-col items-center text-center lg:items-start lg:text-start">
          {/* The mark at size (§2.5). The 384 px master covers this at 3×. */}
          <BrandMark size={112} className="mb-6 drop-shadow-[0_10px_30px_rgba(15,110,86,0.18)]" />

          <h1 className="font-display text-[clamp(2rem,4vw,2.75rem)] font-bold leading-tight text-ink">
            {locale.appName}
          </h1>
          <p className="mt-3 max-w-md text-lg leading-relaxed text-steel">{tagline}</p>

          {serverUrl ? (
            <div className="mt-8 rounded-lg border border-border bg-surface px-4 py-3">
              <p className="text-xs text-steel">{locale.login.serverLabel}</p>
              {/* A URL is Latin text inside an RTL page: isolated, or the scheme and
                  the port change places (§12.27, §12.30). */}
              <bdi dir="ltr" className="amount mt-1 block text-sm text-ink">
                {serverUrl}
              </bdi>
            </div>
          ) : null}
        </div>

        {/* The card. `glass` is legal here and only here: it sits on the canvas with
            nothing behind it, the one placement where `steel` still clears 4.5:1 at
            4.76 (§12.34). */}
        <div className="w-full justify-self-center lg:justify-self-end">
          <div className="glass mx-auto w-full max-w-md rounded-lg border border-transparent p-8 shadow-card">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
