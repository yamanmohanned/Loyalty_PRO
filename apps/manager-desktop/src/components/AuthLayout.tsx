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
      {/*
        Proportions measured off `login.png` at its native 1448 px, not eyeballed:

        | measured                    | px    | share  | ours          |
        |-----------------------------|-------|--------|---------------|
        | card width                  | 681   | 47.0%  | 42rem = 672   |
        | card margin, START edge     | 131   |  9.0%  | 88 (6.1%)     |
        | card padding, sides         |  54   |        | 56 (8px grid) |
        | field / button height       |  58   |        | 56 (8px grid) |
        | card radius                 |  24   |        | 24            |
        | field / button radius       |  12   |        | 12            |

        Everything snaps to the 4/8 px rhythm §6.5 requires, which is why 58 becomes
        56 and 54 becomes 56 — within 2 px of the reference and on the grid.
      */}
      {/* The fixed track is FIRST, because the card is now the first child. Swapping
          the DOM order without swapping the tracks put the card in the `1fr` column
          and handed its 42rem to the art — caught by measuring the rendered box
          (480 px where 672 was intended) rather than by reading the class. */}
      <div className="mx-auto grid min-h-[100dvh] max-w-[82rem] items-center gap-12 px-6 py-10 lg:grid-cols-[42rem_1fr]">
        {/*
          THE FORM COMES FIRST, and that is a correction.

          The previous pass put the art first "so it lands at the RIGHT edge, which
          mirrors the reference". That reasoning treated `login.png` as an LTR design
          needing mirroring. **It is not** — it is a finished Arabic RTL design, and in
          it the form card sits on the RIGHT, which is the START edge. Measured: the
          card occupies x 636–1317 of 1448, leaving 131 px on the right and 636 on the
          left.

          So mirroring it was mirroring it away from the reference. Under `dir="rtl"`
          the first grid child is placed at the right, so the card is first.

          It is also simply better: the form is the thing you act on, and it now sits
          where an RTL reader starts (§6.7 #4).
        */}
        <div className="order-1 w-full justify-self-center lg:justify-self-start">
          {/* Solid near-white with a barely-there vertical gradient — the reference's
              card samples 254–255 at the top and 249–251 through the body, which is a
              gradient of about 5 levels. Invisible as an effect, and the reason the
              panel does not read as a flat rectangle. */}
          <div className="mx-auto w-full rounded-xl bg-gradient-to-b from-white to-[#FAFAFB] p-14 shadow-panel">
            {/*
              The card LEADS with the mark, the wordmark and a subtitle — because that
              is what `login.png`'s card does, measured: mark 154–215, wordmark
              234–264, subtitle 276–289, and only then the greeting at 334.

              The previous pass put these on the art side instead and left the card
              starting cold at the greeting. That is most of why the panel read as a
              plain form: the reference's card is 838 px tall and a third of it is this
              identity block. Ours is now built the same way.

              Gaps below are the reference's, snapped to the 4 px grid:
              mark → wordmark 19 → 20 · wordmark → subtitle 12 · subtitle → greeting
              45 → 44.
            */}
            <div className="mb-11 flex flex-col items-center text-center">
              <BrandMark size={64} />
              <h1 className="mt-5 font-display text-[2.25rem] font-bold leading-none text-accent">
                {locale.appName}
              </h1>
              <p className="mt-3 text-base text-steel">{locale.appTagline}</p>
            </div>

            {children}
          </div>
        </div>

        {/*
          Art side, second → END edge (left) under RTL, as the reference has it.

          This is `login.png`'s left column with its illustration removed: a display
          headline, a supporting line, and the strip. The refused 3D podium is
          replaced by ambient light rather than by another graphic — a soft radial
          wash behind the headline, which is the one part of that illustration we can
          honestly keep, because light is not a picture of anything.
        */}
        <div className="relative order-2 flex flex-col items-center text-center lg:items-start lg:text-start">
          <span
            className="pointer-events-none absolute -start-24 -top-24 -z-10 h-[26rem] w-[26rem] rounded-pill bg-[radial-gradient(circle,rgba(15,110,86,0.14)_0%,rgba(15,110,86,0.05)_45%,transparent_70%)]"
            aria-hidden
          />
          {/* The reference's left headline is its largest type after the wordmark —
              30px bold there, and the thing that gives that column its weight. */}
          <h2 className="font-display text-[clamp(1.75rem,3vw,2.125rem)] font-bold leading-[1.25] text-ink">
            {locale.login.artHeadline}
          </h2>
          {/* Ink, not steel — measured, not assumed (§12.34).

              `steel` #6B7280 clears 4.5:1 on `canvas` by 0.007 (4.557). The art side
              no longer sits on canvas: it sits on `bg-auth-ground`, whose warm stop
              #EDF6F2 takes the same text to **4.39** — a real failure introduced by
              the ground this conversion added. I computed what the stop would have to
              be to rescue steel and the answer is "lighter than canvas", i.e. no warm
              ground at all. So the text changes and the ground keeps its character.

              Hierarchy is carried by SIZE and WEIGHT instead — the same resolution
              already recorded for `Notice` and for `Money`'s currency suffix. */}
          <p className="mt-4 max-w-md text-base leading-relaxed text-ink/80">{tagline}</p>

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
