# PROMPT_v3.md — Migration Execution Directive (v3)

> This governs a **mid-build architectural pivot**. Existing work must be audited and migrated,
> not discarded wholesale. Read this after `CLAUDE.md`, `CLAUDE_v2.md`, and `CLAUDE_v3.md`.

---

## Situation

The project is partway through Phase 2 of the original plan (manager dashboard). The business
model and architecture have changed substantially. Your job is to **stop, assess, re-plan, and
migrate** — carefully, without destroying work that remains valid.

**Do not begin the original Phase 3 (Expo mobile app). It has been cancelled.**

---

## First actions (before any code)

1. **Read in order:** `CLAUDE.md` → `CLAUDE_v2.md` → `CLAUDE_v3.md`.
   Where they conflict, the highest version wins.
2. **Run the audit** (`CLAUDE_v3.md §1`). Use the **`analyze-project`** skill (and **`graphify`**
   if useful) to map the existing repository. Produce a table classifying every module as
   KEEP / REVISE / REWRITE / DISCARD, with your reasoning where it differs from §1.
3. **Report the current state honestly:** what Phase 2 actually completed, what is half-built,
   and what is broken. Do not gloss over incomplete work.
4. **Stress-test your migration plan** using the **`grill-me`** skill before executing it.
5. **List blocking questions.** Note that §9 (discount settlement) is a known open blocker —
   do not re-ask it; build the pluggable strategy as instructed.
6. **Do not write code until I confirm your audit and plan.**

---

## Process rules

- **Nothing is deleted before its replacement works.** Rename `apps/assistant` to
  `apps/_deprecated_assistant`; remove it only at the end.
- **Incremental and verifiable.** Small runnable slices. Run builds, migrations, and tests with
  **bash** — never assume. Apply **`verification-before-completion`** at every phase boundary.
- **Use `full-output-enforcement`** on all substantial code files — no placeholders, no
  truncation, no "rest of implementation omitted".
- **Never break the store.** The Fail-Open rule (`CLAUDE_v3.md §4.6`) is tested explicitly, not
  assumed.
- **Never create an accounting discrepancy.** Re-read §9 before touching settlement logic.
- **Update `CLAUDE_v3.md`** whenever you make an architectural decision it does not cover.
- **Report per phase:** what was built, how verified (show real command output), decisions and
  reasoning, and anything unverified or blocked.

---

## Migration phases

Do not start a phase until the previous one is verified.

### Phase V3-0 — Audit and plan
Full repository audit, migration classification table, honest state report, stress-tested plan.
**Skills:** `analyze-project`, `graphify`, `grill-me`.
**Verify:** the classification table covers every existing module; I have confirmed the plan.

---

### Phase V3-1 — Data layer migration
- Switch Prisma provider **PostgreSQL → SQLite**; keep Prisma as the ORM.
- Apply the v3 schema (`CLAUDE_v3.md §5.2`): revise `transaction`; add `discount_rule`,
  `discount_settings`, `voucher`, `feature_flags`; add `customer.barcode_token`; drop `coupon`
  and the old tier model.
- Preserve `merchant`, `branch`, `user`, `customer`, `audit_log`, `notification_log`.
- Update `packages/shared-types` to match. One definition, imported everywhere.
- Update the seed script with realistic Iraqi data and a sensible default discount rule
  (within the safe 1–3% band).
**Skills:** `codebase-design`.
**Verify:** migration applies cleanly; seed runs; queries return expected data; cumulative
balance is computed (not stored) and correct for a seeded customer.

---

### Phase V3-2 — Backend logic rewrite
- **Remove** the coupon engine entirely.
- **Implement the instant-discount engine:** on invoice capture + card scan, evaluate
  thresholds, compute the discount by type, **apply the absolute value cap**, and record
  `amount_gross` / `discount_value` / `amount_net`.
- **Enforce the guardrails in `CLAUDE_v3.md §2.3` in code**, including rejecting configurations
  that exceed the configured max.
- **Implement `DiscountSettlementStrategy`** with `VoucherAsPaymentStrategy` (default) and
  `DailyPromotionalExpenseStrategy` (fallback), selectable via settings.
- **Implement the ingestion endpoint** for the capture agent, strictly idempotent on
  `(merchant_id, branch_id, invoice_id)`.
- **Implement the WebSocket broadcast layer** for real-time client updates.
- **Implement `/sync/batch`** for offline queue flushing, idempotent per item.
- **Implement feature-flag evaluation.**
**Skills:** `codebase-design`, `design-an-interface`, `verification-before-completion`.
**Verify:** automated tests for — threshold evaluation, discount cap enforcement, idempotent
ingestion, both settlement strategies, offline sync reconciliation, feature-flag gating.
All green, output shown.

---

### Phase V3-3 — Manager Desktop updates
Keep the v2 Tauri shell, layout, RTL, auth, and design system. Then:
- **Rewrite the rules editor** for the new model: discount type (percentage / fixed), min and
  max rate, tier thresholds, and the absolute cap.
- **Build the live margin warning** (`§2.3`) into that screen.
- **Build the Feature Flags settings screen.**
- **Build the Print Capture settings screen:** capture mode, codepage, agent status, and the
  **calibration flow** (`§4.7`) — print test receipt, display captured text, click to select
  total and invoice number, generate and validate the template.
- **Build the Backup settings screen:** Google Drive connection, schedule, restore test.
- **Update reports** for the new metrics (discounts granted, voucher reconciliation, capture health).
- **Update customer detail** for the new balance derivation.
- Remove all coupon UI.
**Skills:** `frontend-design`, `ui-ux-pro-max`, `vercel-react-best-practices`,
`vercel-composition-patterns`, `web-design-guidelines`, `testing-tauri-apps`.
**Verify:** every screen renders with seeded data, RTL correct, bundled fonts render offline,
margin warning fires on a dangerous rate, settings persist and are audited.

---

### Phase V3-4 — Loyalty Station (`apps/station`)
New React web app served by the Manager machine (`CLAUDE_v3.md §6`).
- First-run setup, station login (`STATION` role).
- **Main scan screen:** one focused input (keyboard-wedge compatible), huge type, three
  outcomes — qualified / progress message / unknown card.
- **Registration:** name + phone only → generate barcode → print card.
- **Lookup and reprint:** same code, never a new one.
- **Thermal printing** of customer cards and discount slips with the full slip contents (§6.3).
- Offline queue + WebSocket reconnection.
- **No settings screen anywhere in this app.**
**Skills:** `mobile-ux-design`, `mobile-app-ui-design`, `frontend-design`, `agent-browser`.
**Verify:** full flow on both a touch viewport and a desktop viewport with simulated scanner
input; card prints; slip prints with correct before/discount/after values; offline scan queues
and syncs; unknown card routes to registration.

---

### Phase V3-5 — Print Capture Agent (`agent/`)
New C#/.NET Windows Service (`CLAUDE_v3.md §4`).
- Implement all four capture modes: `SPOOL_WATCH`, `VIRTUAL_PRINTER`, `SERIAL_BRIDGE`,
  `NETWORK_PROXY`.
- Implement **auto-detection** on install.
- Implement the **parsing pipeline**: ESC/POS stripping, configurable codepage (CP864 /
  Windows-1256 / auto), **Arabic-Indic and Western digit support**, external
  `pos-template.json` rules.
- Implement **local queue** and HTTPS delivery to the Manager API with idempotency.
- Install as a Windows Service that starts automatically.
- **Implement and TEST the Fail-Open rule** — kill the agent mid-operation and confirm printing
  continues.
**Skills:** `codebase-design`, `verification-before-completion`.
**Verify:** each mode captures in a simulated environment; ESC/POS stripped correctly; Arabic
text decodes correctly under CP864 and Windows-1256; Arabic-Indic digits parse; duplicate sends
rejected; **agent killed → printing unaffected** (show this explicitly).

---

### Phase V3-6 — Integration and hardening
- End-to-end: capture → ingest → scan → discount → slip → real-time dashboard update.
- **Encrypted Google Drive backup** + local + USB, scheduled, with a **verified restore test**.
- Security pass (v1 §7) and performance pass (v1 §8) across the new surfaces.
- ~~Remove `apps/_deprecated_assistant`.~~ Done 2026-08-31 (§1).
- Write the setup guide: hardware list, network setup, printer relocation/`net use LPT1:`
  workaround, calibration walkthrough, backup configuration.
**Skills:** `verification-before-completion`, `web-design-guidelines`, `agent-browser`.
**Verify:** a complete documented end-to-end run; restore from backup succeeds; all tests green.

---

## Definition of done

- The audit table was produced and confirmed before changes began.
- Instant-discount logic is correct, capped, and tested under both settlement strategies.
- The agent captures reliably and **never blocks printing** (demonstrated).
- Arabic text and Arabic-Indic digits parse correctly from real thermal output.
- The Station runs on tablet and desktop-with-scanner, with zero settings exposed.
- Manager dashboard shows real-time updates in under one second.
- Feature flags toggle modules with no code changes.
- Encrypted backup runs and **restore has been tested**.
- No path exists that produces a cash-vs-POS discrepancy.
- `CLAUDE_v3.md` reflects every architectural decision made.
