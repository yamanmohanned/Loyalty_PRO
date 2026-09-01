# Design System: Supermarket Loyalty Platform
## 1. Visual Theme & Atmosphere
A calm, confident, retail-grade interface built for speed and clarity under real-world
pressure (queues, glare, tired eyes). The mood is "clean operations dashboard" — precise,
trustworthy, and quietly premium, like modern fintech tooling. Density is balanced
(4–5 on a 1–10 scale): information-rich but never cramped. Layouts favor calm asymmetry
over rigid symmetric grids. Motion is fluid but restrained (5/10) — it confirms actions,
never decorates. Every screen must feel instantly legible to a cashier's assistant who
has 3 seconds and a customer waiting.
## 2. Color Palette & Roles
- **Canvas** (#F7F8FA) — Primary background surface, soft off-white
- **Pure Surface** (#FFFFFF) — Cards, panels, containers
- **Charcoal Ink** (#1A1D21) — Primary text (never pure black)
- **Muted Steel** (#6B7280) — Secondary text, metadata, timestamps
- **Whisper Border** (rgba(17,24,39,0.08)) — 1px structural hairlines, dividers
- **Deep Teal** (#0F6E56) — SINGLE accent: primary CTAs, active states, focus rings,
  brand identity. Saturation kept below 80%.
- **Teal Tint** (#E1F5EE) — Accent background wash for active/selected states, success chips
- **Signal Amber** (#B26B00) — Warnings, "approaching threshold", pending states (semantic only)
- **Signal Red** (#B0322E) — Errors, duplicate-invoice alerts, destructive actions (semantic only)
- **Signal Green** (#1E7B4D) — Confirmed success, completed transactions (semantic only)
Rule: ONE brand accent (Deep Teal). Amber/Red/Green appear ONLY to carry status meaning,
never decoratively. No purple, no neon, no gradient glows.
## 3. Typography Rules
- **Display / Headlines:** "Cairo" (Arabic) — weight-driven hierarchy, track-tight,
  controlled scale. Never oversized-screaming.
- **Body / UI:** "IBM Plex Sans Arabic" — relaxed leading (1.6), high legibility at small sizes.
- **Numerals / Amounts:** "IBM Plex Mono" for all currency figures, totals, thresholds,
  and cumulative balances — monospace keeps digits aligned in tables and cards.
- **Banned:** Inter, generic system fonts, any serif (this is operational software UI).
- Base body size 16px minimum. Amounts rendered large and bold in monospace.
## 4. Component Stylings
- **Buttons:** Flat, no outer glow. Primary = solid Deep Teal fill, white text.
  Secondary = ghost with Whisper Border. Tactile 1px press-down on active. Min height 48px.
- **Cards:** Rounded corners (16px). Diffused, near-invisible shadow tinted to background hue.
  Used only when elevation communicates grouping. Prefer border-top dividers in dense tables.
- **Inputs:** Label ABOVE the field (never placeholder-only). Helper text below.
  Error text below in Signal Red. Focus ring in Deep Teal. Min height 48px. Large tap targets.
- **Amount fields:** Oversized monospace input, currency suffix "د.ع" pinned inside the field.
- **Loaders:** Skeletal shimmer blocks matching exact layout dimensions. NEVER circular spinners.
- **Empty States:** Composed illustration + one-line guidance + single primary action.
  Never a bare "No data".
- **Status chips:** Pill-shaped, tinted background from the semantic color's lightest stop,
  text in that color's darkest stop. Never black text on colored fills.
## 5. Layout Principles
- CSS Grid over flexbox math. Max-width containment (dashboard: 1440px centered).
- No overlapping elements — every element owns a clean spatial zone.
- Dashboard uses a fixed right-side navigation rail (RTL) + fluid content area.
- Mobile app: single-column, thumb-zone-first, primary action pinned to bottom.
- Full-height sections use min-h-[100dvh], never h-screen.
- Generous internal padding: cards 24px (web) / 16px (mobile). 8px spacing rhythm throughout.
## 6. Motion & Interaction
- Micro-interactions 150–300ms, native easing. Spring feel on confirmations
  (stiffness ~100, damping ~20). No linear easing.
- Scan-success moment: a brief, satisfying check-mark confirmation with subtle scale +
  fade — the single "hero" animation of the whole system, because it's the core loop.
- Staggered cascade reveals for lists (short delays). Animate transform + opacity only.
- Respect prefers-reduced-motion.
## 7. Direction & Localization
- **RTL is mandatory.** All layouts mirror right-to-left. Navigation rail on the RIGHT.
  Icons that imply direction (arrows, chevrons) flip. Text aligns right.
- All UI copy in Modern Standard Arabic as specified per screen.
- Currency: Iraqi Dinar, shown as "د.ع" after the amount. Digits may be Western or Arabic-Indic.
## 8. Anti-Patterns (Banned)
- No emojis anywhere (use vector/line icons — Lucide/Phosphor style).
- No Inter font. No serif fonts. No pure black (#000000).
- No neon or outer-glow shadows. No oversaturated accents. No purple/blue "AI" gradients.
- No gradient text on headers. No custom mouse cursors.
- No overlapping elements. No 3-equal-column card rows (use asymmetric or 2-col zig-zag).
- No generic placeholder names ("John Doe", "Acme") — use realistic Iraqi names.
- No fake round numbers (99.99%). No AI clichés ("Elevate", "Seamless", "Unleash").
- No filler UI text ("Scroll to explore", bouncing chevrons). No circular loading spinners.