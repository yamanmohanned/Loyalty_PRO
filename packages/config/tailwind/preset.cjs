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
  /*
   * ── Pre-session atmosphere ────────────────────────────────────────────────
   *
   * The decorative layer `login.png` puts behind its content: a faint dot matrix
   * in one corner, thin circular orbit rings behind the hero, and a mint haze at
   * the edges. Everything here is ornament — `aria-hidden` by construction since
   * it is drawn in pseudo-elements, and `pointer-events: none`.
   *
   * **The 5% intensity cap is a computed number, not a judgement.** Accent over
   * canvas at various alphas produces these luma deltas:
   *
   *     0.030 -> 4.33%   OK
   *     0.040 -> 5.75%   over
   *     0.050 -> 7.15%   over
   *
   * So 0.03 is the ceiling for any accent-tinted ornament on this ground, and
   * every value below sits at or under it. Anything heavier stops being
   * atmosphere and starts being a pattern competing with the form.
   *
   * Two layers rather than one, because they have different jobs: `::before`
   * carries the dot matrix (corner texture) and `::after` the orbit rings (which
   * belong behind the art column). Both sit at z-index 0 with the content above,
   * so nothing here can ever land on top of a control.
   */
  addComponents({
    '.auth-atmosphere': { position: 'relative', isolation: 'isolate' },

    '.auth-atmosphere::before': {
      content: '""',
      position: 'absolute',
      inset: '0',
      zIndex: '-1',
      pointerEvents: 'none',
      /* A 24px dot matrix, faded out with a mask so it never reaches the card.
         Anchored to the END corner (left under RTL) — the reference puts its
         texture opposite the form. */
      backgroundImage: 'radial-gradient(rgba(15,110,86,0.03) 1px, transparent 1px)',
      backgroundSize: '24px 24px',
      backgroundPosition: '0 0',
      maskImage: 'radial-gradient(70% 55% at 0% 8%, #000 0%, transparent 72%)',
      WebkitMaskImage: 'radial-gradient(70% 55% at 0% 8%, #000 0%, transparent 72%)',
    },

    '.auth-atmosphere::after': {
      content: '""',
      position: 'absolute',
      inset: '0',
      zIndex: '-1',
      pointerEvents: 'none',
      /* Thin concentric orbit rings behind the art column, plus three sparkles.
         Rings are 1px bands cut out of a radial gradient — cheaper and crisper
         than borders, and they scale with the viewport because the centre is a
         percentage. */
      backgroundImage: [
        'radial-gradient(circle at 22% 38%, transparent 178px, rgba(15,110,86,0.03) 179px, rgba(15,110,86,0.03) 180px, transparent 181px)',
        'radial-gradient(circle at 22% 38%, transparent 258px, rgba(15,110,86,0.022) 259px, rgba(15,110,86,0.022) 260px, transparent 261px)',
        'radial-gradient(circle at 14% 20%, rgba(15,110,86,0.03) 1.5px, transparent 2px)',
        'radial-gradient(circle at 31% 61%, rgba(15,110,86,0.03) 1.5px, transparent 2px)',
        'radial-gradient(circle at 9% 55%, rgba(15,110,86,0.025) 1px, transparent 1.5px)',
      ].join(', '),
      backgroundRepeat: 'no-repeat',
    },

    /* Ornament is the first thing to go when the viewer has asked for less.
       Forced colours and reduced transparency both mean "stop decorating". */
    '@media (prefers-reduced-transparency: reduce), (forced-colors: active)': {
      '.auth-atmosphere::before, .auth-atmosphere::after': { display: 'none' },
    },
  });

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
        /*
          The reference's FIELD border, measured: rgb(227,227,229) on its near-white
          card. Solving 255(1−a) + 17a = 227 gives a = 0.117.

          It is deliberately stronger than `border` — in `login.png` a panel's edge is
          a whisper and an input's edge is a statement, because one is separating
          surfaces and the other is marking a target you have to hit. Using one token
          for both is what made our fields look like faint rectangles beside it.
        */
        'border-strong': 'rgba(17,24,39,0.12)',
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
        /*
          MEASURED off `login.png`, not chosen.

          The card's corner arc was sampled at four depths and solved for r:
          inset 15px at 2px down, 6px at 8px down, 3px at 12px down — all three
          fit r ≈ 24. The controls inside it solve to ≈ 12 (`md`), so the panel is
          exactly twice its contents' radius, which is why the card reads as soft
          while the buttons still read as controls.
        */
        xl: '24px',
        pill: '999px',
      },
      boxShadow: {
        card: '0 1px 2px rgba(17,24,39,0.04), 0 8px 24px rgba(17,24,39,0.04)',
        raised: '0 2px 4px rgba(17,24,39,0.06), 0 12px 32px rgba(17,24,39,0.06)',
        /*
          V4-4 — the reference's panel elevation, which is wider and softer than
          anything we had, and tinted with the brand hue rather than neutral grey.

          That tint is the whole difference between "a box with a shadow" and the
          reference's sense that the panel is floating on a warm ground. It is very
          low alpha: a shadow that reads as colour has stopped being a shadow.

          NOT a glow (§6.4, §11) — the offset is downward and the spread is wide and
          diffuse. The reference's neon rim under its primary button is refused
          separately; this is elevation.
        */
        /*
          MEASURED off `login.png` by sampling luma outward from the card edge.

          | direction | at edge+4px | recovers to ground by |
          |-----------|-------------|-----------------------|
          | sides     | −25 levels  | ~40 px                |
          | below     | −13 levels  | ~40 px                |
          | above     | −10 levels  | ~40 px                |

          Two things follow, and the first is why the earlier attempt looked flat:
          the shadow is **present right at the edge**, not a distant halo. The
          previous value used −8px and −24px spreads, which pull the darkness away
          from the border exactly where the reference puts it.

          Second, it is stronger at the sides than above — the signature of a large
          blur with a small downward offset, not of a big vertical drop. Hence a
          tight layer at 1px, a broad one at 8px with a small negative spread, and a
          wide diffuse layer for the falloff.

          Neutral, not brand-tinted: the sampled shadow is grey. Tinting it was an
          invention of mine that the reference does not support.
        */
        panel:
          // The leading `inset` is the reference's inner highlight: its card samples
          // 254-255 at the rim against 249-251 through the body, which is a light
          // edge and not a border. It is what stops a large flat panel from looking
          // die-cut.
          'inset 0 1px 0 rgba(255,255,255,0.9), 0 1px 1px rgba(17,24,39,0.04), 0 8px 24px -4px rgba(17,24,39,0.12), 0 24px 56px -12px rgba(17,24,39,0.07)',
        none: 'none',
      },
      spacing: {
        control: '48px',
        'control-mobile': '52px',
        // `login.png`'s fields and buttons both measure 58px tall; 56 is the 8px-grid
        // step beside it (§6.5) and the height every auth control now uses.
        field: '56px',
        // 288 rather than 264: the v4 rail header carries the mark at 64px (§2.5).
        // Measured rather than guessed, and the first guess was wrong — the preset's
        // own `text-xl` is 22px, not the 20 assumed, so 'Customer loyalty' came to
        // 161px against a 158px box and wrapped to two lines. It renders at 18px now
        // (132px) inside a 158px budget: 26px of slack, so a font-loading difference
        // cannot push it over. At 264 the budget is 136 and the slack is 4px, which
        // is the kind of margin that breaks quietly on someone else's machine.
        rail: '288px',
      },
      maxWidth: {
        content: '1440px',
      },
      backgroundImage: {
        /*
          The pre-session ground.

          `login.png` does not sit its card on a flat colour — the page warms towards
          the brand hue at one corner and falls back to the canvas everywhere else.
          It is what stops a centred card from looking like a dialog on an empty page.

          Anchored at 100% 0% so under `dir="rtl"` the warm corner is the TOP-START
          edge, matching the reference once mirrored (§6.7 #4).
        */
        'auth-ground':
          'radial-gradient(110% 80% at 100% 0%, #EDF6F2 0%, #F5F8F7 38%, #F7F8FA 72%)',
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
