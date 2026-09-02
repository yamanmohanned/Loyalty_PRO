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
 * ── The asset is opaque, so it is rendered as a chip ───────────────────────
 *
 * `customer_loyalty.ico` has **no transparency** — every one of its 65,536 pixels
 * is alpha 255, and a flat `#EDEBEC` field surrounds the glass tile with roughly
 * 11% padding. Dropped onto a white card that field reads as a grey square patch
 * with hard corners.
 *
 * So it wears a 24% corner radius and a hairline ring: the square edge stops
 * cutting against the surface, and the result reads as an app-icon chip, which is
 * what it is. **The artwork itself is untouched** — keying the field out would
 * halo the soft glass edges, and re-drawing a supplied brand mark is not this
 * component's business.
 *
 * A transparent 1024 px master would remove the need for the chip and would also
 * stop `icon.png` (512) and `Square310x310Logo.png` being upscaled from 256.
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
