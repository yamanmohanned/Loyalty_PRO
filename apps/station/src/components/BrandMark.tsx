import { cn } from './ui';

/**
 * The product mark (operator-supplied, 2026-09-02).
 *
 * Replaces the placeholder that stood here: a teal square with the letterform «و»,
 * written when there was no brand asset (CLAUDE_v2.md §5.3 step 3 explicitly called
 * it a stand-in to be replaced before distribution). The real mark now exists, so
 * the stand-in goes.
 *
 * It is the same artwork the installer and the taskbar show. That is the point of a
 * mark: the thing on the Start menu and the thing in the top corner of the window
 * have to be recognisably one product, and two drawings of a brand are two brands.
 *
 * ── Why an `<img>` and not an inline SVG ───────────────────────────────────
 *
 * The supplied asset is a raster with gradients, soft shadows and a glass tile —
 * there is no vector to inline, and tracing one would produce a *different* mark
 * that drifts from the icon at the first redraw. Served at 160 px for a 36–56 px
 * slot, which covers a 3× display without shipping bytes nobody sees.
 *
 * ── The chip is gone, because the asset it existed for is gone ─────────────
 *
 * The first `customer_loyalty.ico` was fully opaque, with a flat grey field around
 * the artwork. On a white card that read as a grey square with hard corners, so the
 * mark wore a rounded chip and a hairline ring to hide the edge.
 *
 * The operator then supplied a **transparent 1312×1199 master**, which removes the
 * problem at the source. Rendered inside the old chip, the ring now draws a rounded
 * box around four empty corners — a border around a picture rather than an icon.
 * Both were rendered and compared before this was changed; plain won, and the
 * artwork's own silhouette is the shape, which is what a transparent mark is for.
 *
 * That is scaffolding removed, not a design altered: the chip was a workaround for
 * an asset property that no longer exists.
 *
 * The same master feeds `src-tauri/icons/` and this file, so the taskbar, the
 * installer and the top corner of the window are one drawing. At 1024 square it is
 * above every frame §5.2 asks for, so **nothing is upscaled any more**.
 *
 * `alt=""` and `aria-hidden`: the product name sits beside it in text on every
 * screen that uses this, so announcing the mark would just repeat it.
*
 * ── The asset is 384 px, re-exported from the master (v4 §2.5) ────────────
 *
 * It shipped at **160 px**, which covers a ~53 px slot at 3× and no more — and §2.5
 * asks for the mark at size, which the login screens now render at 112–120 px. So it
 * was re-exported from the transparent master `LOGO_2.png` (1312×1199 RGBA): uniform
 * scale into a transparent square, centred. Nothing cropped, redrawn or recoloured.
 * 384 px covers a 128 px render at 3× and costs 171 KB against the old 37 KB, on a
 * LAN-served app that caches it.
 *
 * **A correction worth keeping, because the mistake is easy to repeat.** The first
 * reading of this said the re-export would change the mark's framing, because the
 * master's alpha bounding box measured 1296×1181 — aspect 1.097 — against the shipped
 * file's 0.972. That comparison was wrong: `getbbox()` on an alpha channel reports any
 * pixel above zero, so it was measuring anti-alias haze across the master's whole
 * canvas rather than the mark. Thresholding alpha at a visible level gives the master
 * **1126×1163, aspect 0.968** — the same shape as the shipped mark and as the new
 * export. The framing did not change; only the resolution did.
 *
 * That is §12.27's measuring-instrument corollary landing twice in one session: a
 * number that did not match the situation was a defect in the measurement, not in the
 * thing measured.
 */
export function BrandMark({
  size = 40,
  className,
}: {
  /** Rendered px. The asset is 160, so anything up to ~53 stays crisp at 3×. */
  size?: number;
  className?: string;
}) {
  return (
    <img
      src="/brand-mark.png"
      alt=""
      aria-hidden
      width={size}
      height={size}
      /* Explicit width/height above AND a fixed box here: the intrinsic size is
         known, so the layout never shifts while the image decodes (§8, CLS < 0.1). */
      className={cn('shrink-0 select-none', className)}
      style={{ width: size, height: size }}
      draggable={false}
    />
  );
}
