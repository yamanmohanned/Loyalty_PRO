/**
 * Walaa design tokens — the single source of truth for colour, type, spacing,
 * radius and motion across web (Tailwind preset) and native (React Native styles).
 *
 * Authority: CLAUDE.md §6.2–§6.6. Where the exported Stitch screens disagree with
 * these values, these values win (CLAUDE.md §6 preamble).
 */

/** One brand accent. Semantic colours carry status meaning only, never decoration. */
export const colors = {
  /** Primary background surface, soft off-white. */
  canvas: '#F7F8FA',
  /** Cards, panels, containers. */
  surface: '#FFFFFF',
  /** Primary text. Never pure black. */
  ink: '#1A1D21',
  /** Secondary text, metadata, timestamps. */
  steel: '#6B7280',
  /** 1px structural hairlines and dividers. */
  border: 'rgba(17,24,39,0.08)',

  /** THE single brand accent (Deep Teal): primary CTAs, active states, focus rings. */
  accent: '#0F6E56',
  /** Accent background wash. */
  accentTint: '#E1F5EE',

  /** Semantic — warning / approaching a threshold. */
  amber: '#B26B00',
  amberTint: '#FDF3E3',
  /** Semantic — error / duplicate invoice. */
  red: '#B0322E',
  redTint: '#FBEAE9',
  /** Semantic — success / invoice linked. */
  green: '#1E7B4D',
  greenTint: '#E4F4EB',
} as const;

/**
 * Font families. Banned: Inter, any serif, generic system fonts (CLAUDE.md §6.3).
 * Fallbacks are Arabic-capable faces, never a bare `sans-serif`.
 */
export const fonts = {
  /** Display / headings. */
  display: ['Cairo', 'Noto Sans Arabic', 'Tahoma', 'sans-serif'],
  /** Body / UI. */
  body: ['IBM Plex Sans Arabic', 'Noto Sans Arabic', 'Tahoma', 'sans-serif'],
  /** All money and numerals — monospace keeps digits aligned in tables and cards. */
  mono: ['IBM Plex Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
} as const;

/** Base body is 16px minimum; amounts render large, bold and monospace. */
export const fontSize = {
  xs: '0.8125rem', // 13px — metadata only, never body copy
  sm: '0.875rem', // 14px
  base: '1rem', // 16px — minimum body size
  lg: '1.125rem', // 18px
  xl: '1.375rem', // 22px
  '2xl': '1.75rem', // 28px
  '3xl': '2.25rem', // 36px
  amount: '2.75rem', // 44px — the oversized amount field
} as const;

/** 8px spacing rhythm throughout (CLAUDE.md §6.5). */
export const spacing = {
  0.5: '4px',
  1: '8px',
  2: '16px',
  3: '24px',
  4: '32px',
  5: '40px',
  6: '48px',
  8: '64px',
  10: '80px',
} as const;

export const radius = {
  sm: '8px',
  md: '12px',
  /** Cards (CLAUDE.md §6.4). */
  lg: '16px',
  pill: '999px',
} as const;

/** Diffused, near-invisible shadows tinted to the background hue. No neon, no glow. */
export const shadow = {
  card: '0 1px 2px rgba(17,24,39,0.04), 0 8px 24px rgba(17,24,39,0.04)',
  raised: '0 2px 4px rgba(17,24,39,0.06), 0 12px 32px rgba(17,24,39,0.06)',
} as const;

/** Minimum interactive sizes — large tap targets under queue pressure. */
export const size = {
  control: '48px',
  /** Mobile primary actions (CLAUDE.md §6.4). */
  controlMobile: '52px',
  navRail: '264px',
  contentMax: '1440px',
} as const;

/** Micro-interactions 150–300ms, native easing. Never linear. */
export const motion = {
  fast: 150,
  base: 220,
  slow: 300,
  easing: 'cubic-bezier(0.32, 0.72, 0, 1)',
  /** Spring feel on confirmations — the scan-success hero moment. */
  spring: { stiffness: 100, damping: 20, mass: 1 },
} as const;

export const tokens = {
  colors,
  fonts,
  fontSize,
  spacing,
  radius,
  shadow,
  size,
  motion,
} as const;

export type Tokens = typeof tokens;
export type ColorToken = keyof typeof colors;
