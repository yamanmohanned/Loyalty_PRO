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

/**
 * ── Glass (2026-09-02) ─────────────────────────────────────────────────────
 *
 * A surface treatment, not a new palette: the colours below are §6.2's white and
 * ink at reduced alpha, and nothing else changes.
 *
 * **Where it goes was decided by arithmetic, not by taste.** Text contrast through a
 * translucent surface depends on what is behind it, so the two backdrops this
 * product actually has were measured — there is no photographic background anywhere,
 * so the worst case is bounded and computable:
 *
 * | Surface sits over | ink #1A1D21 | steel #6B7280 |
 * |---|---|---|
 * | the canvas #F7F8FA (α 0.78) | 16.6:1 | **4.76:1** |
 * | content — a chart bar, the accent (α 0.92) | 15.0:1 | **4.30:1** |
 * | the guide's dim scrim (α 0.88) | 15.1:1 | **4.32:1** |
 *
 * So the rule, and it is a hard one:
 *
 *  - `.glass` — sits on the canvas with nothing behind it. **Any text.** Steel
 *    clears 4.5:1 here and only here.
 *  - `.glass-panel` — overlaps other content: a sticky bar, a floating toolbar.
 *    **Ink and controls only, never steel body text.** Steel does not reach 4.5:1
 *    over content at ANY practical alpha — not even at 1.0, where it measures
 *    4.83:1 on pure white and has nowhere left to go. A panel that must carry
 *    secondary prose stays opaque; that is not a limitation to design around, it is
 *    the answer.
 *  - `.glass-scrim` — the dimmer behind a dialog. The dialog itself stays opaque,
 *    for the reason above: an overlay's body text is exactly the steel-over-content
 *    case.
 *
 * Never on: dense data tables, small text, chart surfaces (the categorical palette
 * in `viz.ts` was validated against a SOLID surface — translucency changes the
 * effective background and invalidates every contrast number in it), or the printed
 * slip preview, which is a picture of paper.
 *
 * `backdrop-filter` degrades to the flat translucent fill where unsupported, which
 * is why the alpha is high enough to carry the contrast on its own.
 */
const glass = ({ addComponents }) => {
  const base = {
    backdropFilter: 'blur(16px) saturate(1.6)',
    WebkitBackdropFilter: 'blur(16px) saturate(1.6)',
    border: '1px solid rgba(255,255,255,0.55)',
    /* The hairline highlight along the top edge is what makes it read as glass
       rather than as a faded card — light catching an edge, not a lower opacity. */
    boxShadow:
      'inset 0 1px 0 rgba(255,255,255,0.75), 0 1px 2px rgba(17,24,39,0.05), 0 12px 32px rgba(17,24,39,0.07)',
  };

  /*
   * The selectors are DOUBLED — `.glass.glass` — and that is not a typo.
   *
   * `addComponents` writes into Tailwind's `components` layer, which loses to the
   * `utilities` layer that carries `bg-surface` and `shadow-card`. Every card in
   * this product already wears those, so a single-class `.glass` applied on top
   * computed to `backdrop-filter: none` and an opaque white — present in the DOM,
   * doing nothing, and looking exactly like a card. Found by reading the computed
   * style in the running app rather than by trusting the class name (§12.20's
   * habit, applied to CSS).
   *
   * Doubling raises specificity to 0,2,0 so it beats a single utility class without
   * `!important`, and without the caller having to strip the utilities it is
   * replacing.
   */
  addComponents({
    '.glass.glass': { ...base, backgroundColor: 'rgba(255,255,255,0.78)' },
    '.glass-panel.glass-panel': { ...base, backgroundColor: 'rgba(255,255,255,0.92)' },
    '.glass-scrim.glass-scrim': {
      backgroundColor: 'rgba(26,29,33,0.45)',
      backdropFilter: 'blur(6px)',
      WebkitBackdropFilter: 'blur(6px)',
    },
    /* Forced-colors and reduced-transparency both mean "stop doing this". */
    '@media (prefers-reduced-transparency: reduce), (forced-colors: active)': {
      '.glass.glass, .glass-panel.glass-panel': {
        backgroundColor: '#FFFFFF',
        backdropFilter: 'none',
        WebkitBackdropFilter: 'none',
      },
      '.glass-scrim.glass-scrim': {
        backgroundColor: 'rgba(26,29,33,0.72)',
        backdropFilter: 'none',
      },
    },
  });
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
  plugins: [glass],
};
