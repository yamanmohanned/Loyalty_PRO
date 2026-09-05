import type { ReactNode } from 'react';
import { BarChart3, ShieldCheck, Server } from 'lucide-react';
import { BrandMark } from './BrandMark';
import { locale } from '../lib/locale';

/**
 * The shell every pre-session screen sits in: login and first-run setup.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  V4-4 — converted to `login.png`'s visual language
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The previous pass audited this reference carefully and then took almost nothing
 * from it, which is how "refuse the content" quietly became "refuse the design".
 * What follows is the separation done properly: every STYLE decision below comes
 * from the reference; every refusal is about CONTENT.
 *
 * ── Taken (style) ──────────────────────────────────────────────────────────
 *
 * - **The two-part composition**: an art side and a form side, the form on a raised
 *   panel and the art loose on the page ground.
 * - **The ground is not flat.** The reference warms towards the brand hue at one
 *   corner (`bg-auth-ground`). A centred card on a flat fill reads as a dialog; on a
 *   graded ground it reads as a page.
 * - **The panel**: 20px radius, 40px of internal padding, and a wide, soft,
 *   brand-tinted elevation (`shadow-panel`) rather than a hairline border.
 * - **The halo behind the mark** — the reference's illustration sits in a soft glow
 *   on a podium. The podium and the illustration are refused; the glow is what makes
 *   the art side feel lit instead of pasted, so the mark gets it.
 * - **Typographic hierarchy**: the wordmark large and in the ACCENT, not ink — the
 *   reference's single strongest type decision, and the thing that makes the page
 *   look branded rather than administrative. Then a quiet subtitle, then a heavier
 *   headline, then a lighter support line.
 * - **The feature strip**: tinted icon squares over short labels, in a row split by
 *   hairline dividers. The reference fills it with marketing; ours carries facts.
 *
 * ── Refused (content), each with a reason ──────────────────────────────────
 *
 * - **The 3D card-on-a-podium illustration, sparkles, plants.** Stock raster this
 *   product does not own, in a visual language §6 does not define. The brand mark at
 *   size is our art.
 * - **"نسيت كلمة المرور؟"** — there is no password reset. §12.31: the password comes
 *   from the manager. A link to a flow that does not exist is worst for exactly the
 *   person who clicks it.
 * - **The language selector** — one locale (§0.3). **The dark-mode toggle** — one
 *   validated palette (§6.2), and every contrast figure was measured against it.
 * - **The star rating and "تواصل معنا"** — no feedback channel, no support desk.
 * - **The marketing strip** («مكافآت حصرية · تقارير ذكية · أمان وموثوقية»). Copy about
 *   a product, not information for the person signing in. **The strip's treatment is
 *   kept and filled with what is true**: what this console is for, and which server it
 *   is pointed at — the one question a manager on a new machine actually has.
 * - **The © footer bar.** Dated, and it earns none of the space it takes.
 * - **The glow under the primary button** — §6.4 "flat, no glow", §11 bans it by name.
 *   The button keeps the reference's gradient, which is depth rather than neon.
 *
 * ── One material change from the previous version ──────────────────────────
 *
 * **The card is no longer `glass`.** §12.34 recorded this as glass's one safe
 * placement, measured at 4.55:1 — passing by 0.05. The reference's panel is a solid
 * near-white, so converting to its language happens to retire the one surface in the
 * product that was passing on a hair. Style and safety agreed for once.
 */
export function AuthLayout({
  /** Sits under the wordmark on the art side — what this app is. */
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
    <div className="min-h-[100dvh] bg-auth-ground">
      <div className="mx-auto grid min-h-[100dvh] max-w-6xl items-center gap-12 px-6 py-10 lg:grid-cols-[1fr_1.02fr]">
        {/* Art side. First child, so under `dir="rtl"` it lands at the RIGHT edge —
            the reference puts the form there and the art on the left, which mirrors
            to this. §6.7 #4: auto-generated designs get this backwards, so it is
            stated rather than assumed. */}
        <div className="flex flex-col items-center text-center lg:items-start lg:text-start">
          {/* The reference's lit podium, with the podium removed. A radial wash
              behind the mark at low alpha — the mark is a PNG with its own
              transparency, so the glow has to be a sibling behind it rather than a
              filter on it, or the halo would trace the glyph instead of pooling
              under it.

              The halo is wider than the mark, so this wrapper reports a `scrollWidth`
              past its `clientWidth`. That is inert and it was checked rather than
              waved away: the element is absolutely positioned, and the document does
              not overflow at 1440, 1280, 820 or 390. Recorded so the next person to
              run an overflow sweep knows this line is expected. */}
          <div className="relative mb-7">
            <span
              className="absolute left-1/2 top-1/2 -z-10 h-52 w-52 -translate-x-1/2 -translate-y-1/2 rounded-pill bg-[radial-gradient(circle,rgba(15,110,86,0.16)_0%,rgba(15,110,86,0.05)_45%,transparent_70%)]"
              aria-hidden
            />
            {/* The mark at size (§2.5). The 384 px master covers this at 3×. */}
            <BrandMark size={128} />
          </div>

          {/* Accent, not ink. The reference's wordmark is the brand colour at
              display size and it is what makes the page read as a product rather
              than a form. #0F6E56 on the ground measures well past the floor at this
              size and weight. */}
          <h1 className="font-display text-[clamp(2.25rem,4.4vw,3rem)] font-bold leading-[1.15] text-accent">
            {locale.appName}
          </h1>
          <p className="mt-2 text-lg font-medium text-ink">{locale.appTagline}</p>
          {/* Ink, not steel — measured, not assumed (§12.34).

              `steel` #6B7280 clears 4.5:1 on `canvas` by 0.007 (4.557). The art side
              no longer sits on canvas: it sits on `bg-auth-ground`, whose warm stop
              #EDF6F2 takes the same text to **4.39** — a real failure introduced by
              the ground this conversion added. I computed what the stop would have to
              be to rescue steel and the answer is "lighter than canvas", i.e. no warm
              ground at all. So the text changes and the ground keeps its character.

              Hierarchy is carried by SIZE and WEIGHT instead — the same resolution
              already recorded for `Notice` and for `Money`'s currency suffix. */}
          <p className="mt-3 max-w-md text-base leading-relaxed text-ink/80">{tagline}</p>

          {/*
            The reference's feature strip, carrying facts instead of marketing.

            Two of the three cells are constants about what this console does — true,
            and the same answer a manager would get by asking. The third is the server
            it is pointed at, which is the live one and the only thing here a person
            can act on. During first-run setup there is no server yet, so that cell is
            simply absent rather than showing a placeholder.
          */}
          <ul className="mt-9 flex items-stretch gap-0 divide-x divide-x-reverse divide-border">
            <StripItem icon={<BarChart3 size={20} aria-hidden />} label={locale.login.stripReports} />
            <StripItem icon={<ShieldCheck size={20} aria-hidden />} label={locale.login.stripSecure} />
            {serverUrl ? (
              <StripItem
                icon={<Server size={20} aria-hidden />}
                label={locale.login.stripServer}
                value={serverUrl}
              />
            ) : null}
          </ul>
        </div>

        {/* Form side. */}
        <div className="w-full justify-self-center lg:justify-self-end">
          <div className="mx-auto w-full max-w-[27rem] rounded-xl bg-surface p-10 shadow-panel">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One cell of the strip: a tinted icon square above a short label.
 *
 * The tinted square is the reference's most repeated device — it appears here, on
 * every KPI tile, and at the head of every page — so it lives in as many places as it
 * can rather than being redrawn per screen.
 */
function StripItem({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value?: string;
}) {
  return (
    <li className="flex flex-col items-center gap-2 px-5 first:ps-0 last:pe-0">
      <span
        className="flex size-10 items-center justify-center rounded-md bg-accent-tint text-accent"
        aria-hidden
      >
        {icon}
      </span>
      {/* Ink for the same measured reason as the tagline above. */}
      <span className="text-xs font-medium leading-tight text-ink">{label}</span>
      {value ? (
        // A URL is Latin text inside an RTL page: isolated, or the scheme and the
        // port change places (§12.27, §12.30).
        <bdi dir="ltr" className="amount block text-xs text-ink">
          {value}
        </bdi>
      ) : null}
    </li>
  );
}
