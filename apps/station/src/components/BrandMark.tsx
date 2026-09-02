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
 * that drifts from the icon at the first redraw. Served at 128 px for a 32–40 px
 * slot, which covers a 3× display without shipping bytes nobody sees.
 *
 * ── This asset is the OPAQUE one, deliberately ─────────────────────────────
 *
 * `customer_loyalty.ico` arrived with no transparency: every pixel alpha 255, a flat
 * `#EDEBEC` field around the glass tile. That was fixed **for the icon files** — the
 * ones Windows shows in the taskbar and the installer — because an opaque grey
 * square is exactly what a dark taskbar makes look broken. `src-tauri/icons/` is
 * keyed out and feathered now.
 *
 * `public/brand-mark.png` is **not**, and that is the decision rather than an
 * oversight. In-app the mark sits in a chip: a 24% radius and a hairline ring. A
 * transparent mark inside that chip would show the card straight through its
 * corners, leaving the ring drawn around empty space — worse than the problem it
 * solves. The chip wants a filled square, so it gets the original.
 *
 * The two assets are the same artwork with different alpha, chosen per context:
 * transparent where the OS composites it against an unknown background, opaque
 * where this component controls the background itself.
 *
 * A 1024 px master would still help: `icon.png` (512) and `Square310x310Logo.png`
 * are upscaled from a 256 source and will be softer than the rest.
 *
 * `alt=""` and `aria-hidden`: the product name sits beside it in text on every
 * screen that uses this, so announcing the mark would just repeat it.
 */
export function BrandMark({
  size = 40,
  className,
}: {
  /** Rendered px. The asset is 128, so anything up to ~42 stays crisp at 3×. */
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
      className={cn('shrink-0 select-none rounded-[24%] ring-1 ring-border', className)}
      style={{ width: size, height: size }}
      draggable={false}
    />
  );
}
