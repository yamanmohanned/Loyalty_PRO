# CLAUDE_UPDATE_4.md — Customer Loyalty: v4 Specification

> **Version:** 4.0 — Delta on top of `CLAUDE.md` (v1), `CLAUDE_v2.md` (v2), `CLAUDE_v3.md` (v3)
> **Read order:** v1 → v2 → v3 → **this file**. Highest version wins on conflict.
> **Nature:** A model simplification plus a full design pass. The system works; this changes
> what it calculates and how it looks. Do not rebuild what already works.

---

## 0. Non-negotiable rules (carried forward and extended)

All standing invariants from v1–v3 remain in force, in particular:
1. The store must never stop working. Fail-Open on all in-path capture modes (§4.6).
2. No flow may ever create a cash-vs-POS discrepancy. The API never refuses writes.
3. Business rules are enforced at the service layer; **no writer bypasses it** (§12.38).
4. Evidence before claims — `verification-before-completion` at every boundary.
5. Anything formatted for a human gets a **rendered** check, not a unit test (§12.27).
6. A control that stopped matching the system around it is the failure class to look for (§0 rule 9).
7. Identity strings the installer/service/firewall key on are **frozen** (§12.36).

**New for v4:**
8. **Audit before deleting.** The cumulative model touches many surfaces. Map every usage
   before removing anything, and report the map before changing code.
9. **Design references are references, not specifications.** Take layout and visual grammar;
   never take content, data shapes, or metrics from them.

---

## 1. THE CORE CHANGE — remove cumulative-balance discounting

### 1.1 What changes
The discount is now determined by **the current invoice amount alone, at the moment of
payment**. There is no accumulation across visits, no period, no running balance feeding the
discount decision.

```
BEFORE (v3):  spend across a period → crosses threshold → discount
AFTER  (v4):  THIS invoice amount → matches a tier → discount on THIS invoice
```

### 1.2 What the card is now for — read this before deleting anything
When the discount depends only on the invoice amount, the card no longer *calculates* the
discount. It determines **who is entitled to one**.

The discount is available **only to registered customers holding a card**. That is still a
genuine loyalty program — the incentive is to register and carry the card — it is simply not
accumulation-based. Do not conclude that cards are now pointless and strip them out. They
remain the identity layer, the history record, and the merchant's relationship with his
customers.

### 1.3 Removed
- Cumulative balance as an input to the discount decision.
- `period_type` and any period window governing discount eligibility.
- Threshold-crossing detection across transactions.
- Any "progress toward a threshold across visits" concept.

### 1.4 Retained, with changed meaning
| Concept | v3 meaning | v4 meaning |
|---|---|---|
| Discount tiers | Spend thresholds across a period | **Invoice-amount** brackets |
| `min_rate` / `max_rate` / absolute cap | Unchanged | Unchanged — all still bind |
| Customer lifetime total | Drove the discount | **Reporting only** — never an input |
| Progress message | "تبقّى X للوصول إلى خصم" (across visits) | **«فاتورة بـ X د.ع أو أكثر تحصل على خصم Y»** |

> **Note on the progress message — corrected 2026-09-04, and this replaces the original
> wording of this row.** *(operator ruling. Supersedes `PROMPT_UPDATE_4.md` Phase V4-1
> step 4, which still carries the retired sentence.)*
>
> The first draft of this row read **«أضف X د.ع لهذه الفاتورة للحصول على خصم Y»** — "add X
> to this invoice". **That instructs an action the system forbids, on a screen facing the
> customer, at the till.** By the time anyone scans at the Station the POS has already
> printed the receipt (§2.2 of v3), and **cashiers are not authorised to modify invoices** —
> a deliberate anti-fraud control to be respected, not routed around. Adding items produces
> a *second* invoice, which under invoice-amount brackets is evaluated on its own and may
> qualify for nothing at all. So the sentence promised something no one in the shop is
> allowed to deliver.
>
> This is §0 rule 9 in the copy layer: wording that sounds correct and had **stopped
> matching the system's own constraints**. It is the same class as §12.26's Stitch exports
> and §12.23's controls — nothing about the sentence decayed; what it described did.
>
> **The wording is therefore «فاتورة بـ X د.ع أو أكثر تحصل على خصم Y».** The upsell
> survives — it still names the bracket and what it earns, which is the whole point of
> showing it — and the impossible instruction is gone. It is a statement about what
> qualifies, not a command to do something the till will refuse.
>
> **Do not restore the "أضف" wording.** It will look like the more actionable of the two
> and it is the one that cannot be acted on.

### 1.5 Retained without change
Cards and the whole card lifecycle · the capture agent · voucher issuance and the slip ·
settlement strategies · backup and the key ceremony · feature flags · storage monitoring ·
audit log · RBAC · realtime sync.

### 1.6 Required approach
1. **Map first.** Find every place the cumulative model is read, written, displayed, or
   tested. Report the map before changing code.
2. Remove the model from the discount path.
3. Keep lifetime totals where they serve reporting, clearly renamed so nobody mistakes them
   for a discount input.
4. Migrate the schema. Existing transactions keep their historical `discount_value` — never
   retroactively recompute a discount that was already given and printed.
5. Update every affected screen (customer detail, discounts, reports, station messaging).
6. Update the seed, which must pass the shared validator (§12.38).

---

## 2. DESIGN OVERHAUL — reference images

### 2.1 The references
Image files are in the project folder, named:

`dashboard` · `customers` · `role` · `cards` · `recovery` · `report` · `login` ·
`customer_found` · `card_reprint`

They map to: Overview · Customers · Discount Rules · Cards · Backup · Reports · Login (all
three roles) · Station scan-result · Station card reprint.

### 2.2 What to take, and what not to
**Take:** layout and composition · visual hierarchy and grouping · card and panel structure ·
chart types, arrangement, and visual weight · spacing rhythm and density · the general feel
of polish and arrangement.

**Do NOT take:** any content, labels, metrics, or data shapes · any color that conflicts with
§6.2 tokens · any font outside §6.3 · any English copy · anything implying a feature we do
not have.

> **This is the §12.26 lesson again.** The Stitch exports predated the pivot and following
> them literally would have walked six screens backwards. These references are inspiration for
> arrangement, not a specification of behaviour. If a reference implies a metric or feature
> that does not exist in v4, **do not invent it** — adapt the layout to our real content.

### 2.3 Constraints that override the references
- **RTL correctness** on every screen. References are likely LTR; mirror properly.
- **§6.2 palette** wins on color. Chart series use `#0E7C60` (§6.2.1); UI accent stays `#0F6E56`.
- **§6.3 fonts** only: Cairo, IBM Plex Sans Arabic, IBM Plex Mono.
- **Contrast and legibility win over effects.** Glow, shadow, and glass are permitted where
  they do not reduce readability. Data reads first, always.
- **Never carry meaning by color alone** — label the data.
- Cover empty / single-point / long-label / large-value / gap states in the same visual language.

### 2.4 Reports specifically
The merchant should feel at a glance whether the store is doing well. Interactive charts per
section, distinct category colors, tasteful light and shadow treatment. Take the arrangement
from `report`, the content from what v4 actually measures.

### 2.5 Logo
Enlarge the app logo/mark in the sidebar header and anywhere it appears undersized. Use the
existing transparent master; do not re-edit the artwork.

---

## 3. STATION — device-agnostic

### 3.1 Requirement
The deployment device is **undecided** — it may be a tablet, the cashier PC, or a separate
side computer. The Station must run well on all of them without a separate build.

### 3.2 What this means
- Responsive from ~7" tablet portrait up to a desktop monitor.
- **Touch-first and keyboard-first simultaneously:** large tap targets (≥48dp) AND full
  keyboard-wedge scanner support (the scanner types and sends Enter, Tab, or nothing —
  all three already handled; do not regress this).
- No hover-only interactions. Anything reachable by mouse must be reachable by touch.
- Readable at arm's length under shop lighting — this is the operator's whole job surface.
- Works in a browser, in kiosk mode, and (if ever needed) inside a wrapper — do not add a
  hard dependency on any one shell.
- **Still zero settings screens** (§6.4 stands).

### 3.3 Verification required
Exercise the full flow at a tablet viewport AND a desktop viewport with simulated scanner
input, using `agent-browser`. Report both.

---

## 4. STATION FLOW — clear/reset control

### 4.1 The gap
After a scan that yields no discount (or any terminal result), the screen still holds the
previous customer's data. The next customer cannot start cleanly.

### 4.2 Requirement
A clear, obvious control to reset the screen to the ready-to-scan state — visible on **every**
terminal result, not only the no-discount one.

- Large, in the thumb zone, unmistakable.
- Also reachable from the scanner: define a keyboard path so the operator never has to reach
  for the screen mid-queue.
- **Auto-clear after a timeout** so an unattended screen never leaves a customer's data
  visible. Choose a duration that does not rush a customer reading their result, and state
  your reasoning.
- Clearing must never discard a committed transaction — it clears the view, not the record.

---

## 5. THERMAL PRINTING — fit the paper

### 5.1 Requirement
The printed slip must be correctly sized and laid out for the thermal paper actually in use.

- Support both **58mm and 80mm** paper widths, selectable in manager settings.
- Print CSS must target the real paper width — no page margins bleeding, no clipped edges,
  no wrapped identifiers.
- The on-screen preview must render at paper width and match the paper exactly. They already
  share `PrintableSlip`; keep it that way so they cannot drift.
- Keep kiosk printing (no dialog) working.

### 5.2 Verification (§12.27 applies)
Render and **measure** at both widths: no overflow, no wrapping of the voucher code or any
identifier, correct RTL character order for every line, and every figure legible. Measuring by
range geometry, not by eye — as established.

---

## 6. INSTALLER — safe, repeatable updates

### 6.1 Requirement
The merchant must be able to receive an updated build at any time and **never lose data** —
during or after the update.

### 6.2 What must hold
- **Upgrade in place is the supported path.** Uninstall-then-install is destructive because
  the data directory holds `QR_TOKEN_SECRET`, and every card ever minted verifies against it.
  Deleting it permanently breaks every printed card in the shop.
- Database, `walaa.env`, secrets, logs, and audit trail all survive an upgrade.
- Migrations apply at boot and **fail closed** — a half-applied or changed migration stops the
  boot rather than running code against a schema it wasn't built for.
- The pre-install hook must stop and deregister the old service so file locks release.
- Identity strings stay frozen (§12.36).

### 6.3 What must be verified, not assumed
- **A real upgrade test:** install a prior build, seed it with data (customers, cards,
  transactions, a confirmed backup key), then install the new build over it. Confirm every
  record survives, cards still scan, and the service starts clean.
- The `!! UNVERIFIED !!` registry hook remains unverified until this test runs. **Do not
  upgrade that marking without running it.**
- Document the upgrade procedure in the packaging README as an operator-facing checklist.

---

## 7. BRANDING

- App display name: **"Customer loyalty"** everywhere a person reads it.
- **Frozen (§12.36):** `productName`, `identifier`, `SERVICE_NAME`, `FIREWALL_RULE`,
  `%PROGRAMDATA%\Walaa`, the `/health` string. Renaming these silently orphans existing
  installations.
- Icon: the transparent 1024 master already in place; all §5.2 sizes regenerated from it.

---

## 8. Skills and tools

Use these deliberately. They are not optional decoration — each maps to a real failure mode
this project has already hit.

### Always active
| Skill | Why |
|---|---|
| **`verification-before-completion`** | Every phase boundary. §0 rule 4. Non-negotiable. |
| **`full-output-enforcement`** | Long files in this batch; no placeholders or truncation. |

### Phase-specific
| Phase | Skills | Why |
|---|---|---|
| §1 model removal | **`analyze-project`**, **`graphify`**, **`codebase-design`** | Map every usage before deleting; find the seams cleanly |
| Planning the removal | **`grill-me`** *(operator-run — see below)* | Stress-test before executing a wide change |
| §2 design overhaul | **`frontend-design`**, **`ui-ux-pro-max`**, **`design-system-architect`** | Non-generic design, token consistency across nine screens |
| §2.4 charts and effects | **`ui-animation`**, **`animation-designer`** | Motion and light treatment without hurting legibility |
| §3 multi-device Station | **`mobile-ux-design`**, **`mobile-app-ui-design`** | Touch targets, thumb zones, tablet viewports |
| All UI verification | **`agent-browser`** | §12.20 — the real client, not curl or source review |
| Accessibility sign-off | **`web-design-guidelines`** | Contrast and usability audit after the effects pass |
| React implementation | **`vercel-react-best-practices`**, **`vercel-composition-patterns`** | Performance and composable component APIs |
| §6 installer | **`testing-tauri-apps`** | Correct Tauri testing patterns |
| Parallel independent tasks | **`subagent-driven-development`** | Only where tasks are genuinely independent |

> **`grill-me` cannot be self-invoked.** Ask the operator to run it against the §1 removal plan
> before you execute it; do not attempt to invoke it yourself.

### Tooling discipline
- Run builds, migrations, and tests with **bash** and show real output.
- Read the full existing implementation with file tools before editing.
- Update this file with every architectural decision you make.

---

## 9. Anti-patterns for v4

- Do NOT delete cards, history, or customer records as "no longer needed" — §1.2.
- Do NOT retroactively recompute discounts already given and printed.
- Do NOT copy content, metrics, or features from the design references — §2.2.
- Do NOT let visual effects reduce contrast or legibility — §2.3.
- Do NOT add a settings screen to the Station — §3.2.
- Do NOT let the printed slip and its on-screen preview diverge — §5.1.
- Do NOT rename any frozen identity string — §7.
- Do NOT mark the registry hook verified without a real prior-install upgrade test — §6.3.
- Do NOT bypass the service layer from any script, seed, or migration — §12.38.

---

## 10. Decision log (v4)

Decisions made during the v4 batch, in the order they were settled. §8 requires this
file be kept current; append here rather than deciding twice.

### 10.1 RULE — never `RedefineTables` on a table with FK children; use `DROP COLUMN`
*(operator ruling, 2026-09-04, made permanent. Found by grilling the V4-1 removal map,
proven by reproduction before it reached a merchant.)*

> **On this schema, a Prisma `RedefineTables` block on any table with foreign-key
> children is DESTRUCTIVE under `migrate.ts`, regardless of the pragmas Prisma
> emits.** Use `ALTER TABLE … DROP COLUMN` instead, dropping any index over the
> column first.

**The four parent tables this applies to: `transaction`, `customer`, `merchant`,
`branch`.** Each has children with `ON DELETE Cascade` or `SetNull`.

**And the sentence that matters most: `prisma migrate dev` will hand the next person
exactly the destructive SQL.** It is the tool's normal output for a dropped column on
SQLite, it carries pragmas that look like they handle the problem, and there is already
one such block committed in this repository. Nobody writes this by hand and nobody
reviewing it sees anything wrong.

#### Why the pragmas do not save it

Three facts have to be held together, and each is individually unremarkable:

| | Where |
|---|---|
| `voucher.transaction_id → transaction.id` is `ON DELETE Cascade` | `schema.prisma`, Voucher |
| Every statement of a migration runs **inside one transaction** | `migrate.ts` — `client.$transaction([...])` |
| `PRAGMA foreign_keys` is a **no-op inside a transaction** | SQLite semantics |

So Prisma's `PRAGMA foreign_keys=OFF` does nothing, and only `defer_foreign_keys=ON`
takes effect — which defers *constraint-violation checking* to commit, and does **not**
suppress `ON DELETE` actions. `DROP TABLE` performs an implicit `DELETE FROM`, which
fires them.

#### What it costs, and why nothing catches it

The migration **commits successfully**. No error, no rollback, `fail-closed` never
trips. Every voucher row in the shop is gone: end-of-day reconciliation history, and
with it §0 rule 3's guarantee that every discount a customer received has a record
explaining it — broken retroactively, for sales already made.

Measured, not reasoned about, with this schema's exact foreign key:

```
── Prisma RedefineTables INSIDE one transaction  (what migrate.ts does)
   vouchers before : 2      vouchers after : 0     → DATA LOSS
── Same SQL with NO surrounding transaction
   vouchers before : 2      vouchers after : 2     → SAFE
── ALTER TABLE DROP COLUMN inside one transaction, FK=ON
   vouchers, transactions, discount totals all preserved; period_key gone
```

`DROP COLUMN` needs SQLite ≥ 3.35. **The Prisma engine in use reports 3.46.0** —
checked, not assumed — and SQLite refuses to drop a column an index still references,
so the index is dropped first in the same migration.

#### The test that would have caught it, and the gap it closes

`migrate.test.ts` applies migrations to a **fresh** database, where no vouchers exist at
migration time — so the destruction had nothing to destroy and the suite stayed green.
The new test seeds a database with customers, transactions **and vouchers**, applies the
pending migration, and asserts the vouchers survive with their values intact. It
resembles the real migration target: `apps/api/prisma/walaa.db` carries both period data
and §12.37's illegal 7,500-under-5,000 rule, which is what a merchant's database actually
looks like — not a clean room.

### 10.2 A pending migration takes a snapshot first, and fails closed if it cannot
*(operator ruling, 2026-09-04)*

`ensureDatabaseReady()` runs at boot with **no backup before it**, and
`startBackupScheduler` starts afterwards. So the recovery position for a bad migration
was the last scheduled backup — up to 24 hours old.

**And frequently no floor at all.** §12.19 blocks backups until the key ceremony is
confirmed, so a shop that upgrades before completing the ceremony has **never taken a
backup**. The moment of greatest schema risk coincides exactly with the window in which
this product guarantees no backup exists. That interaction is the reason this is built
rather than noted.

So: when — and only when — there is something pending, `applyPendingMigrations` takes a
`VACUUM INTO` snapshot into the data directory before applying anything, and **fails
closed if it cannot take one.**

**The asymmetry, which is §12.18's and not §12.16's.** §12.16 forbids refusing a *write*
because storage is low: the discount is already given, refusing frees nothing and
manufactures the discrepancy it claims to prevent. A *migration* inverts cleanly —
declining loses nothing, because the data is still there and the old binary still runs.
A blocked boot during a supervised upgrade produces a phone call; a silent destructive
migration produces a shop that finds out weeks later at reconciliation.

This path runs once per upgrade, never on an ordinary boot, and §6.3 makes the upgrade an
operator-supervised procedure — there is a human present to receive the failure.

### 10.3 The seed drives the real engine, and writes the voucher with the discount
*(operator ruling, 2026-09-04. **This reverses a documented deliberate choice**, and the
original reasoning is recorded here because it was sound and the reversal is not a
correction of it.)*

**What the seed used to do, and why.** Every seeded transaction carried
`discountType: 'NONE', discountRate: 0, discountValue: 0`, and no voucher was created at
all. The stated reason — worth preserving — was that *a voucher is proof of a discount
granted by the engine at a real scan, and minting one here would bake a guess at the
calculation into fixtures and let a bug in the engine hide behind seeded data that looks
correct.* That is a real hazard and the instinct was right.

**Why it changed.** The zeros did not achieve it. They produced a database in which the
engine was never exercised at all, so nothing could hide behind the fixtures *and*
nothing could be verified against them either. A freshly seeded database rendered almost
none of the screens that report on discounting: `discountsGranted` and
`discountedTransactionCount` both zero, the voucher funnel and `todayReconciliation`
empty, §12.37's cap panel showing only its *silence* zero and never its verified-absence
zero or its amber advice, and the Station's whole `QUALIFIED` path — slip preview
included — with no seeded data behind it.

Under v4 this would have got worse: with cumulative spend gone, the bracket ladder is the
**only** thing that produces a discount, and the seed exercised it not at all.

**So the seed now calls `computeDiscount` and the real settlement strategy, and writes
the voucher in the same step.** The original concern is better served, not weakened: a
seed that *runs* the engine cannot hide an engine bug, because a bug changes what the
seed writes. A seed that writes zeros can only hide it.

**The voucher is not optional.** A discount without one breaches §0 rule 3 — a customer
paying less than the POS recorded with nothing in the books to explain it. They are
written together or neither is.

This is §12.38 applied correctly rather than an exception to it: **a script that seeds is
a client of the business rules, not an exception to them** — and that includes the
calculation, not only the validation.

### 10.4 `CustomerBalance` splits into a lifetime figure and a per-invoice outcome
*(operator ruling, 2026-09-04)*

At **step 1** of the Station flow there is no invoice yet, so "the next bracket" and the
gap to it are undefined — there is nothing to compute them against. At the **result**
there is. One shape carrying both would mean different things depending on when it was
read, which is §12.27's failure with a new surface: a field that is null at one moment
and meaningful at another does not fail, it stays plausible.

So: **`CustomerLifetime`** (total spend, transaction count) for step 1 and the manager
screens, and a per-invoice outcome — bracket reached, next bracket, the gap — that
**exists only where an invoice exists**. Two shapes for two facts, and neither can be
read at the wrong moment.

### 10.5 Per-invoice discounting has NO per-customer bound, by design
*(operator ruling, 2026-09-04. Recorded as an accepted exposure, not a gap.)*

Under v3, cumulative spend plus a period reset bounded a customer's discounting without
anyone designing it that way: the ladder was climbed once per period. **v4 removes that
bound and does not replace it.** Every invoice is evaluated on its own, so a wholesale
customer buying 480,000 daily takes the 5,000 fixed discount **every day** — on the order
of 150,000 IQD a month to one card, against a 2–4% net margin.

Every guardrail in §2.3 — minimum rate, maximum rate, absolute cap — bounds a **single
invoice**. **None of them bounds a customer.** That is a real change in exposure and it
is stated here so nobody discovers it in the accounts.

**The mitigation is a report, not a rule.** Reports gains **discount value per customer
over the range**, so a customer taking a discount daily is visible. A report does not
reopen the per-customer path that §12.27 closed and that §2.3's guardrails depend on
staying closed — it describes the ladder's effect rather than creating a second ladder.

**A frequency cap is NOT to be built as a v4 cleanup.** It is a discount-model decision
requiring its own guardrails and its own reasoning. `role.png` showing such a control
(«عدد مرات الاستخدام لكل عميل») is a reason to be *more* careful, not less: §2.2 forbids
taking a feature from a design reference, and this is exactly the shape of thing that
arrives that way.

### 10.6 The reporting window replaces the period entirely
*(operator ruling, 2026-09-04)*

`period_key` is deleted outright rather than kept as a fixed MONTHLY bucket. A setting
the API can never change is a dead setting, and a dead setting is how §0 rule 9 failures
begin — it goes on looking like a control long after it controls nothing.

What replaces it:

| Was | Is |
|---|---|
| Cumulative spend in the active period | **Lifetime** total per customer — reporting only, never a discount input |
| "Top customers this period" | Top customers over the selected `ReportRange` |
| `tierPerformance` — customers who reached each tier this period | **Invoices that landed in each bracket** over the range |

`ReportRange` (`7d \| 30d \| 90d \| 365d`, §12.26) is already built and already the
control on both reporting screens; it becomes the only window in the product.

**What `period.ts` keeps.** Only the period-key half goes. `localDateKey`,
`localDayBounds` and `DEFAULT_MERCHANT_TIMEZONE` stay: end-of-day voucher reconciliation
depends on them, and they are what fixed §12.23's UTC-day bug. Deleting the module
wholesale would reopen it.

### 10.7 Smaller rulings, recorded so they are not re-decided
*(operator answers, 2026-09-04)*

| | Ruling |
|---|---|
| **Rule naming** | `discount_rule.threshold_amount` keeps its column and field name; every comment and Arabic label becomes «قيمة الفاتورة». Renaming would touch thirteen files mid-phase — the §12.12 precedent |
| **`cumulativeAmount` parameter** | **Deleted, never renamed.** See §12.27's removal corollary — a rename type-checks against a caller still passing a cumulative figure |
| **Station auto-clear** | 90 seconds on every terminal result. On `QUALIFIED` the timer **does not start until the slip has printed** — clearing an unprinted slip would destroy the thing the operator is about to press. Any keypress or scan restarts it. It clears the view, never a committed record |
| **Station reset from the scanner** | `Escape` only. §12.30's rule stands: **the scan field is not live on the result screen**, because a stray scan there wipes the slip the customer is reading. **A reset barcode is DEFERRED, not rejected** — it is new physical stock, a new artefact to lose, and it solves a problem nobody has observed. Revisit only if the field shows operators reaching for the screen too often |
| **Paper width** | Merchant-level (`58 \| 80`), not per-station: a shop running two roll widths is hypothetical, and a per-station setting is a real settings surface on an app that has none by design (§6.4). One CSS custom property feeds both the print root and the preview — they had **already drifted** (`8mm` vs `6mm` bottom padding) while nominally sharing `PrintableSlip`, which is the evidence for why one source is required |
| **`apps/dashboard`** | Deleted at the end of V4-4, as its own commit, with a verification pass across **every** package — §12.24's lesson is that a fix verified only where the symptom appeared is verified nowhere else |
| **`customer_found.png`** | Depicts the card-scan **step 1**, not a scan result. Used as the step-1 reference; the result view derives from `login`/`dashboard`'s visual grammar |

### 10.8 Verification gap — two scanner terminators are proven below the harness
*(recorded 2026-09-04, at the operator's instruction, so nobody reads "verified" as
end-to-end)*

§3.2 requires all three keyboard-wedge terminator behaviours to keep working, and V4-2
re-proved all three. **They were not all proved at the same layer, and the difference
matters to whoever reads this next.**

| Terminator | How it was exercised | Strength |
|---|---|---|
| **16 digits, no terminator** | real typed characters through the browser harness | end-to-end |
| **Enter** | `KeyboardEvent` dispatched into the focused input | **below the harness** |
| **Tab** | `KeyboardEvent` dispatched into the focused input | **below the harness** |

**The cause is the harness, not the app.** Its `key` action does not map the names the
app listens for: `Return` produced no `key: 'Enter'` that React saw, and its `Tab` never
reached the React handler at all — while the field kept focus and its value, so the app
was demonstrably fine and the input event simply never arrived. Dispatching the events
directly submitted correctly both times, with `defaultPrevented: true` on Tab proving the
app's own handler ran.

**So what is proven is that `onKeyDown` does the right thing when it receives an Enter
or a Tab — not that a physical scanner's Enter or Tab arrives as one.** Those are
different claims, and only the first is covered.

**This closes with real hardware, not with a better test.** *(operator ruling.)* A USB
keyboard-wedge scanner is the only thing that proves what a keyboard-wedge scanner does,
and it belongs to the field validation that already owes item (d) from §12.11. Writing a
cleverer browser test would move the claim sideways, not forward.

### 10.9 A fabricated number is indistinguishable from a real one
*(operator ruling, 2026-09-04. §12.26's discipline applied to a figure rather than a
feature.)*

§2.2 forbids taking from a design reference "anything implying a feature we do not
have". **The same prohibition binds one level down, on individual numbers**, and that
level is more dangerous because the tell is smaller.

The instance: `dashboard.png` gives every KPI tile a sparkline and a
«+18٪ عن الفترة السابقة» delta. `OverviewReport` has no per-KPI series and no
prior-period comparison, so both would have had to be manufactured to fill the shape.

A missing feature announces itself — a screen for coupons in a product with no coupons
is visibly wrong to anyone who knows the product. **A manufactured percentage announces
nothing.** It renders in the same font, at the same size, in the same tile as the four
figures beside it that are real, and there is no reading of the screen that separates
them. A merchant deciding whether the programme is working cannot tell which numbers
came from their shop.

So the rule, stated plainly:

> **Every figure on a screen must trace to something the system measured.** If a
> reference's layout asks for a number the data does not contain, the number is refused
> and the layout changes — the same ruling as for a panel, for the same reason, with
> less warning attached.

Corollary, and it is what made the Overview's KPI row better rather than sparser:
**before dropping a shape, check for real data that is computed and not rendered.**
`capturedSales` and `averageBasket` were both returned by the API and shown nowhere,
and they are what replaced the reference's points tiles. This has now happened twice —
§10.5's per-customer discount report was built and never displayed — so it is a
**standing check per screen**, not a coincidence: for every screen redesigned, list what
its endpoint returns and confirm each field either renders or is deliberately unused.

### 10.10 Refusing CONTENT was never a licence to refuse STYLE
*(operator correction, 2026-09-04. The counterweight to §10.9, and it has to sit
directly beside it.)*

§10.9 is right and stands whole: no invented points programme, no retention rate, no
city distribution, no fabricated delta, no metric this system does not measure. That
ruling was never in question.

**What went wrong is that the refusal was applied to the reference's *visual
language* as well as to its content, and then the screen was called finished.** The
operator put the built Overview beside `dashboard.png` and reported the honest
result: Login had changed slightly; Overview, Customers, Discount rules, Cards,
Backup and Reports were visually indistinguishable from before the overhaul. The
audit of what to take and what to refuse had been done carefully — and then almost
nothing was taken.

The distinction the two rulings draw between them:

| Refuse (§10.9) | Take (this section) |
|---|---|
| A number the system does not measure | Panel treatment — elevation, radius, border, internal padding |
| A panel implying a feature we lack | Spacing rhythm and density |
| A sparkline with no series behind it | Typographic hierarchy — the size and weight jumps between label, figure and support line |
| A prior-period delta we never computed | Chart styling — gradients, gridline weight, dot markers, legends |
| An avatar photograph we do not hold | Colour *application* — tinted icon squares, tinted grounds, where the accent lands |
| A city breakdown we never asked for | Composition — what sits beside what, and at what proportion |

**The test is not "did I audit it" but "does it look related".** Put the built screen
beside its reference: the family resemblance in styling should be obvious even though
the content is entirely different.

Worked examples from the pass this section came out of, each showing the seam:

- **The avatar.** The photograph is refused — no images are held and §0.4 keeps stored
  data minimal. The avatar *treatment* is taken, drawn from the first letter of a name
  already in the row. Same shape, honest content.
- **The rank badge.** The number is real, because the list is genuinely ranked. The
  reference's gold/silver/bronze podium colouring is refused, because amber is a status
  colour here (§6.2) and spending it on decoration would make it stop meaning anything.
- **The donut.** The reference's five-slice city breakdown is refused outright. The
  donut *form* is taken for the one split this screen actually has — attributed against
  unattributed invoices, which is the headline metric and is genuinely one whole in two
  parts. The absent half is drawn in grey rather than a second series colour, because
  it is an absence and not a category.
- **The KPI tile.** The tinted icon square and the hard label → figure → support-line
  hierarchy are taken. The sparkline and the delta are refused (§10.9).

**And a defect that only the styling pass found.** Rendering the restyled tile at its
real width showed `1,062,000 د.ع` overflowing its card in the *seed* data — four tiles
across a 1088 px column leave about 161 px beside the icon and the label, and that
figure needs 181. Giving the figure its own full-width row fixes it and holds the
largest value the screen can produce. §6.5 forbids the overflow; nothing but rendering
it at width would have shown it. Which is §12.20 again: the screen is the instrument.
