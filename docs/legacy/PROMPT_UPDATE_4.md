# PROMPT_UPDATE_4.md — Execution Directive (v4)

> Paste this into Claude Code. It governs the v4 batch.

---

## First actions — before any code

1. **Read in order, in full:** `CLAUDE.md` → `CLAUDE_v2.md` → `CLAUDE_v3.md` →
   `CLAUDE_UPDATE_4.md`. Highest version wins on conflict.
2. **Read the design reference images** in the project folder: `dashboard`, `customers`,
   `role`, `cards`, `recovery`, `report`, `login`, `customer_found`, `card_reprint`.
   If any is missing, say which and stop — do not guess.
3. **Report your plan** for the phases below, plus any genuine blocking questions.
4. **Do not write code until I confirm.**

---

## Process rules

- **This is a working system.** Nothing here is a rebuild. Preserve behaviour, performance,
  and every guarantee already established unless this batch explicitly changes it.
- **One phase at a time, one commit per phase.** Do not batch.
- **Evidence, always.** Run it, show the output. `verification-before-completion` at every
  boundary.
- **Verify UI through the real running apps** with `agent-browser` (§12.20). Source review
  does not count. Anything formatted for a human gets a rendered check (§12.27).
- **Push back** if any instruction here is wrong. That has repeatedly prevented real failures
  on this project and is expected of you.
- **Update `CLAUDE_UPDATE_4.md`** with every architectural decision.
- Report per phase: built · how verified (real output) · decisions and reasoning · anything
  unverified or blocked.

---

## Phase V4-1 — Remove cumulative-balance discounting

**This is the largest and most dangerous phase. It goes first, alone.**

1. **Map before touching anything.** Use `analyze-project` and `graphify`. Produce a table of
   every place the cumulative model is read, written, displayed, seeded, or tested — schema,
   services, routes, both client apps, seed, and tests. **Report the map and stop.** I will
   run `grill-me` against your removal plan before you execute it.
2. After I confirm: remove cumulative balance from the discount decision path. Tiers now
   evaluate against **the current invoice amount only**.
3. Keep `min_rate`, `max_rate`, and the absolute cap fully binding — verify each still does.
4. Reword the progress message to compute against the current invoice:
   «أضف X د.ع لهذه الفاتورة للحصول على خصم Y».
5. Keep customer lifetime totals for **reporting only**, renamed so nobody mistakes them for
   a discount input.
6. Migrate the schema. **Never recompute a discount already given and printed.**
7. Update the seed — it must pass the shared validator (§12.38).

**Verify:** tiers evaluate on invoice amount; cap still binds; historical transactions
unchanged; the station shows the new message correctly; full suite green.

---

## Phase V4-2 — Station: multi-device and clear/reset

1. **Device-agnostic** per `CLAUDE_UPDATE_4.md §3`: responsive from ~7" tablet portrait to
   desktop, touch-first and keyboard-wedge-first simultaneously, no hover-only interactions,
   readable at arm's length. **No settings screen.**
2. **Clear/reset control** per §4: visible on every terminal result, thumb-zone placement,
   reachable from the scanner via a keyboard path, plus an auto-clear timeout. State your
   reasoning for the duration. Clearing must never discard a committed transaction.

**Verify:** the full flow at a tablet viewport AND a desktop viewport with simulated scanner
input, via `agent-browser`. Report both. Confirm all three scanner terminator behaviours still
work.

**Skills:** `mobile-ux-design`, `mobile-app-ui-design`, `agent-browser`.

---

## Phase V4-3 — Thermal printing

Per §5: support 58mm and 80mm selectable in manager settings; print CSS targets the real paper
width; preview and paper keep sharing `PrintableSlip`; kiosk printing still works.

**Verify by measuring, not by eye:** both widths, no overflow, no wrapping of the voucher code
or any identifier, correct RTL character order per line, every figure legible.

---

## Phase V4-4 — Design overhaul

Work screen by screen, committing per screen or per small group. For each: audit the current
screen against its reference, state what you are taking and what you are deliberately not
taking, then implement.

Order: `login` (all three roles) → `dashboard` → `customers` → `role` (discount rules) →
`cards` → `recovery` (backup) → `report` → `customer_found` (station scan result) →
`card_reprint`.

Also: **enlarge the app logo** in the sidebar header and anywhere it renders undersized.

**Hard constraints (§2.3):** RTL correct · §6.2 palette (charts `#0E7C60`, accent `#0F6E56`) ·
§6.3 fonts only · contrast and legibility beat effects · never carry meaning by color alone ·
cover empty / single-point / long-label / large-value / gap states.

**Do not** take content, metrics, or features from the references. If a reference implies
something v4 does not have, adapt the layout — do not invent the feature (§12.26).

**Verify:** every screen rendered via `agent-browser`, RTL confirmed, contrast checked with
`web-design-guidelines` after the effects pass.

**Skills:** `frontend-design`, `ui-ux-pro-max`, `design-system-architect`, `ui-animation`,
`vercel-react-best-practices`, `vercel-composition-patterns`, `web-design-guidelines`,
`agent-browser`.

---

## Phase V4-5 — Installer and safe updates

Per §6. The deliverable is a **verified** upgrade path, not a claimed one.

1. Confirm upgrade-in-place preserves database, `walaa.env`, secrets, logs, and audit trail.
2. Confirm migrations apply at boot and fail closed.
3. **Run the real upgrade test:** install a prior build → seed it with customers, cards,
   transactions, and a confirmed backup key → install the new build over it → confirm every
   record survives, cards still scan, service starts clean.
4. Only after that test passes may the `!! UNVERIFIED !!` registry hook marking change. If you
   cannot run the test, say so plainly and leave the marking alone.
5. Write the operator-facing upgrade checklist in the packaging README.

**Skills:** `testing-tauri-apps`, `verification-before-completion`.

---

## Definition of done

- Cumulative balance no longer influences any discount; tiers evaluate on invoice amount only.
- Cards, history, and customer records intact; no discount retroactively recomputed.
- Station runs correctly on tablet and desktop viewports, with working clear/reset and all
  three scanner terminator behaviours.
- Slip prints correctly at 58mm and 80mm, measured; preview matches paper.
- All nine screens redesigned within the §2.3 constraints, verified rendered, contrast checked.
- Upgrade test run and its result reported honestly.
- No frozen identity string renamed.
- No writer bypasses the service layer.
- Full suite, typecheck, lint, and build green.
- `CLAUDE_UPDATE_4.md` reflects every decision made.
