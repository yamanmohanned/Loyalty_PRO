import { colors, motion } from '@walaa/config/tokens';

/**
 * React Native adapter for the shared design tokens.
 *
 * The token module is the single source of truth (CLAUDE.md §6.2), but it expresses
 * sizes as CSS strings for the web. React Native wants unitless numbers, so this
 * file re-expresses — never redefines — those values. Colours pass through
 * untouched, which is the part that must not drift.
 */

export const theme = {
  colors: {
    canvas: colors.canvas,
    surface: colors.surface,
    ink: colors.ink,
    steel: colors.steel,
    border: 'rgba(17,24,39,0.08)',
    accent: colors.accent,
    accentTint: colors.accentTint,
    amber: colors.amber,
    amberTint: colors.amberTint,
    danger: colors.red,
    dangerTint: colors.redTint,
    success: colors.green,
    successTint: colors.greenTint,
  },

  /** 8px rhythm (CLAUDE.md §6.5). */
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 },

  radius: { sm: 8, md: 12, lg: 16, pill: 999 },

  fontSize: { xs: 13, sm: 14, base: 16, lg: 18, xl: 22, xxl: 28, amount: 44 },

  fonts: {
    display: 'Cairo',
    body: 'IBMPlexSansArabic',
    /** All money and numerals (CLAUDE.md §6.3). */
    mono: 'IBMPlexMono',
  },

  /** Mobile primary actions are 52px; everything interactive is at least 48px (§6.4). */
  control: { min: 48, primary: 52 },

  motion,
} as const;

export type Theme = typeof theme;
