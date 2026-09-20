import type { CaptureMode, CustomerCategory } from '@loyalty-pro/shared-types';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  CHART COLOUR — computed, not chosen (2026-09-02)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * §6.2 gives the product **one** accent and reserves amber, red and green for
 * status. That is right for the UI and insufficient for a chart: a single accent
 * cannot tell five capture modes apart, and painting a fifth series in the warning
 * amber would make a colour that means "something is wrong" mean "series 4"
 * instead.
 *
 * So charts get their own categorical scale, and it is **anchored on the brand
 * accent and validated rather than picked by eye**. Every value below came out of
 * `dataviz/scripts/validate_palette.js`, and the numbers it reported are recorded
 * here so a future edit can be checked against them rather than argued about.
 *
 * ── Slot 1 is the brand teal, stepped once ─────────────────────────────────
 *
 * `#0F6E56` itself **fails the chroma floor** — OKLCH C 0.091 against a 0.10 floor,
 * which is the threshold below which a hue stops reading as an identity and starts
 * reading as grey. `#0E7C60` is the nearest step in the same hue that clears it
 * (hue spread from the brand accent: under 4°). The UI keeps `#0F6E56` everywhere
 * else; this is a chart-only substitution with a measured reason.
 *
 * ── The order is the safety mechanism, not a preference ────────────────────
 *
 * All 24 orderings of the four non-status hues were enumerated against the
 * validator and this one maximises the worst adjacent pair. Reported for light mode
 * on both app surfaces:
 *
 * | Check                | Result                                            |
 * |----------------------|---------------------------------------------------|
 * | Lightness band       | PASS — all 5 inside L 0.43–0.77                   |
 * | Chroma floor         | PASS — all 5 ≥ 0.10                               |
 * | CVD separation       | PASS — worst adjacent ΔE 18.5 (deutan), target ≥8 |
 * | Normal-vision floor  | PASS — worst adjacent ΔE 19.3, floor ≥15          |
 * | Contrast vs surface  | WARN — magenta 2.69:1 on #FFFFFF, 2.53 on #F7F8FA |
 *
 * **The contrast WARN is not dismissable — it obligates a relief channel.** Every
 * chart built on this palette therefore ships a visible direct label on every series
 * and a table view, which is also what the operator asked for: *never carry meaning
 * by colour alone.*
 *
 * ── Amber, red and green are deliberately absent ───────────────────────────
 *
 * They are §6.2's status colours. A status colour that also means "series 4" is a
 * colour that has stopped meaning anything.
 */

/** The five categorical slots, in validated order. Never cycled, never extended. */
export const SERIES = [
  '#0E7C60', // 1 — brand teal, stepped to clear the chroma floor
  '#2A78D6', // 2 — blue
  '#EB6834', // 3 — orange
  '#4A3AA7', // 4 — violet
  '#E87BA4', // 5 — magenta (2.69:1 — direct labels are its relief)
] as const;

/**
 * The tier ladder is **ordinal**, not categorical: swapping two tiers would change
 * what the chart says, so the order has to be visible in the colour. One hue,
 * monotone lightness.
 *
 * Validated with `--ordinal`: lightness monotone PASS · adjacent ΔL ≥ 0.06 PASS ·
 * light-end contrast 2.11:1 PASS (floor 2.0) · single hue PASS (spread 4°).
 *
 * The light end went through three rounds before it cleared: `#9EDCC7` and
 * `#6BC9AD` both looked fine and measured 1.55:1 and 1.98:1. This is the case the
 * skill makes for running the script — the eye cannot see a 2:1 boundary.
 */
export const TIER_RAMP = ['#5FC4A7', '#35A688', '#178B71', '#0C715C', '#075244'] as const;

/**
 * Colour follows the ENTITY, never its position in the array.
 *
 * A capture mode that stops appearing must not repaint the ones that remain: a
 * manager who learned that the orange bar is the serial bridge should not find
 * orange meaning something else next week because one mode went quiet. Both maps
 * are keyed by the enum, so a filtered response cannot shift an assignment and
 * there is no index to cycle past.
 */
export const CAPTURE_MODE_COLOR: Readonly<Record<CaptureMode, string>> = {
  SPOOL_WATCH: SERIES[0],
  VIRTUAL_PRINTER: SERIES[1],
  SERIAL_BRIDGE: SERIES[2],
  NETWORK_PROXY: SERIES[3],
  MANUAL: SERIES[4],
};

export const CATEGORY_COLOR: Readonly<Record<CustomerCategory, string>> = {
  REGULAR: SERIES[0],
  WHOLESALE: SERIES[1],
  VIP: SERIES[3],
};

/**
 * An unknown enum value still needs a colour — a mode the server grew and this
 * build has not heard of. Grey, deliberately: it says "not one of the known
 * things" rather than impersonating a slot that means something else.
 */
export const UNKNOWN_SERIES = '#9CA3AF';

export const colorForCaptureMode = (mode: string): string =>
  CAPTURE_MODE_COLOR[mode as CaptureMode] ?? UNKNOWN_SERIES;

export const colorForCategory = (category: string): string =>
  CATEGORY_COLOR[category as CustomerCategory] ?? UNKNOWN_SERIES;

/** A step of the tier ramp, clamped so a sixth tier reuses the darkest rather than crashing. */
export const colorForTier = (index: number): string =>
  TIER_RAMP[Math.min(index, TIER_RAMP.length - 1)] ?? TIER_RAMP[TIER_RAMP.length - 1]!;

/* ── Chrome ────────────────────────────────────────────────────────────────── */

/**
 * Grid, axis and ink tokens, matching §6.2 so a chart sits inside a card rather
 * than on top of it. Solid hairlines, never dashed: dashing reads as "projection"
 * or "threshold" when it is only a grid.
 */
export const VIZ = {
  grid: 'rgba(17,24,39,0.06)',
  axisInk: '#6B7280',
  surface: '#FFFFFF',
  canvas: '#F7F8FA',
  /**
   * The ABSENCE of a category, never a category.
   *
   * The unattributed share of captured invoices is not a second series — it is what
   * is left when the first one is taken away, and painting it from `SERIES` would
   * claim a symmetry that is not there. `border` at one step stronger, so the wedge
   * reads as the ring's unfilled remainder.
   *
   * It lived as a literal `rgba(17,24,39,0.14)` inside the Overview screen, which is
   * exactly the kind of value that gets copied to a second screen and then drifts.
   */
  absence: 'rgba(17,24,39,0.14)',
  /** The 2px separation between adjacent fills, drawn as surface rather than a border. */
  gap: 2,
  /** Data-ends are rounded; the baseline end is square so bars sit on the axis. */
  radius: 4,
} as const;

/**
 * Recharts' `<Tooltip contentStyle>`, in one place.
 *
 * Two screens had their own copy of this object and they had already drifted apart in
 * padding. It is a style, not a token set, so it lives here beside the chrome it has
 * to match rather than in the Tailwind preset, which cannot express it.
 *
 * `direction: 'rtl'` is not cosmetic: recharts renders the tooltip in an absolutely
 * positioned div outside the chart's own flow, and without it the currency suffix
 * lands on the wrong side of the digits.
 */
export const TOOLTIP_STYLE = {
  borderRadius: 12,
  border: '1px solid rgba(17,24,39,0.08)',
  boxShadow: '0 8px 24px rgba(17,24,39,0.08)',
  fontFamily: 'IBM Plex Sans Arabic, sans-serif',
  fontSize: 13,
  padding: '8px 12px',
  direction: 'rtl',
} as const;

/**
 * The glow the operator asked for, kept where it cannot cost legibility.
 *
 * It is a **shadow cast beneath the mark**, never a halo around the data and never a
 * brightness lift on the fill. Contrast between a series and the surface is the
 * thing the validator measured, and anything that alters the fill invalidates that
 * measurement — so the fill keeps the exact hex above, the effect is a separate
 * `feDropShadow` layer, and every series still carries a written label.
 *
 * Two stops: a tight dark shadow for depth, and a wide tinted one for the light
 * bloom. Both are well under the mark, so the bar's own edge stays crisp.
 */
export const GLOW = {
  /** id of the shared SVG filter; defined once per chart. */
  id: 'loyalty-viz-glow',
  shadow: { dx: 0, dy: 2, stdDeviation: 3, flood: 'rgba(17,24,39,0.18)' },
  bloom: { dx: 0, dy: 6, stdDeviation: 10, floodOpacity: 0.28 },
} as const;
