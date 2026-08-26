/**
 * Shared Tailwind preset for Walaa (CLAUDE.md §6).
 *
 * RTL note: this preset deliberately exposes NO physical-direction spacing aliases.
 * Use Tailwind's logical utilities (ps-/pe-/ms-/me-/start-/end-/text-start/text-end)
 * so every screen mirrors correctly under `dir="rtl"` without a second stylesheet.
 */

/** Kept in sync with packages/config/src/tokens.ts — that file is the source of truth. */
const colors = {
  canvas: '#F7F8FA',
  surface: '#FFFFFF',
  ink: '#1A1D21',
  steel: '#6B7280',
  accent: {
    DEFAULT: '#0F6E56',
    tint: '#E1F5EE',
  },
  amber: {
    DEFAULT: '#B26B00',
    tint: '#FDF3E3',
  },
  danger: {
    DEFAULT: '#B0322E',
    tint: '#FBEAE9',
  },
  success: {
    DEFAULT: '#1E7B4D',
    tint: '#E4F4EB',
  },
};

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  theme: {
    extend: {
      colors: {
        ...colors,
        border: 'rgba(17,24,39,0.08)',
      },
      fontFamily: {
        display: ['Cairo', 'Noto Sans Arabic', 'Tahoma', 'sans-serif'],
        sans: ['IBM Plex Sans Arabic', 'Noto Sans Arabic', 'Tahoma', 'sans-serif'],
        mono: ['IBM Plex Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      fontSize: {
        xs: ['0.8125rem', { lineHeight: '1.5' }],
        sm: ['0.875rem', { lineHeight: '1.55' }],
        base: ['1rem', { lineHeight: '1.6' }],
        lg: ['1.125rem', { lineHeight: '1.55' }],
        xl: ['1.375rem', { lineHeight: '1.4' }],
        '2xl': ['1.75rem', { lineHeight: '1.3' }],
        '3xl': ['2.25rem', { lineHeight: '1.2' }],
        amount: ['2.75rem', { lineHeight: '1.1', fontWeight: '700' }],
      },
      borderRadius: {
        sm: '8px',
        md: '12px',
        lg: '16px',
        pill: '999px',
      },
      boxShadow: {
        card: '0 1px 2px rgba(17,24,39,0.04), 0 8px 24px rgba(17,24,39,0.04)',
        raised: '0 2px 4px rgba(17,24,39,0.06), 0 12px 32px rgba(17,24,39,0.06)',
        none: 'none',
      },
      spacing: {
        control: '48px',
        'control-mobile': '52px',
        rail: '264px',
      },
      maxWidth: {
        content: '1440px',
      },
      transitionTimingFunction: {
        native: 'cubic-bezier(0.32, 0.72, 0, 1)',
      },
      transitionDuration: {
        fast: '150ms',
        base: '220ms',
        slow: '300ms',
      },
      keyframes: {
        /** Skeletal shimmer — CLAUDE.md §6.4 bans circular spinners. */
        shimmer: {
          '100%': { transform: 'translateX(-100%)' },
        },
        /** The one hero animation: scan-success confirmation (§6.6). */
        'scan-success': {
          '0%': { opacity: '0', transform: 'scale(0.88)' },
          '60%': { opacity: '1', transform: 'scale(1.04)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
      },
      animation: {
        shimmer: 'shimmer 1.6s infinite',
        'scan-success': 'scan-success 320ms cubic-bezier(0.32, 0.72, 0, 1) both',
      },
    },
  },
  plugins: [],
};
