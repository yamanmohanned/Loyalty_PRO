# CLAUDE_v3.md — Supermarket Loyalty Platform: Instant-Discount Architecture

> **Version:** 3.0 — Supersedes `CLAUDE.md` (v1) and `CLAUDE_v2.md` (v2)
> **Read order:** `CLAUDE.md` → `CLAUDE_v2.md` → **this file**. Where v3 conflicts with v1/v2, **v3 wins**.
> **Nature of this update:** This is a **mid-build architectural pivot**, not a fresh start.
> Significant work already exists. Your first job is to audit it, keep what survives, and
> migrate the rest. Do not delete or rewrite anything before completing the audit in §1.

---

## 0. Non-negotiable rules (v3)

1. **Audit before you change.** Read the existing codebase fully before modifying anything.
2. **The store must never stop working.** Printing, selling, and the POS are sacred. Nothing
   we build may block or break them (see the Fail-Open rule in §4.6).
3. **Accounting integrity is absolute.** The POS-recorded amount and the cash actually
   collected must always reconcile. Never design a flow that creates an unexplained cash gap.
4. **The loyalty system never computes prices.** It reads what the POS recorded. There is one
   set of books — the POS's — and we mirror it.
5. **Financial guardrails are enforced in code**, not left to the manager's judgment (§2.3).
6. **Evidence before claims.** Never report work complete without running it (v1 §10 stands).
7. **RTL Arabic first** on every surface (v1 stands).
8. **One open blocker exists (§9).** Build around it; do not assume it resolved.
9. **Controls decay; re-check them by trigger, not by reading.** *Not one was a missing
   control — every one was a control that had stopped matching the system around it.*
   That was the finding of §12.23 and it is a recurring pattern, not a one-off. A control
   is written against the system as it stands and goes on **looking** correct in review
   long after the system has moved, so line-by-line review cannot find this class.
   **The trigger:** whenever a change alters what the service **SERVES**, what **ROLES**
   exist, or what a mitigation **ASSUMES**, re-check the controls that depended on the old
   shape. Not the changed code — the controls whose correctness quietly rested on it.
   Worked examples in §12.23.

---

## 1. Migration map — what happens to existing work

Before writing code, run a full audit of the repository and classify every module against
this table. Report your findings before making changes.

| Area | Verdict | Notes |
|---|---|---|
| Monorepo, tooling, TS config, lint | **KEEP** | No change |
| `packages/shared-types` | **REVISE** | Schema changes (§5); keep the pattern |
| Auth, RBAC, JWT, Argon2, audit log | **KEEP** | Unchanged and still correct |
| Customer entity + registration + lookup | **KEEP, extend** | Add barcode token + reprint |
| PostgreSQL + Prisma setup | **CHANGE → SQLite** | §5.1 |
| Transaction linking logic | **REVISE** | Now instant-discount, not deferred |
| Coupon engine (issue/expire/redeem) | **DISCARD** | Replaced by instant discount + voucher |
| `apps/dashboard` shell, layout, RTL, design system | **KEEP** | Genuinely reusable |
| Dashboard: customers list & detail | **KEEP, adjust** | Balance now derived differently |
| Dashboard: loyalty rules editor | **REWRITE** | New discount model (§2) |
| Dashboard: reports | **REVISE** | New metrics |
| `apps/manager-desktop` (Tauri) | **KEEP** | v2 conversion stands entirely |
| `apps/assistant` (Expo mobile) | **DISCARDED** | Replaced by the Loyalty Station (§6). Removed 2026-08-31 |
| WhatsApp as core dependency | **DEMOTE** | Now an optional module (§8) |
| Integration Gateway concept | **KEEP** | Now fed by the Print Capture Agent |

**Rule:** Do not delete `apps/assistant` until the Loyalty Station is functional. Rename it
to `apps/_deprecated_assistant` and remove it at the end of the migration.

**Done, 2026-08-31.** The Station builds, is served by the API on the manager machine's
own port (§12.3), and answers on a tablet; its endpoints have their own suite. The Expo
app and the now-unused `@walaa/config/tsconfig/react-native` preset are gone. React 18
and React 19 still coexist in this workspace — the Station and the manager desktop against
the Next dashboard — so §13.7's `declaration: false` workaround is still load-bearing and
stays.

---

## 2. The new business model

### 2.1 What changed
The discount is now applied to the **current invoice the customer just shopped with**, not a
future visit. Threshold reached → discount granted immediately on that same basket.

### 2.2 Confirmed operational facts (verified with the merchant)
- The POS is **برنامج البيان (Al-Bayan)**.
- It **prints the receipt BEFORE payment** — this is what makes instant discount possible.
- **Cashiers are NOT authorized to modify invoices.** This is a deliberate anti-fraud control
  and must be respected, not worked around.
- Al-Bayan's UI is **custom-drawn and opaque to UI Automation** — UIA reads nothing inside its
  window. **Do not attempt any UI Automation approach.** It is ruled out by field testing.

### 2.3 Financial guardrails — MANDATORY, enforce in code

Supermarket net margin is typically 2–4%. On a 25,000 IQD basket that is roughly 750 IQD of
net profit. A 10% instant discount (2,500 IQD) would **lose the store ~1,750 IQD per
qualifying sale**. Instant discounts are a pure price cut with 100% redemption and no return
visit to offset them.

Therefore the system MUST:
- Support **discount type**: `PERCENTAGE` or `FIXED_AMOUNT` (manager's choice).
- Support **minimum** and **maximum** discount rate settings.
- Enforce a **hard maximum discount value cap** (absolute IQD ceiling) applied after any
  percentage calculation. This is the last line of defense — category exclusions were
  explicitly declined, so without this cap a 500,000 IQD basket at 10% gifts away 50,000 IQD.
- Display a **live margin warning** in the settings UI whenever the manager enters a rate:
  e.g. *"خصم 10٪ على عتبة 25,000 = 2,500 د.ع — أعلى من الربح الصافي التقديري لهذه الفاتورة."*
  The software protects the merchant from a costly misconfiguration.
- **Recommended safe default:** 1–3% instant discount, or a fixed value tier structure.

### 2.4 The core loop (v3)
```
Cashier rings up items → prints receipt (BEFORE payment)
  → Print Capture Agent intercepts the print job    [invisible, automatic]
  → parses invoice number + total amount
  → sends to Manager device over the local network
Customer scans their loyalty card at the Loyalty Station (beside the register)
  → station matches card ↔ captured invoice
  → threshold check
      ├─ qualified  → prints a discount slip (before / discount / after)
      └─ not yet    → shows "تبقّى X د.ع للحصول على خصم Y"
  → customer hands the slip to the cashier and pays
  → manager dashboard updates in real time
```

---

## 3. System components

| Component | Runs on | Tech | Role |
|---|---|---|---|
| **Print Capture Agent** | Cashier PC | **C# / .NET, Windows Service** | Intercepts print jobs, parses, forwards |
| **Loyalty Station** | Tablet or screen + USB scanner | **Web app (React)** | Registration, scanning, slip printing |
| **Manager Desktop** | Admin room PC | **Tauri 2 (from v2)** | Server + SQLite + dashboard |

The **Manager Desktop machine is the single source of truth.** It hosts the local API service
(Windows Service, starts with the machine) and the SQLite database. The other two are clients.

**Why C#/.NET for the agent:** print spooler APIs, port monitors, serial bridging, and Windows
Service hosting are all first-class in .NET. This is the correct tool for this one component,
and it does not break stack consistency — the agent talks to the API over HTTPS like any other
client. Its internal language is irrelevant to the rest of the system.

---

## 4. Print Capture Agent (the critical new component)

### 4.1 Governing principle
**The agent sits between the POS and the printer, at whatever layer the POS uses, and always
forwards.** It copies; it never blocks, alters, or delays the receipt.

### 4.2 The four capture modes
Implement all four. The agent must work regardless of how Al-Bayan prints.

| Mode | Applies when | Mechanism | Setup required |
|---|---|---|---|
| `SPOOL_WATCH` | POS uses the Windows print system | Watch `C:\Windows\System32\spool\PRINTERS` for `.SPL` files, read RAW data | None (passive) |
| `VIRTUAL_PRINTER` | Same, but more reliable | Pass-through printer that captures then forwards to the real printer | Point Al-Bayan at it |
| `SERIAL_BRIDGE` | POS writes directly to a COM port | Virtual COM pair (com0com); agent reads and forwards to the real port | Change port in Al-Bayan |
| `NETWORK_PROXY` | Printer is network-attached | Listen on port 9100, capture, forward to the printer's real IP | Change printer IP in Al-Bayan |

### 4.3 Auto-detection
On install, run a diagnostic mode that tests each mode in order and reports which produces
data. Persist the winner in settings. Allow manual override.

### 4.4 The hard case — raw USB
If the POS writes raw bytes directly to a USB printer, software interception would require a
**kernel-mode USB filter driver** (driver signing certificate + Microsoft attestation).
**Do not attempt this.** Cost and complexity are disproportionate.

**Practical workaround instead:** relocate the thermal printer to be owned by the agent
machine and shared over the network, so Al-Bayan prints to a shared printer the agent fully
controls. For legacy apps that only write to `LPT1`, map the local port to the network printer
via `net use LPT1:`. Document this in the setup guide.

### 4.5 Parsing pipeline
1. **Strip ESC/POS control sequences** (`ESC 0x1B`, `GS 0x1D`, etc.) to isolate plain text.
2. **Decode Arabic text correctly.** Arabic-market thermal printers commonly use **CP864** or
   **Windows-1256**, NOT UTF-8. Wrong decoding yields garbage. Make the codepage configurable
   with auto-detection. **Also handle Arabic-Indic digits (٠١٢٣٤) as well as Western digits** —
   a total captured but not parsed is still a failure.
3. **Extract values via an external template file** (`pos-template.json`), never hardcoded
   rules. The template defines how to locate the invoice number and total (e.g. "the number
   following the label الإجمالي"). This is what makes the system POS-agnostic: supporting a new
   merchant's POS becomes a new template, not a new project.

### 4.6 Fail-Open rule (MANDATORY — corrected 2026-08-27)

**Intent:** the store losing the ability to print receipts because a loyalty agent failed is
an unacceptable operational failure.

**Correction.** The original wording ("design every mode so the pass-through path survives
agent failure") was not achievable for three of the four modes and is replaced. Only
`SPOOL_WATCH` is genuinely out-of-path — it observes a spool directory and can die without
the printer noticing. `VIRTUAL_PRINTER`, `SERIAL_BRIDGE` and `NETWORK_PROXY` all sit
**in** the print path: if the agent process is not running, there is no code to forward with.
Claiming otherwise would be a false guarantee.

The honest requirement is therefore:

1. **`SPOOL_WATCH` is the PREFERRED mode.** Auto-detection tries it first and selects it
   whenever it yields data, precisely because it is passive and cannot block printing.
2. **In-path modes are FORWARD-FIRST.** Bytes are written to the real printer/port **before**
   any capture, parsing, queuing, or network work. Capture happens on a separate thread from
   an in-memory buffer. A parsing bug, a full disk, or a dead network must never delay or
   block forwarding.
3. **The forwarding path is minimal and dependency-free** — no parsing, no I/O beyond the
   write, no allocation that can fail. It is covered by a test that kills the capture/parse
   side while asserting forwarding continues.
4. **A watchdog restarts the agent immediately on crash**, bounding the window in which an
   in-path mode cannot forward.
5. **A ONE-STEP MANUAL REVERT is documented in the setup guide** — restore the original
   printer or port setting — so the merchant can restore printing without the developer if
   the agent fails repeatedly.

**Residual risk, stated plainly:** for the three in-path modes there is a window between
process death and watchdog restart during which a print job can be lost, not merely delayed.
`SPOOL_WATCH` has no such window. This is the reason for its preference.

### 4.7 Calibration mode (build this)
In manager settings: print a test receipt → the app displays the captured text → the operator
**clicks the total and clicks the invoice number** → the system generates the parsing template
automatically and validates it against the next receipt. This turns onboarding a new store
from a coding task into two minutes of clicking.

### 4.8 Idempotency
Every captured invoice carries `(branch_id, invoice_id)` uniqueness. Re-sent captures (network
retry) must never create duplicate transactions.

---

## 5. Data architecture

### 5.1 Storage: SQLite (changed from PostgreSQL)
Storage is now **local on the Manager Desktop machine**. SQLite is correct here: a single file,
no separate service to administer, backup is a file copy, and performance is more than
sufficient for one supermarket's volume. Keep Prisma as the ORM — only the provider changes.

**Honest risk to mitigate:** all data on one machine means a disk failure, theft, or malware
loses everything. §7 backup requirements are therefore **mandatory, not optional**.

**Where the file lives, and who may read it** *(settled by the packaging spike, 2026-08-28)*:

| | |
|---|---|
| Path | `%PROGRAMDATA%\Walaa\walaa.db` — machine-scoped, alongside `walaa.env` and `logs\` |
| Service account | `LocalSystem` |
| Permissions | inheritance removed; `SYSTEM` and `Administrators` only |

**Machine-scoped, never a user profile.** The API runs as a Windows Service under
`LocalSystem`, not as the manager's login. A database under the manager's `AppData` would
be reachable by the service only by accident, and not at all before that profile has been
loaded — the service would start cleanly and then fail to open its database, which is the
worst shape of failure: running, reporting healthy to the SCM, and useless. Nothing else
touches the file: the dashboard and the Station reach their data over HTTP, so no second
account needs access.

**The directory is locked down at install time, and this is not optional.**
`%PROGRAMDATA%` grants `BUILTIN\Users:(OI)(CI)(RX)` by default and every file created
underneath inherits it — measured on the build machine, not assumed. Left alone, the
customer list, with the phone numbers §7.11 calls the one identifier worth protecting,
would be readable by every local account on the shop's PC. `walaa-service.exe install`
therefore strips inheritance from the data directory and grants `SYSTEM` and
`Administrators` only. **Consequence:** reading the logs or the database during support
needs an elevated prompt.

### 5.2 Schema changes from v1 §4

**Removed:** `coupon`, `balance_snapshot` (as previously modeled), `loyalty_tier` (reshaped).

**Revised `transaction`:**
```
id, merchant_id, branch_id, invoice_id,
customer_id (nullable — invoices captured before a card is scanned),
amount_gross          -- as recorded by the POS
discount_type         -- PERCENTAGE | FIXED_AMOUNT | NONE
discount_rate         -- the configured rate applied
discount_value        -- actual IQD discounted (post-cap)
amount_net            -- amount_gross - discount_value
capture_mode          -- SPOOL_WATCH | VIRTUAL_PRINTER | SERIAL_BRIDGE | NETWORK_PROXY
captured_at, linked_at, station_id, occurred_at, created_at
UNIQUE (merchant_id, branch_id, invoice_id)
```

**New `discount_rule`:**
```
id, merchant_id, threshold_amount, discount_type,
discount_rate, max_discount_value, is_active, sort_order
```

**New `discount_settings` (singleton):**
```
merchant_id, discount_type, min_rate, max_rate,
absolute_max_discount_value, period_type
```

**New `voucher`:** issued discount slips — `id, transaction_id, customer_id, value,
issued_at, status (ISSUED | REDEEMED | VOID), redeemed_at`. Needed for end-of-day
reconciliation against collected slips.

**New `feature_flags`:** `key, is_enabled, updated_by, updated_at` (§8).

**New `sync_queue`** (local to Station and Agent only): pending operations awaiting delivery.

**Retained:** `merchant`, `branch`, `user`, `customer` (add `barcode_token` unique),
`audit_log`, `notification_log`.

**Added 2026-08-31 by §12.25 (pre-printed cards, design proposed — not yet built):** a
`card` table and a `card_batch` table. The card number moves off `customer.barcodeToken`
and onto the card row, because a customer may hold several cards over time and a replaced
card has to stay rejectable by number. Existing customers backfill to one `ASSIGNED` card
each. See §12.25 for the states, the constraints, and what enforces them.

### 5.3 Derivation rule (unchanged and critical)
**Cumulative balance is NEVER stored as a number.** It is always computed from `transaction`
rows within the active period. Stored aggregates drift and corrupt; the source log does not lie.

### 5.4 Money handling
Integer IQD only. Never floats. Document the unit explicitly.

---

## 6. Loyalty Station (`apps/station`)

Replaces the discarded Expo app. A **React web app** served by the Manager machine.

### 6.1 Why a web app, not a native app
It must run on both a touch tablet and a desktop screen with a USB scanner. A responsive web
app covers both with one codebase and requires no app-store distribution.

**Key technical fact:** USB barcode scanners act as **keyboard wedges** — they "type" the code
then send Enter. So the station needs only a focused input field. No device-specific code.

### 6.2 Screens
1. **First-run setup** — server URL (as in v2 §9), then station login.
2. **Login** — station operator account (role: `STATION`).
3. **Main scan screen** — ONE screen, ONE focused input, huge type. Three possible outcomes:
   - Qualified → discount slip prints; show amounts large.
   - Not qualified → show progress: *"تبقّى X د.ع للحصول على خصم Y"* (framed as progress, never
     as rejection — this is a sales prompt).
   - Unknown card → offer registration.
4. **Customer registration** — **name and phone only**. Every extra field slows the queue and
   reduces enrollment. Generates a permanent barcode, prints the card.
5. **Card reprint / lookup** — search by name or phone → reprint **the same code**, never a new
   one (the customer must not lose their history).

> **Superseded in part, 2026-08-31 — see §12.25.** The merchant has moved to durable
> pre-printed cards carrying a serial he orders in batches, so #4's *generate a number and
> print it* becomes *assign a card that already exists*: the operator enters name and phone,
> then **scans the blank card being handed over** rather than typing its serial. #5 is
> unchanged, and the thermal printing in §6.3 stays as the fallback for a customer who needs
> a card when no blank is to hand. §12.25 carries the barcode format, the card states and
> the batch rules.

### 6.3 Printing
- **Customer card** and **discount slip** print to the station's own small thermal printer
  (separate from the cashier's).
- **Discount slip contents:** invoice number, amount before discount, discount rate/value,
  amount after discount, timestamp, voucher ID. The cashier must not need to calculate anything.
- **Practical warning to surface in the setup guide:** thermal paper fades within weeks in Iraqi
  heat. Recommend card stock or lamination for customer cards, and always send the barcode image
  via WhatsApp as a non-fading backup when that module is enabled.

### 6.4 UI discipline
The operator UI is deliberately minimal — one screen, one field, three outcomes, learnable in
two minutes. **All configuration and complexity live in the Manager Desktop app, behind manager
authentication.** The station operator must never see a settings screen.

---

## 7. Networking, sync, and backup

### 7.1 Local network topology
```
Cashier PC (Agent) ──┐
                     ├──► Manager PC (static LAN IP) : API service + SQLite
Loyalty Station    ──┘
```
- Manager machine gets a **DHCP reservation** on the router for a stable address.
- Internal LAN traffic over a WPA2/WPA3-protected store network. This is a deliberate, scoped
  exception to HTTPS-everywhere for **internal traffic only**; all external traffic stays encrypted.

### 7.2 Real-time sync
- Station and Agent hold a **persistent WebSocket** connection to the Manager service.
- On each captured invoice or card scan: write to SQLite → **broadcast to all connected clients**.
  Manager dashboard updates in **under one second**, with no manual refresh.
- **Offline resilience:** each client queues operations locally in `sync_queue` and flushes on
  reconnect. Every operation carries a unique ID; the server rejects replays. **No work stoppage,
  no data loss.**

### 7.3 Backup (MANDATORY — 3-2-1)
- **Scheduled encrypted upload to Google Drive** (daily after close + every 500 transactions).
- **Encryption before upload is required.** Financial data must never leave the machine in
  plaintext to third-party storage.
- **Local copy + external USB copy** in addition to Drive. One medium is never enough.
- **Monthly restore test.** An untested backup is not a backup — this is the most commonly
  skipped step and the most costly.
- Setup note: requires a Google Cloud project and OAuth credentials; a one-time setup, not instant.

---

## 8. Feature flags (modularity requirement)

Every optional module checks a flag in `feature_flags` before rendering or executing. Toggled
from Manager settings — **no code changes, no separate builds, one binary for all merchants**.

Flags to implement:
`whatsapp_integration` · `customer_card_printing` · `cloud_backup` · `advanced_reports` ·
`voucher_reconciliation` · `sms_fallback`

**WhatsApp is now optional, not core.** In the v3 model the customer holds a printed card and
receives an instantly printed slip — nothing in the core loop depends on messaging. WhatsApp
adds: barcode image backup, purchase summaries, "you're X away from a discount" nudges, and
re-engagement. Note in the UI that WhatsApp Business API requires **Meta-approved templates**
and is **billed per conversation**.

---

## 9. CLOSED — settlement is the merchant's, not ours

**Closed by operator ruling, 2026-09-01.** This section stood open from the first day of
v3 and gated nothing in the end. The merchant has his own accounting method for discounts
and payment handling, is not asking us to prescribe one, and has **withdrawn the
split-payment question** about Al-Bayan. It is not a blocker, and no checklist item, phase
or release waits on it any longer.

**What the system does, and where its responsibility stops.** It captures the invoice,
calculates the discount under the §2.3 guardrails, records both, and prints a slip
carrying **gross / discount / net** plus a voucher code. How that discount is entered in
the merchant's books is his decision and outside our scope.

**All three settlement strategies remain available, and the choice is a per-store
setting** — `discount_settings.settlement_strategy`, changed from the manager's Discounts
screen, applying to the next slip printed with no rebuild and no redeploy. What the
setting selects is now **only the wording of the cashier instruction** on the slip:

| Strategy | The instruction it prints |
|---|---|
| `MERCHANT_DEFINED` **(default)** | states the three figures and says to apply the discount per the store's own procedure — assumes nothing about how it is recorded |
| `VOUCHER_AS_PAYMENT` | collect net in cash plus this voucher, leave the invoice at full value — presumes the POS accepts a second tender |
| `DAILY_PROMOTIONAL_EXPENSE` | collect the full amount, hand back the discount against the slip, retain it — presumes it does not |

The default is the neutral one because a printed instruction is an assumption about the
store's procedure, and this store's procedure is not ours to assume. A merchant who wants
the procedure on the paper selects one of the other two. See §12.28.

**The one rule that survives closure, unchanged:** never a flow where the cashier collects
less cash than the POS recorded without a corresponding voucher record. That is an
unexplained shortfall that reads as theft in the books and will wrongly implicate staff.
It is now guaranteed structurally rather than by wording — the voucher is written in the
same transaction as the discount (§12.9), so no instruction text is load-bearing for it.

---

## 10. Skills and tools to use

Use these deliberately — they materially improve accuracy and reduce rework.

### Always active
- **`verification-before-completion`** — before any "done" claim. Mirrors §0 rule 6. Run it
  on every phase boundary without exception.
- **`full-output-enforcement`** — prevents truncated/placeholder code in long files.

### Phase-specific
| When | Skill / tool | Why |
|---|---|---|
| Auditing existing code (§1) | **`analyze-project`**, **`graphify`** | Understand the current repo before changing it |
| Designing module seams (Agent, Gateway, Strategy) | **`codebase-design`**, **`design-an-interface`** | Deep modules, clean boundaries |
| Stress-testing the migration plan | **`grill-me`** | Surface flaws before writing code |
| Manager dashboard UI | **`frontend-design`**, **`ui-ux-pro-max`** | Design tokens, non-generic UI |
| Station UI (tablet) | **`mobile-ux-design`**, **`mobile-app-ui-design`** | Touch targets, thumb zones |
| React implementation | **`vercel-react-best-practices`**, **`vercel-composition-patterns`** | Performance, composable APIs |
| UI review before sign-off | **`web-design-guidelines`** | Accessibility and UX audit |
| Tauri desktop app | **`testing-tauri-apps`** | Correct testing patterns for Tauri |
| Testing the Station web UI | **`agent-browser`** | Exercise real flows end to end |
| Executing independent tasks | **`subagent-driven-development`** | Parallelize safely |

### Tooling discipline
- Use **bash** to actually run builds, migrations, and tests — never assume they pass.
- Use **file tools** to read the full existing implementation before editing.
- Keep `CLAUDE_v3.md` updated with any architectural decision you make.

---

## 11. Anti-patterns (v3 additions)

- Do NOT attempt UI Automation on Al-Bayan — ruled out by field testing.
- Do NOT attempt a kernel-mode USB filter driver.
- Do NOT let agent failure block printing.
- Do NOT create a cash-vs-POS discrepancy under any circumstance.
- Do NOT store cumulative balance as a number.
- Do NOT hardcode receipt parsing rules — use the template file.
- Do NOT assume UTF-8 for thermal printer text, or Western-only digits.
- Do NOT build the Expo mobile app or the coupon engine.
- Do NOT expose any settings on the Loyalty Station.
- Do NOT ship a percentage discount without an absolute value cap.
- Do NOT rebuild a screen from the Stitch exports without reading §12.26 first — they
  describe the v1 product, and six of the thirteen are for things v3 discarded.
- Do NOT reintroduce per-customer discount overrides — discarded by design, not
  missing (§12.27). §2.3's minimum, maximum and absolute cap only bind while there
  is one ladder for them to bind.
- Do NOT declare a server response shape in a client. It goes in
  `packages/shared-types` and both sides import it (§12.27, checked by a test).
- Do NOT call a human-readable format done on a passing unit test. Look at it
  rendered (§12.27).
- Do NOT restore `hoist-pattern[]=*` in `.npmrc`. If a package's own types stop
  resolving, add it to `packageExtensions` (§12.24).

---

## 12. Decision log (v3)

Architectural and environmental decisions made during the migration. §10 requires
this file be kept current; append here rather than deciding twice.

### 12.1 Toolchain and temp directories relocated to `E:` — 2026-08-27
*(operator-approved)*

The development machine's `C:` drive is full (146 MB free of 119 GB). This is not a
tidiness problem: it already broke the build. `pnpm install` for the dashboard failed
for want of temp space, leaving `@walaa/dashboard` unable to typecheck, and earlier in
the build it flipped Docker's containerd metadata store to read-only, which silently
dropped the Postgres port mapping and made tests fail intermittently for reasons that
looked like application bugs.

Relocated at **User** scope so it survives reboots:

| Variable | Was | Now |
|---|---|---|
| `TEMP` / `TMP` | `C:\Users\yaman\AppData\Local\Temp` | `E:\temp` |
| `CARGO_HOME` | (unset) | `E:\rust\cargo` |
| `RUSTUP_HOME` | (unset) | `E:\rust\rustup` |
| `Path` | — | `+ E:\rust\cargo\bin` |

Rust 1.98.0 (stable, MSVC host, minimal profile) installed to `E:\rust` — **0.57 GB,
none of it on C:**. pnpm's store was already on `E:\.pnpm-store`.

**To revert:** set `TEMP`/`TMP` back to `C:\Users\yaman\AppData\Local\Temp`, remove
`CARGO_HOME`/`RUSTUP_HOME`, drop `E:\rust\cargo\bin` from `Path`, delete `E:\rust`.

**This is mitigation, not a fix.** `C:` remains ~99.9% full and that will keep causing
failures in tooling this project does not control. Recommend the operator reclaim real
space independently.

### 12.2 PostgreSQL is retired only after SQLite is proven — 2026-08-27
*(operator-approved)*

Ordering, which matters more than the decision itself:

1. Phase V3-1 stands up SQLite alongside the running Postgres container.
2. The migration and seed must apply, and the business-logic tests must pass against
   SQLite, **before** anything Postgres-related is removed.
3. Only then: stop and remove the `walaa-postgres` container and its
   `loyalty_walaa-pgdata` volume, and delete `docker-compose.yml`.

Rationale: this follows the standing rule that nothing is deleted before its
replacement works (PROMPT_v3, Process rules). Dropping Postgres first would leave no
working datastore if the SQLite migration hits the enum/isolation/raw-SQL problems
catalogued in `analysis_outputs/RISKS.md` §R2.

Secondary benefit: removing the Docker Postgres stack reclaims roughly 4.3 GB from the
`C:` drive, which §12.1 only worked around.

### 12.3 Runtime topology — local only, no inbound internet — 2026-08-27
*(operator decision; supersedes CLAUDE_v2.md §8 entirely)*

**CLAUDE_v2.md §8 is VOID.** There is no VPS, no public domain, no Caddy, no hosted
PostgreSQL, and no inbound internet dependency anywhere in v3.

Governing principle: **no inbound internet. Outbound-only where needed.**

| Concern | Decision |
|---|---|
| API service | Fastify compiled to a **single binary**, installed as a **Windows Service** — *not* a Tauri sidecar |
| Why not a sidecar | A sidecar dies with the dashboard window. The station and agent need the API alive for all working hours regardless of whether the manager has the app open. |
| Distribution | **One** NSIS installer. It registers the Windows Service as a post-install step, so the merchant receives a single setup file covering Tauri app + API service + SQLite. Never two installers. |
| `apps/station` hosting | Served as **static files by the same API service** (Fastify static plugin) on the same port. The tablet browses `http://<manager-lan-ip>:<port>`. No second web server. |
| SQLite location | Under the OS app-data directory for the **service account**, parameterised through the validated config module. |

The Cloudflare Tunnel discussed in earlier sessions is **VOID** — it belonged to the
abandoned customer-self-linking model. In v3 the customer scans in store.

### 12.4 Cloud scope — 2026-08-27
*(operator decision)*

| Capability | Status | Reasoning |
|---|---|---|
| **Google Drive backup** | **IN SCOPE, MANDATORY** (§7.3) | Outbound-only, needs no inbound exposure, and is the direct mitigation for single-machine storage risk. Encryption before upload is required. |
| **Auto-updater** | **OUT OF SCOPE.** Feature flag `auto_update`, default **disabled**. Do not build the manifest endpoint. | The developer hand-installs on merchant machines, and stores may lack reliable internet. If enabled later, **GitHub Releases** can host the signed manifest at zero cost — no server required. |
| **WhatsApp** | Viable, behind its flag, default disabled | Outbound-only, so the no-inbound rule does not exclude it. |

### 12.5 SQLite concurrency — resolved by architecture — 2026-08-27
*(operator decision; closes `analysis_outputs/RISKS.md` R4)*

**The API service is the SOLE writer to the SQLite file.** The Print Capture Agent and
the Loyalty Station never touch the database; they call the API. Concurrent readers
plus one serialised writer is well inside SQLite's capability at one supermarket's
volume.

Requirements this imposes:
- **WAL mode enabled** on connection.
- A test that exercises **concurrent agent + station + dashboard traffic** and asserts
  no lock errors.

### 12.6 Al-Bayan sample bytes — not blocking — 2026-08-27
*(operator decision)*

A real captured sample will be supplied before V3-5. Until then the parser is built and
tested against **synthetic ESC/POS fixtures** covering CP864 and Windows-1256, and
Arabic-Indic as well as Western digits. The reconstructed receipt fixtures already in
`design/receipts/` are the starting point.

### 12.7 `grill-me` ownership — 2026-08-27
The `grill-me` skill is user-invocation-only and cannot be called by the agent. The
operator runs it. **PROMPT_v3.md's instruction to invoke it is superseded** — treat that
line as the operator's responsibility, not a phase gate.

### 12.8 Settlement blocker unchanged — 2026-08-27
*(Superseded by §12.28 on 2026-09-01: §9 is closed. Kept as the record of where it
stood.)*

§9 remains **open**. `DiscountSettlementStrategy` is built with both implementations —
`VoucherAsPaymentStrategy` (default) and `DailyPromotionalExpenseStrategy` (fallback) —
and no phase waits on the answer.

### 12.9 Instant-discount engine decisions (V3-2) — 2026-08-27

**The crossing basket is itself discounted.** Cumulative spend is evaluated
*including* the invoice being scanned. The alternative — evaluating on prior spend
only — would mean the basket that reaches a threshold is the one basket that does
not benefit from it, which no customer would accept as fair and no cashier could
explain.

**Progress is measured on gross, not net.** `computeCumulativeAmount` sums
`amountGross`. Using the net figure would let each granted discount slightly retard
progress toward the next tier — a quiet penalty for being a good customer.

**Ingestion answers a duplicate with 200 and `duplicate: true`, not 409.** From the
agent's point of view a retry that finds the capture already recorded has succeeded;
its job was to make sure the invoice landed. A 409 would push a normal, expected
event onto the agent's error path and risk it queueing the capture indefinitely.

**Attribution claims the invoice with a conditional UPDATE** (`customerId: null` in
the WHERE). Two stations scanning simultaneously cannot both claim one capture; the
loser is told nothing is pending rather than being handed a second discount on one
sale. The `@@unique([transactionId])` on `voucher` is the second guard behind it.

**The voucher is written in the same transaction as the discount.** If the voucher
cannot be persisted, the discount rolls back with it. There is deliberately no code
path that reduces what a customer pays without creating the record that explains
it — an unexplained shortfall in the drawer reads as theft and would wrongly
implicate whoever was on the till (§0 rule 3, §9).

**The settlement strategy is stamped on each voucher at issue time**, not read from
settings at reconciliation. A manager switching strategy must not retroactively
reinterpret slips already sitting in the cash drawer.

**Rates outside the recommended band are warned about; rates outside the merchant's
own configured min/max are rejected.** A merchant may knowingly run an aggressive
promotion, but the bounds they set for themselves are a limit, and a bound that can
be exceeded is not a bound. A `FIXED_AMOUNT` rule above the absolute cap is also
rejected — the engine would silently cap it, and configuring a number the system
ignores is worse than being told no.

**Pending-invoice lookup is time-bounded** (30 minutes by default). Without a
window, a stale capture from hours earlier would be handed to whoever scans next,
attributing a stranger's basket to them and granting a discount on spending they
never did.

**WebSocket auth takes the token as a query parameter.** Browsers cannot set an
Authorization header on a WebSocket handshake. This is a real tradeoff — tokens in
URLs can reach logs — accepted because the access token is short-lived (~15m) and
this is LAN-internal traffic (§7.1).

**`publish()` never throws.** A dead socket must not fail the sale that triggered
the event: the transaction is already committed, and a dashboard that missed an
update catches up on its next read.

### 12.10 Manager Desktop decisions (V3-3) — 2026-08-27

**The v2 Tauri conversion had never been performed.** CLAUDE_v3.md §1 classified
`apps/manager-desktop` as KEEP, but the build had followed v1 straight from the API
into a Next.js `apps/dashboard`. V3-3 therefore did the v2 conversion *and* the v3
screens. `apps/dashboard` is left in place until its last reusable parts are
confirmed ported, per the standing rule that nothing is deleted before its
replacement works.

**The nav rail is the FIRST child of the shell flex container.** Under `dir="rtl"`
a flex container lays its main axis right-to-left, so the first child renders at the
right edge — which is where §6.5 puts the rail. Writing it after `<main>`, the LTR
habit, silently mirrors the whole layout the wrong way. Caught by measuring
bounding boxes in the live app, not by reading the code.

**The margin warning uses `assessMargin` imported from `@walaa/shared-types`** —
the same function the API validates with. A separate frontend approximation could
drift, and then the number a manager is shown while configuring would not be the
number that governs at the till.

**`HashRouter`, not `BrowserRouter`.** Tauri serves the frontend from the
filesystem in production, so path-based routing 404s on a hard reload.

**CORS needed the Tauri webview origin.** The API allowed only
`http://localhost:3000`, left over from the Next.js dashboard. The Tauri 2 webview
on Windows presents as `http://tauri.localhost`, and the Vite dev server as
`http://localhost:5173`; both are now defaults in the config module so a fresh
install works without editing `.env`. Found by the live browser test, which is the
only place it could have surfaced.

**Fonts are bundled and verified as such.** 28 woff2 files ship in the bundle and
the built output contains no reference to `fonts.googleapis.com` or
`fonts.gstatic.com`. §14 names the CDN font tag as a critical bug in a desktop app,
so it is checked rather than assumed.

**Capture and Backup screens state what is not yet built.** The Print Capture Agent
lands in V3-5 and the Drive integration in V3-6, so those screens show "not
installed" and "not connected" rather than a reassuring placeholder. A backup screen
that looks healthy while backing nothing up is worse than no screen.

### 12.11 Packaging and distribution — 2026-08-28
*(packaging spike, run before V3-4; refines §12.3, which stated the intent)*

The spike answered one question: can §12.3's "one NSIS installer covering Tauri app
+ API service + SQLite" actually be built? It can. The machinery is in
`packaging/`, and `packaging/README.md` carries the operator-facing detail. What
follows is what the answer cost and what it changed.

**"A single binary" was the wrong target. One installer is the right one.** §12.3
asked for the API "compiled to a single binary". Node's SEA can embed the bundle
into a copy of `node.exe`, but the Prisma query engine (21 MB) and the Argon2 addon
are native `.node` files that must sit beside the executable either way — so SEA
yields a single *file* in a directory that is still a directory, with no size saving
and an experimental-feature warning on every boot. Rejected. The property the
merchant cares about is **one setup file and no second installer**, and the NSIS
bundle delivers that. `node.exe` (86 MB, MIT, redistributable) is staged alongside a
plain CJS bundle.

**The installer is 30.1 MB.** 109 MB staged compresses to 30.1 MB of NSIS payload,
against 2.1 MB for a control build with the runtime resource removed — the
measurement that confirms the payload is really in there, since a solidly compressed
NSIS archive gives up no filenames to inspection. 30 MB travels over WhatsApp, which
is the constraint CLAUDE_v2.md §1 set.

**The production bundle is CommonJS, not ESM.** The Prisma client is CJS and its
entry point spreads a `require()`, which Node's named-export detection cannot see
through — `import { PrismaClient }` from a pure-ESM bundle is a coin flip. CJS also
removes `import.meta.url` from the equation, which mattered: the old config loader
resolved the `.env` four directories up from its own source file, and in a bundle
that path points nowhere. Configuration discovery now goes through
`apps/api/src/config/paths.ts` and uses `process.cwd()` plus explicit environment
variables, which behave identically in both worlds.

**The Prisma CLI does not ship; the service migrates itself.** Shipping
`prisma migrate deploy` would put tens of megabytes of developer tooling on a shop's
PC to run once, and would make first boot depend on a subprocess whose failures the
installer cannot report. `apps/api/src/lib/migrate.ts` applies the committed
migration SQL directly and records it in **Prisma's own** `_prisma_migrations` table
using **Prisma's own** checksum algorithm — a test asserts our checksum equals the
one the CLI wrote, so a merchant's database stays legible to `prisma migrate status`
during a support call. It fails closed: a changed migration file, or one left
half-applied, stops the boot rather than serving a schema the code was not built
against. Each migration runs in one transaction, so a failure leaves nothing behind.

**The data directory is locked to SYSTEM and Administrators.** Found while checking
whether the service account could reach the database at all: `%PROGRAMDATA%` grants
`BUILTIN\Users:(OI)(CI)(RX)` and children inherit it, so the customer list would have
been readable by every local account on the shop's PC. `install` now strips inheritance
from the data directory *after* writing the configuration — after, so that the running
installer does not lock out its own next write; the configuration file carries its own
explicit ACL from the moment it is created, so the order costs nothing. Recorded in
§5.1, asserted in `verify:service`.

**Program files and data are separated, and uninstall never touches the data.**
Everything writable — `walaa.db`, `walaa.env`, `logs/` — lives in
`%PROGRAMDATA%\Walaa`; `Program Files` is read-only to the service account. An
upgrade runs an uninstall first, so an uninstall that deleted data would eventually
delete a shop's customers on a routine update.

**Configuration file precedence puts the repository first.** `WALAA_ENV_FILE` (set
by the service host) wins, then the repository `.env`, then
`%PROGRAMDATA%\Walaa\walaa.env`. Preferring the checkout is deliberate: a developer
who also has the product installed would otherwise find `pnpm dev` quietly reading
the shop's configuration and writing to the shop's database. An installed service can
never reach that branch — there is no workspace marker above `Program Files`.

**Secrets are generated per installation and the file is locked down.**
`walaa-service.exe install` writes `walaa.env` with three fresh 32-byte secrets, then
strips inherited ACLs to SYSTEM and Administrators. A signing key baked into the
installer would be identical in every shop, so a token minted on one merchant's
machine would authenticate on every other. `%PROGRAMDATA%` grants read to all local
users by default, and that file holds the JWT keys. **Consequence:** post-install
`console` diagnostics must be run elevated. An existing file is never overwritten —
rotating `QR_TOKEN_SECRET` would invalidate every loyalty card already printed.

**Stopping the API needed a mechanism, not a signal.** Windows has no SIGTERM, and
`GenerateConsoleCtrlEvent` requires a console that a service does not have. The
remaining options were a control port on localhost — a new authenticated surface on a
machine whose security model is "no inbound network" — or closing a pipe the child
already holds. The host closes the child's stdin; the API treats that as a stop
request when `WALAA_SUPERVISED=1`. Termination is the fallback after a 15-second
grace period, which WAL makes survivable.

**The service supervises, and Windows supervises the service.** The host restarts a
dead API with exponential backoff (2s → 30s, reset after 60s of health), and the SCM
failure actions restart the host itself. Verified by killing the API mid-run and
watching it come back — `packaging/scripts/verify-service.mjs`.

**The firewall rule is part of installation.** Windows blocks inbound 4000 by
default, so without it the Loyalty Station never connects and the failure presents as
a broken app rather than a closed port. The rule covers the **private and domain**
profiles only; a shop network classified "Public" will not match it, and the V3-6
setup guide must include that check.

**What is verified, and what is not.** Two clean-room suites run unelevated and pass:
`verify` boots the staged runtime from outside the repository with a constructed
environment, proving it provisions its own database with no Prisma CLI, no repo and
no global Node; `verify:service` proves secret generation, directory and file
lockdown, supervision, crash recovery and graceful shutdown. **Anything needing the
Service Control Manager needs Administrator and was not exercised here.**

**The packaging phase stays open until the reboot test passes** *(operator directive,
2026-08-28)*. It is not a formality: it is what validates §3's choice of a Windows
Service over a Tauri sidecar. If the API is not up after a reboot with nobody logged
in, that decision is wrong and the Loyalty Station would be built on a broken
foundation. Five checks, run by `packaging/scripts/verify-install.ps1` from an
elevated prompt after a full reboot:

| | Check | Why it can fail even though the dev machine works |
|---|---|---|
| a | registered, `Automatic`, `LocalSystem` | — |
| b | running after reboot, **no login, dashboard closed** | the sidecar argument stands or falls here |
| c | `LocalSystem` can read *and write* the database | a per-user path, or an ACL the service account is not in |
| d | answers on the LAN address, not only localhost | bound to loopback, or to the wrong interface |
| e | inbound firewall rule on Private networks | Windows blocks the port by default; the Station just never connects |

Check (b) rests on the one piece of evidence that settles it: the service process's
start time against `explorer.exe`'s. A service that was already running before any
interactive shell existed did not need a login.

**Start type is plain `Automatic`, not delayed.** The service binds a socket and opens
a file, depending on nothing that arrives late in boot, and it reports RUNNING to the
SCM before spawning anything — so it cannot trip the 30-second start timeout, and an
early child failure is retried by the supervisor rather than left dead. A shop opening
in the morning wants the till working at boot, not two minutes later. `--delayed` (and
`sc config WalaaApi start= delayed-auto` on an installed machine) is there for the
merchant PC that turns out to disagree.

**The reboot test passed — 22/22 automated checks, 2026-08-28.** The evidence that
matters: the service auto-started **10.7 seconds after boot and two seconds before the
user logged in**, with the dashboard closed. §3's choice of a Windows Service over a
Tauri sidecar is therefore validated, not assumed — the API is up before anyone touches
the manager PC, which is what the Station and the capture agent depend on. Also
confirmed on the real installation: the database at `C:\ProgramData\Walaa\walaa.db` with
`SYSTEM:(I)(F)` and no `Users` entry, written to since boot; the listener on
`0.0.0.0:4000` answering on the machine's LAN address; the firewall rule enabled on
Domain and Private with the active profile Private.

**Open: (d) from a second device, pending a network without client isolation.** A
tablet on the same Wi-Fi could not reach `192.168.0.106:4000`. The operator's reading —
AP/client isolation on the test router, not a packaging defect — is supported by what
is already proven: the socket is bound to `0.0.0.0`, the machine answers on that same
address itself, and the firewall rule is active on the profile in use. **Do not
'fix' this by changing the binding or loosening the firewall.** Broadening a rule to
chase a symptom the evidence does not point at would weaken the shop's posture and
hide the real cause. To be confirmed on a network that permits device-to-device traffic.

**Deferred: ASCII install path and installer filename** *(operator directive,
2026-08-28; fix before final release, not now)*. The product name is Arabic, so the
installer is `ولاء_1.0.0_x64-setup.exe` installing to `%PROGRAMFILES%\ولاء`, and that
path does not survive the tools used to support it — the reboot test's own transcript
shows PowerShell rendering it as `E:\????\runtime`. A path a support engineer cannot
type or paste is a field-deployment risk, not a cosmetic one. Move to
`Walaa_1.0.0_x64-setup.exe` installing to an ASCII directory (`productName` in
`tauri.conf.json` drives both), and **keep the app's display name, window title, and
every screen in Arabic** — §6.1 is about what the merchant reads, not what the
filesystem stores.

**Deferred: code signing** *(operator decision, 2026-08-28)*. The installer is
unsigned and SmartScreen will warn on first run. Accepted: the developer hand-installs
on merchant machines, so a one-time "Run anyway" is a cost paid once, by the person who
wrote the software (CLAUDE_v2.md §7.2). **Revisit only if distribution changes to
merchants self-installing** — the warning would then land on someone with no reason to
trust it, and a certificate becomes the price of being installable at all. No further
effort until then.

### 12.12 The customer card number is 16 digits, not a signed string — 2026-08-28
*(operator decision, V3-4; supersedes the v1 token format)*

**Found by measuring, not by reasoning.** The v1 card token was
`v1.<32-char random>.<43-char HMAC>` — 79 characters. Encoded as Code 128 that is
**924 modules**, against **576** printable dots on an 80 mm thermal head at 203 dpi
and **384** on 58 mm. The card specified in §6.2 #4 could not be printed on any
paper the station will ever have. Nothing downstream would have caught this: the
token worked perfectly everywhere it was not a barcode.

The card number is now **16 digits**: a 10-digit random payload followed by a
6-digit truncated HMAC. Code 128 **subset C** packs two digits into the 11 modules
a single character costs, so the symbol is **143 modules** — it fits 58 mm paper
with room for a module width wide enough to scan reliably off cheap stock.

| | v1 token | v3 card number |
|---|---|---|
| Printed form | 79 chars, Code 128B | 16 digits, Code 128C |
| Modules | 924 — fits nothing | 143 — fits 58 mm and 80 mm |
| Randomness | 192 bits | ~33 bits (10 digits) |
| Signature | 256-bit HMAC | 20-bit truncated HMAC (6 digits) |
| Read aloud | no | `4821 0093 7746 1152` |

**The security properties that matter are unchanged.** The number is still opaque
(random, never derived from the phone, never walkable in sequence) and still
*signed*, so a made-up number is rejected in memory before the database is touched
— which is what stops the station being an enumeration oracle for who is a customer.

**What genuinely weakened, and why it is acceptable.** A 6-digit signature is one
guess in a million, not one in 2^256. Three things have to be true together for that
to matter: the attacker is on the shop's LAN, is guessing against a rate-limited
endpoint (120/min), and must also land on one of the few thousand 10-digit payloads
that exist. The expected cost of a single successful forgery is years of continuous
attack for the ability to look up one customer's balance. Against that: a number a
customer can read down a phone line when they have lost their card, which is a
support path that otherwise does not exist.

Collisions are handled rather than assumed away: `createCustomer` retries on the
card-number unique constraint, and distinguishes it from a phone-number collision so
a coincidence is never reported to an operator as "already registered".

**The field is still called `barcodeToken`.** It is still the token the barcode
carries, the rename would touch thirteen files mid-phase, and the schema comment says
what the value is. Revisit if it starts confusing readers.

**Alternatives rejected:** a QR code (keeps the long token, but requires a 2D imager
at every station instead of a cheap 1D laser — a per-store hardware cost for no
functional gain); a short *unsigned* lookup code (shorter still, but hands back the
enumeration oracle the signature exists to deny).

Implementation: `packages/shared-types/src/card.ts` (shape, normalisation, grouping),
`packages/shared-types/src/barcode.ts` (Code 128C, tested by decoding its own output),
`apps/api/src/lib/barcode-token.ts` (minting and verification, the only place the
secret is used).

### 12.13 Loyalty Station decisions (V3-4) — 2026-08-28

**The station is served by the API, and that removes its own setup screen.** §12.3
already put the bundle behind the same port; the consequence only became clear while
building it. If the app was served by the API, the origin the browser loaded *is* the
server address, so `resolveApiUrl()` finds it and the operator is never asked to type
an address they could not know. The setup screen survives for the case that guess
fails — a developer on Vite's port, or a tablet pointed somewhere unusual — and
nothing else in the app asks the operator to configure anything (§6.4).

**The API declares `/` and `/assets/*` by hand rather than a static catch-all.** A
wildcard would swallow unknown `/api/...` paths, and those currently reach the auth
hook with no route config and return 401 — which is what denies route enumeration to
an unauthenticated caller (§12.9). A public catch-all would have turned every one of
those 401s into a 200 serving HTML. `HashRouter` in the station means the server only
ever sees `/`, so no SPA fallback is needed to make deep links work.

**A built bundle is identified by `assets/`, not by `index.html`.** Vite keeps an
`index.html` in the project root as its dev template, whose only script tag points at
`/src/main.tsx`. The first version of the resolver matched it and served unbundled
TypeScript; in production the same weak check would have found the right directory,
so the bug would have surfaced first as a blank screen on a merchant's tablet.

**The scan field submits on Enter, on Tab, and on sixteen digits.** A form with one
input and no submit button relies on implicit submission, which varies by browser and
failed outright under test. Scanners can be configured to send Enter, Tab, or no
terminator at all, and which one a particular shop's device does is not knowable from
here — so the app stops depending on the answer. A complete card number is
self-terminating.

**A scan taken offline credits the spend and issues no discount.** The reasoning is
in the commit and in `ScanOptions.issueDiscount`, and the short version is that the
sale settles in cash before the queued scan replays, so a voucher issued then is one
the drawer cannot produce at closing time (§0 rule 3). The station says so on screen
rather than implying a slip is coming: the customer keeps their progress toward the
next discount and loses this basket's. New outcome `LINKED_WITHOUT_DISCOUNT` keeps
that distinguishable from a customer who simply had not spent enough.

**The slip is composed by the server.** The cashier instruction comes from the
settlement strategy, which is a merchant setting with accounting consequences (§9). A
station phrasing its own would be business logic in the UI (§11) whose failure mode is
a cashier told to take short payment.

**Name search exists only in the reprint flow.** CLAUDE.md §1.4 forbids name lookup
as an identification method and that ban stands where it was aimed — the scan hot
path, where a queue is waiting. §6.2 #5 is a different problem: the customer is at
the counter *without* the card that would identify them. The mitigations are tested,
not assumed: masked phone numbers, a list bounded at eight that reports when it is
truncated, and card numbers that a search never returns — those need a second,
per-customer call.

**Printing goes through the browser's print pipeline, not ESC/POS.** A web app cannot
open a USB device, and a bridge service beside the station would be another thing to
install and support in every shop. The printer is a normal Windows/Android printer and
the print stylesheet shapes the page to 80 mm. **Field consequence:** the browser shows
a print dialog unless kiosk printing is enabled, which belongs in the V3-6 setup guide
and is already noted in `packaging/README.md`.

**The refresh token lives in `sessionStorage`.** Memory alone logs the operator out on
every accidental reload, which on a tablet wedged beside a till happens often and
always at the worst moment. `localStorage` would leave a long-lived credential on the
device after closing. `sessionStorage` survives a reload and dies with the tab, which
is how the appliance is actually used — opened at the start of the day, closed at the
end.

### 12.14 Print Capture Agent decisions (V3-5) — 2026-08-29

**CP864 stores Arabic presentation forms, not base letters.** The single most
consequential thing found in this phase, and it was found by a test rather than by
reading. A CP864 receipt decodes to U+FE70–U+FEFF — the *shaped* glyphs — so a
template whose label reads «الإجمالي» in ordinary letters matches nothing. In a store
that would have presented as "the agent captures perfectly and never parses", at one
merchant and not another, with no error anywhere. Labels are now NFKC-folded before
matching, which Unicode defines as the inverse of that shaping.

**Codepage detection scores the decoded result, never the printer's claim.** `ESC t n`
means different things on different hardware. Worse, the first version of the scorer
treated presentation forms as "unexpected high characters" and therefore *preferred a
Windows-1256 misread of CP864 bytes* — the wrong codepage winning on the strength of
its own mojibake. Detection now counts presentation forms as Arabic, which is what
they are.

**Forward-first is a shape in the code, not a comment.** `PrintRelay` reads, writes to
the printer, flushes, and only then offers the bytes to a sink whose interface forbids
throwing and blocking. `ForwardFirstTests` is the suite §4.6 rule 3 asks for by name:
it breaks the capture side every realistic way — throws, out-of-memory, blocks forever,
falls behind, consumer dies mid-run — and asserts each time that the receipt still
reached the printer whole and in order.

**The capture buffer drops rather than waits, and counts what it dropped.** The first
version used `BoundedChannelFullMode.DropWrite`, which discards silently and returns
true — so the agent could never report how many captures it lost. `Wait` plus
`TryWrite` is the same non-blocking behaviour on the print path with an honest number
attached.

**A rejected capture is set aside, never deleted.** Found by an integration run: a
schema mismatch (`raw_text: null` against a field the contract declares optional, not
nullable) made the server reject every capture, and the agent — treating a 400 as
settled — destroyed two real sales. Rejections now move to `queue/rejected/`, where
nothing is lost and nothing blocks the queue behind it.

**Auto-detection short-circuits on SPOOL_WATCH.** Not merely ranked first: if spool
watching yields data the detector stops, so a store where it works never has an in-path
mode started even momentarily. §4.6 rule 1 is about which risks a store carries, and
the code makes the safe answer unreachable-by-accident rather than merely preferred.

**Parsing rules are in `pos-template.json` and nothing else.** A test proves it by
parsing an all-English receipt with a template that shares no vocabulary with the
shipped one. Supporting a new POS is a file, not a build.

**.NET restores to `E:`.** `C:` on the build machine reached zero bytes free and the
default NuGet cache failed outright. Same relocation as §12.1, committed as
`agent/NuGet.config` so a fresh clone builds without anyone knowing. **The underlying
problem is unchanged and now acute** — §12.1 recommended the operator reclaim real
space, and at zero bytes Windows itself is at risk.

**Still open:** real Al-Bayan bytes (§12.6). The parser is built and tested against
synthetic ESC/POS fixtures covering CP864 × Windows-1256 × Arabic-Indic × Western
digits, emitted to `agent/fixtures/` as real byte files so the real capture can be put
beside them and compared. Nothing in this phase waited on them.

### 12.15 Free space on the system drive is an install prerequisite — 2026-08-30
*(thresholds confirmed by the operator, 2026-08-30)*

§12.1 and §12.14 treated a full `C:` as a build-machine nuisance and worked around it
by relocating toolchains to `E:`. That framing was too small. §12.3 put the SQLite
database on the system drive of the merchant's manager PC, at
`C:\ProgramData\Walaa\walaa.db`, with no replica anywhere — so at a merchant a full
`C:` is not a tooling problem, it is an **outage**: writes fail, and with them scans,
discounts and the recording of sales.

The failure is hard to recognise from its symptom. SQLite fails writes cleanly rather
than corrupting, and reads keep working, so the dashboard renders normally while every
scan at the till errors. §12.16 exists because of that asymmetry.

**This product is not what fills the drive.** ~110 MB to install; a database growing on
the order of 200 MB a year at 500 invoices a day. The thresholds are therefore set by
what Windows needs around it — update staging wants several GB, and below roughly 2 GB
free Windows itself starts failing in ways that look like application bugs.

| Free on `C:` | Verdict                                     |
| ------------ | ------------------------------------------- |
| ≥ 20 GB      | install                                     |
| 10–20 GB     | install, flag for attention within the year |
| < 10 GB      | do not install                              |

Runtime states, for anything that reports on free space: **OK ≥ 5 GB, WARN < 5 GB,
CRITICAL < 2 GB**, re-arming about 20% above each edge so a volume sitting on a
boundary does not flap.

**The install gate applies to both machines.** The cashier PC gets the same check
before the Print Capture Agent is installed: its queue is at
`C:\ProgramData\Walaa\agent\queue`, and that machine runs three of the four capture
modes inside the print path.

#### Two defects found while writing this up, both fixed

**The agent let a storage failure escape into the capture path.** `EnqueueAsync` threw
`IOException` on an unwritable queue, and nothing caught it. Reproduced against the
unfixed code in `agent/tests/.../StorageFailureTests.cs`, it turned out to be two
different disasters depending on timing:

- **At startup**, `queue.EnsureCreated()` sat above every `await` in `ExecuteAsync`, so
  the exception came straight out of `StartAsync`. The service never came up, the SCM
  restarted it immediately by design, and it failed again. **Each restart of an in-path
  capture mode is a window in which a print job can be lost** — so a full disk on the
  cashier PC could stop the till printing, by a route with no visible connection to a
  loyalty agent. This is the §4.6 rule 3 breach.
- **Mid-shift**, the throw came from the parse loop and faulted only the parsing task.
  `ExecuteAsync` was still awaiting `Task.WhenAll` on a delivery loop that never ends,
  so the host never noticed. **The service stayed up, reported healthy, kept forwarding
  print jobs, and captured nothing ever again** — no crash, no restart, no event-log
  entry, silent until someone rebooted the till.

Fixed by making `EnqueueAsync` report a storage failure as `null` rather than throwing,
guarding the startup creation, and guarding the parse loop per job. **A capture is
still lost when the disk is full — that is honest, there is nowhere to put it — but it
is lost as a log line carrying the invoice number and amount**, because the paper
receipt is in the cashier's hand and that line is what makes the sale re-enterable.

*Not reproduced: a genuinely exhausted NTFS volume. The tests raise the same exception
type at the same call sites by putting a file where the queue directory belongs.*

**The API log cap was not a cap.** `LOG_ROTATE_BYTES` is 8 MB, but `rotate_if_large`
was called only from `spawn_api` — so the limit was enforced when the API process
started and at no other time. A service that starts at boot and runs for months wrote
an unbounded log onto the same volume as the database: this project authoring the
failure mode it spent the phase defending against. The supervisor now re-checks every
60 seconds and rotates by **copy-then-truncate**, because the child holds an inherited
append handle — renaming would move the name and leave the child appending to
`api.log.1` forever. The append-mode dependency is pinned by a test.

Recorded operationally in `packaging/README.md` → *Field setup checklist*, which also
documents every data path so the merchant's IT can monitor them.

### 12.16 A failed write is faulted at the visible action, and never refused — 2026-08-30
*(operator-confirmed, 2026-08-30; standing invariants)*

Two rules, both about the same asymmetry: this system's storage failures are quiet.

**1. The API never refuses a write because storage is running low. Absolute.**

It is tempting to "harden" a low-disk state by rejecting writes below a threshold. It
is wrong, and the reason is §0 rule 3. By the time a scan reaches the API the discount
has already been given at the register — refusing to record it does not free a single
byte and does not protect anything; it manufactures precisely the cash-versus-POS
discrepancy this product exists to prevent. **Write until SQLite says no, and warn
early enough that it never gets there.** No future session may turn this into a refusal.

The same logic retired the idea of the agent refusing to queue below a threshold. A
capture is ~500 bytes and fits until the last block; a store offline all day at 500
invoices holds ~250 KB. Refusing manufactures the loss it claims to prevent. The queue
is not what fills a disk. The only thing the agent may decline to write under pressure
is `RetainReceiptText`, which is diagnostic and unbounded — never the capture record.

**2. A write that reached the server and was not stored is faulted at the visible
action, never as a background state.**

The manager dashboard rendering normally while every scan at the till errors is the
exact shape to design against. So:

- The API answers a storage failure as **507 `STORAGE_UNAVAILABLE`**, distinct from
  `INTERNAL_ERROR`, because the two demand different things of the operator — a bug is
  ours and the till carries on, whereas a datastore that cannot write means every sale
  from now on is unrecorded. Detection matches driver message text, since Prisma has no
  code for a full disk.
- The Station shows an honest, specific card: **what did not happen, that waiting will
  not fix it, and what to do now** — "لم تُحفظ العملية … أبلغ الإدارة فوراً". It must
  never read like the offline card, which promises the opposite ("counted when the
  connection returns"). A failed write is **not** queued: the server answered, and
  retrying against a datastore that cannot write would bury the failure under a spinner.
- **The Station's honest message does not depend on the classification being right.**
  Any 5xx on a write gets the same treatment; naming storage as the cause only adds a
  hint for the manager. A missed signature costs precision, not safety.

**No standing low-disk banner on the Station.** It has zero settings by design and a
cashier cannot act on free disk space. The manager dashboard is where a background
warning belongs — proposed, not built.

### 12.17 A backup without the WAL sidecar is not a backup — 2026-08-30
*(operator-confirmed, 2026-08-30; binding requirement on V3-6)*

SQLite runs in WAL mode (§12.5), so the most recent transactions live in
`walaa.db-wal` until a checkpoint folds them into `walaa.db`. **Copying the `.db` alone
silently restores to an older day** — a backup that looks successful, restores cleanly,
and quietly loses the sales nearest to the failure that made anyone restore it. That is
worse than no backup, because no backup at least tells the truth about itself.

Binding on the V3-6 backup work:

1. **The mechanism is `VACUUM INTO`, and nothing else.** *(specified 2026-08-30,
   replacing this clause's original wording.)*

   The original text offered `PRAGMA wal_checkpoint(TRUNCATE)` followed by a copy as an
   acceptable option. **It is not, and no future session may implement it.** Checkpoint
   and copy are two statements with a gap between them, and a sale committed in that gap
   lands in a new WAL the copy does not include — the same silent loss with a smaller
   window, on a machine that is busiest exactly when the scheduled backup runs.

   `VACUUM INTO` is a single statement under a read transaction. Its output is a
   complete, self-contained database at one consistent instant, WAL contents included,
   with no sidecar of its own. There is no gap to race and nothing for a maintainer to
   forget to copy. Also forbidden: a naive file copy of `walaa.db`, and any scheme that
   requires capturing `-wal` and `-shm` alongside it.
2. The **restore test is not complete unless it proves recency**: write a transaction,
   back up, restore, and assert that transaction is present. A restore test that only
   proves the file opens would pass against exactly this bug.

Until that work lands, the handover checklist in `packaging/README.md` says the same
thing to whoever maintains the machine: the whole data directory is the backup target,
and `walaa.db` alone is not one.

**Amended 2026-08-30, after building it: the hazard above is stated more strongly than
this stack's observed behaviour supports.** Trying to stage the loss in a test —
checkpoint the WAL, commit a row through Prisma, copy `walaa.db` without its sidecar —
did not lose the row. `walaa.db-wal` sits at **0 bytes** after a committed Prisma write,
so writes reach the main database file almost immediately and a naive copy picks them
up. One configuration, one probe; it does not prove the loss cannot happen on a busy
till holding long-lived connections, and it is not a licence to copy the file naively.

What it changes is the evidence, not the requirement. `VACUUM INTO` is correct by
construction and costs nothing, so it stays. Requirement 2 stays for a stronger reason
than the WAL: **a backup can be quietly behind for many causes**, and recency is the
only assertion that catches any of them. That is now pinned by a test that stages a
stored archive older than the sentinel and shows it passing decryption, checksum and
`PRAGMA integrity_check` while failing verification.

### 12.18 Backup engine decisions (V3-6 groundwork) — 2026-08-30

Built ahead of the field validations because none of it depends on them (§7.3, §12.17).

**`VACUUM INTO`, not checkpoint-then-copy.** The obvious reading of §12.17 is "checkpoint
the WAL, then copy the file", and that is not a fix — it leaves a race in which a sale
committed between the checkpoint and the copy lands in a new WAL the copy does not
include. A shop is busiest exactly when a scheduled backup runs. `VACUUM INTO` is one
statement taking a read transaction, so the output is a complete self-contained database
at a single consistent instant, with no sidecar of its own. **The WAL question disappears
rather than being managed** — nothing is left for a future maintainer to forget to copy.
It also defragments, so the snapshot is smaller than the live file.

**Refusing a backup for want of disk is right, where refusing a sale is wrong.** §12.16
forbids the latter because the discount is already given and refusing manufactures a
discrepancy. A backup inverts cleanly: the data is already safe in the live database, so
declining loses nothing — and a backup is one of the few operations here that can itself
fill the disk, writing a second copy of the database plus an archive. The gate is
`max(3 × database size, 2 GB)`, the 2 GB being §12.15's CRITICAL threshold as an absolute
floor so a small database cannot back itself up onto a nearly-full volume.

**Archive format: gzip, then AES-256-GCM, with a plaintext authenticated header.** The
header carries version, algorithm, timestamps, sizes, a plaintext SHA-256 and a key
fingerprint — and deliberately **nothing identifying**. Whoever can see the file in Drive
learns when a backup was taken and how big it was, not whose it is. It is plaintext so a
recovery can list and triage archives without the key, and it is the GCM additional
authenticated data so editing it fails decryption rather than quietly changing what the
restore believes. The tag sits at the end, where a streaming cipher produces it; reading
seeks to the last 16 bytes first. Everything streams — this file is a gigabyte in a few
years, on a machine §12.15 is about.

**A key that exists only on the machine being backed up is not a backup.** The failures
backup exists to survive take the key with them. So it is 256 bits of `randomBytes` (a
memorable passphrase is brute-forceable from a stolen archive; an unmemorable one ends up
on a note beside the till), stored in `walaa.env` so scheduled runs are unattended, **and
it must be recorded off the machine**. The archive header carries a key *fingerprint* so
a wrong key fails as "this archive needs a different key" rather than as an
indistinguishable-from-corruption authentication error — which is the difference between
five minutes and an afternoon at the worst moment there is.

**Partial success is the normal outcome, not a failure.** 3-2-1 means the USB stick is
out of the machine most of the day and the internet drops for an hour. Each destination
reports for itself and the run asks only whether at least one copy exists. A run reported
as failed because a stick was in someone's pocket is a run whose reports nobody reads —
and §7.3's own warning is that this is the most commonly skipped step.

**Drive uses the `drive.file` scope, and requesting anything wider is PROHIBITED.**
*(operator ruling, 2026-08-30 — not a preference.)* `drive.file` reaches only files this
application itself created. **This system must never be able to read a merchant's own
files** — their photos, their contracts, their family's documents. A loyalty program
that can enumerate a shopkeeper's Google Drive has taken something it was never offered,
and no convenience justifies asking for it: not folder discovery by name, not tidier
setup, not a simpler consent screen. If a future requirement appears to need a broader
scope, the requirement is wrong.

Consequence to know: because the app cannot see folders it did not create, the configured
folder id must name a folder **this app created**, or be left unset. Raw REST rather than
`googleapis`, which is tens of megabytes for three calls on a runtime already squeezing
into a 30 MB installer.

**What is not verified.** The Drive destination **has never run against the real Google
API** — that needs a Google Cloud project and OAuth client, which §7.3 itself names as a
prerequisite and which no code can conjure. Its protocol logic is tested against a fake
transport, including the assertion that what crosses the wire is ciphertext: a real
snapshot containing a customer's phone number in the clear is encrypted, uploaded, and
the captured request body is checked for that number. When credentials arrive, the first
thing to check is that Drive's real responses match the shapes those tests assume.

**Restoring over the live database is deliberately not offered.** `restoreArchive` writes
to a file and inspects it. Overwriting production is a decision with a human and a
stopped service behind it, and every path a scheduler can reach must be incapable of
destroying the thing it exists to protect.

### 12.19 The backup key ceremony — 2026-08-30
*(operator ruling, 2026-08-30: highest priority, blocking)*

§12.18 built encrypted backup and flagged the danger in it. This is the answer.

**A key that exists only on the machine being backed up is not a backup.** Fire, theft,
ransomware, a dead disk — every failure backup exists to survive takes the key with the
data. What is left is a folder of intact, encrypted, **permanently unrecoverable**
archives sitting safely in Drive. Worse than having no backup, because a merchant with
no backup knows it, arranges something else, and is not surprised.

So the key is not a setting. Anything optional gets deferred and a deferral has no
deadline:

1. **First run shows the ceremony instead of the dashboard.** No close control, no
   "later", no nav rail, no route around it. Verified in the running app: on login the
   manager gets the ceremony, with zero links and two buttons.
2. **Confirmation is re-entry, not a checkbox.** "I wrote it down" is a claim; typing 44
   characters back is evidence. Compared in constant time, and a mismatch says only that
   it did not match — anything more precise makes the box an oracle.
3. **Backups refuse to run until confirmed.** `assertBackupsEnabled` gates `runBackup`
   and `verifyRestore`, answering 409 `BACKUP_BLOCKED`. Producing an archive nobody can
   open and reporting success is the deception this exists to prevent.
4. **The confirmation is an audit row naming who and when**, so "who has the key" is
   answerable years later.

**The confirmation is bound to the key's fingerprint, and that is the load-bearing
detail.** `entityId` on the audit row is the fingerprint, not a constant, so "confirmed"
belongs to one specific key. Replace the key — a migration, a restore onto new hardware,
a well-meaning edit of `walaa.env` — and the new fingerprint has no confirming row, so
the ceremony reopens and backups stop. A boolean flag would have gone on vouching for a
key nobody had ever written down.

**A first run and a replaced key are treated differently**, and the distinction is
`everConfirmed`. First run is a wall. A replaced key raises a standing, undismissible
banner instead: the manager has done this before, is probably mid-migration, and locking
them out of the whole dashboard at that moment would be a hazard of its own. Both states
verified live.

**Generation writes `BACKUP_KEY` into `walaa.env` and never replaces an existing value.**
Two guards, because one silent overwrite orphans every archive a shop has ever taken:
`ensureKeyGenerated` returns early if a key exists, and `setEnvValue` refuses a non-empty
value without an explicit `overwrite`. Rotation is deliberately not implemented — it is a
different act needing different warnings.

The write is temp-then-rename **in the data directory**, which is safe for a specific
reason worth recording: the installer runs `icacls /inheritance:r` on
`%PROGRAMDATA%\Walaa` granting `(OI)(CI)(F)` to LocalSystem and Administrators, so a file
created there inherits exactly those and the default `BUILTIN\Users:(RX)` cannot
propagate. A temp file in `%TEMP%` would have been created under a different ACL and
moved across volumes non-atomically.

**The key never reaches a log, an error, or Drive metadata.** Audit rows carry
fingerprints. `req.body.key` is in the Pino redaction list. Verified against the live
API: after a full ceremony and two backups, the key does not appear anywhere in the
captured server output.

#### Corrected 2026-08-31, after the first operator use

**The gate locked out every role that could not complete it.** It walled all dashboard
roles, but generating and revealing the key are OWNER-only — so a MANAGER logging in
first met a wall with no means past it: could not reveal the key, therefore could not
type it back, therefore could not reach the dashboard, on that login or any later one.
Logout was the only exit and the wall was waiting again.

The fix draws the client wall along the same line as the server's permissions. **Only the
OWNER is walled.** A manager gets the dashboard with the standing banner, worded for
someone who cannot act — "the owner does this step" — and with no action button offering
them something they would be refused. Nothing is deferred: backups still refuse to run,
and the person who *can* act still meets the wall. Walling somebody who cannot perform
the action protects nothing and only makes the product unusable while the owner is away.

`generate` moved to OWNER-only alongside `reveal`, so a manager cannot mint a key nobody
has ever seen. `confirm` stays open to any dashboard role — whoever holds the printed key
can complete the ceremony, which is the point of printing it. Pinned by
`backup-roles.test.ts`, because a single `DASHBOARD_ROLES` is exactly what a later tidy-up
would restore.

**The fingerprint read as the key.** Sixteen monospace hex characters sat directly above
a button saying "reveal the key", with the clarifying caption underneath in small grey
text. The first operator to see the screen reported the key was already visible. Nothing
was exposed — the fingerprint is a hash of 256 random bits and the key is 44 base64
characters still behind the button — but on this screen, of all screens, being misread as
leaking the secret is its own failure. The denial is now in the label itself
("بصمة المفتاح — ليست المفتاح"), the explanation comes *before* the value, and the value
is styled as an identifier rather than a secret.

The general lesson is §12.20's, one layer up: a screen is not verified until someone who
did not build it has looked at it. Both of these survived a full live walkthrough by the
author.

#### Two bugs the live run caught that no test would have

**Backups failed with a generic 500 when the directory was unwritable.** Unelevated, the
default backup directory is under `%PROGRAMDATA%\Walaa`, which the installer locks — so
`mkdir` returned EPERM and the manager was told "حدث خطأ غير متوقع". The packaged service
runs as LocalSystem and never hits it, but a misconfigured `BACKUP_LOCAL_DIR`, an absent
USB path and a full disk all land there too. Now a 507 naming the directory.

**A body-less POST answered 400.** Both web clients declared `content-type:
application/json` on every request; Fastify parses by content-type, so a POST with no
body handed the parser an empty string and it rejected a well-formed request. `POST
/backup/key/reveal` takes no body, so the ceremony broke while every `curl` to the same
endpoint worked — curl sends no content-type without `-d`. Fixed in the manager client
where it bit, and in the Station client where it had not yet.

### 12.20 Testing gap: an endpoint is not exercised until a real client calls it — 2026-08-30
*(recorded at the operator's instruction, after the key ceremony)*

The backup key endpoints were tested two ways and both passed: a vitest suite against
the service functions, and `curl` against the running API. The ceremony then failed on
first use in the manager app.

`POST /backup/key/reveal` takes no body. Both web clients set
`content-type: application/json` on **every** request, so the browser sent that header
with an empty body; Fastify parses a request by its content-type, handed the parser an
empty string, and answered **400 on a perfectly well-formed request**. `curl` without
`-d` sends no content-type at all, so it never reproduced it — the test that was supposed
to be the realistic one was the one with the unrealistic client.

**The pattern, stated generally: a test client that constructs requests differently from
the real client is not testing the endpoint, it is testing a similar endpoint.** Header
defaults, serialisation, empty bodies, and error parsing are all places the two can
diverge, and every one of them fails in production and passes in the test.

So, for anything a browser calls:

1. **Exercise it through the real client at least once** — the app running, the actual
   `api.post` involved. `curl` and service-level tests stay useful for breadth; they do
   not close this class.
2. Be suspicious of any endpoint that works in `curl` and fails in the app. The
   difference is almost always in what the client added, not in what the server did.
3. The same reasoning applies past HTTP. §12.14's CP864 finding is the same shape: a
   codepage that decoded to mojibake and scored well against a check written for the
   convenient case.

This is also why V3-3 onwards runs the browser against a live API rather than trusting a
green suite: three of the four bugs found in the last two phases — the CORS origin, the
unwritable backup directory answering a generic 500, and this one — were invisible to
every test that did not involve a real client.

### 12.21 Scheduled backups, and the shape of a scheduler that can be trusted — 2026-08-30

§7.3 asks for "daily after close + every 500 transactions". Four properties decided the
implementation, and each answers a failure this project has already met in another guise.

**A missed run happens late; it does not disappear.** *(operator requirement.)* A till
switched off overnight is normal, and a scheduler built as a timer would back up nothing
at all for a shop that closes before its own backup time — silently, for months. So
nothing here fires on a timer. Every tick asks a question about *state*: is the most
recent daily slot still uncovered? A machine started at nine in the morning finds last
night's slot uncovered and backs up immediately. Verified live: history cleared, service
restarted, and a backup appeared 30 seconds later with `reason: DAILY` and no human
involved.

**Dueness is measured from the last SUCCESS; backoff from the last ATTEMPT.** That pairing
is what retries a failure without hammering it. Measuring both from attempts would mark a
failed run as covering the slot; both from successes would re-run a full-disk failure
every five minutes, each time doing a `VACUUM INTO` on a volume with no room for it.

**It lives in the service process, not in `buildApp`.** Two reasons, and the second is
the one that bites: the manager app is a window somebody closes, whereas the Windows
Service survives a closed window and a logout (§12.3) — and `buildApp` is what the test
suite constructs, so a scheduler started there would take real backups of the test
database on every run.

**It cannot collide with a manual run.** Both go through one in-process mutex in
`backup.service`. Two backups share a staging directory, a snapshot filename and a
`VACUUM INTO` destination, so the second would delete the first's snapshot out from under
it. The scheduler *yields* rather than queues — a queued run behind a manual one would be
a second backup of the same minute — and `verifyRestore` holds the lock across its whole
round trip, because the archive it restores must be the one it just took. In-process is
sufficient for one Windows Service and stops being sufficient the moment there are two,
the same caveat as the rate limiter.

**Every outcome is recorded, including the ones where nothing happened.** Success,
failure, refusal for want of disk, and skip-because-one-was-running all write an audit
row, and the Backup screen reads them. The failure shape this product keeps meeting is
the quiet one — the agent capturing nothing while reporting healthy (§12.15), archives
nobody can open (§12.19) — and every one of them was invisible because absence and
"working fine" looked identical. A gap on that screen is now a fact with a date, not an
inference.

**History comes from `audit_log`, not a second table**, which would be one more thing to
keep in step with the trail and would eventually disagree with it about whether last
Tuesday's backup happened.

**The first-run gate has a logout.** *(operator ruling.)* Undismissible means it cannot be
bypassed *into the dashboard*, not that the session cannot be left. Leaving force-quit as
the only exit teaches a manager that killing the process is how you get out of our
screens, and that habit costs more later than the button does now. Logging out confirms
nothing; the gate is waiting at the next login.

### 12.22 The free-space warning, and the two bugs a real client found — 2026-08-31

§12.15 fixed the thresholds (OK ≥ 5 GB, WARN < 5 GB, CRITICAL < 2 GB, re-arming about
20% above each edge) and left the runtime reporting to be built. This is that: a sampler
in the service, an authenticated endpoint, a push on the existing realtime channel, and
a standing banner in the manager shell.

**The warning goes where the manager already looks.** §12.15's failure is quiet and its
symptom lies — SQLite refuses writes cleanly and goes on serving reads, so the dashboard
renders every number correctly while each scan at the till errors. §12.16 makes that
visible at the moment it happens; this makes it visible while clearing a few gigabytes is
still a five-minute job. The copy names the consequence rather than the condition: "low
disk space" is a message every Windows user has learned to close, and "sales will stop
being recorded" is one a shop owner acts on.

**Not on `/health`.** `/health` is public by necessity — a probe carries no token — and
free space on the machine holding every sale this business has recorded is not owed to an
unauthenticated caller on the shop wifi. `GET /api/v1/system/storage` is dashboard-roles
only. The Station has no action to take on a low disk and §12.16 already faults its writes
when storage actually fails; the push still reaches it, because warning the till *before*
its next scan fails is a plausible future and the event already being there makes that a
UI change with no API change.

**Worsening is immediate; recovery has to clear the re-arm bar.** The hysteresis is
asymmetric on purpose. A disk that has just fallen below 2 GB is CRITICAL on that sample,
not two samples later — a late alarm costs the outage, an alarm that lingers costs a
banner nobody minds. Recovery climbs the ladder one rung at a time, so freeing 20 GB
clears the banner in one sample while creeping over 2 GB does not.

**A volume that cannot be measured is UNKNOWN, never OK**, and **UNKNOWN → OK is not
news.** The first is the same bug as an agent reporting healthy while capturing nothing.
The second is what keeps the audit trail readable: without it every service restart would
write a "storage level changed" row, and a trail that fills with boot noise stops being
read. UNKNOWN → WARN and UNKNOWN → CRITICAL still announce, so a machine that boots
already in trouble says so on its first pass.

**Confirmed by the operator, 2026-08-31.** Both halves stand: worsening immediately,
recovery only past the re-arm bar, and UNKNOWN → OK staying silent. The audit trail
exists to be read, and boot noise is what makes people stop reading it.

**One classifier, two delivery paths, and they need each other.** The server classifies;
no client re-derives a level from `freeBytes`, or the two would disagree at exactly the
boundary where disagreement is most confusing. Events fire on change only — a per-minute
broadcast is a heartbeat nobody reads — and the endpoint answers for the present, because
a dashboard opened after a transition would otherwise never learn of it.

**The 2 GB floor is now one constant.** `backup/snapshot.ts` imports `CRITICAL_FREE_BYTES`
rather than restating it. The number that raises the banner and the number that refuses a
backup have to be the same number, or the banner warns about a limit that is not the
limit. `liveDatabasePath` moved to `config/paths.ts` to keep that import acyclic, which is
also where a path resolver belonged.

**Two bugs, both found by driving the real client, neither visible in the code review that
preceded it.** §12.20's rule earned its keep again.

- **An orphaned WebSocket per remount.** Resolving the server address is asynchronous —
  it lives in the Tauri store — so there is a gap between deciding to connect and holding
  a socket, and a stop landing in that gap has nothing to close. React StrictMode's
  mount/unmount/mount showed it immediately: the API log had *two* `/realtime` upgrades
  for one dashboard. The first connection completed after its own stop had run, assigned
  itself to `socket`, and was overwritten by the second — leaving an authenticated socket
  open with nothing referencing it, delivering every event twice. Fixed with a generation
  counter bumped on every start and stop, so a connection that finishes after its run has
  ended closes itself. One upgrade per dashboard, verified in the log.
- **The banner never re-synced after a dropped socket.** Transitions are announced once,
  so anything that changed while the connection was down — the service restarting is the
  ordinary case — was simply missed, and the banner would hold a stale verdict until the
  query went stale *and* something refocused the window. On a dashboard left open on a
  back-office monitor that could be days. A reconnect now re-reads, which is the mirror
  image of the Station flushing its queue on the same signal.

Verified live against the manager app with the API restarting underneath it: CRITICAL
(red) → WARN (amber) → cleared, each transition arriving without a page reload.

*Not reproduced: a genuinely full NTFS volume. The state machine is driven through an
injected reader, and one test measures the real volume so `monitoredPath` cannot silently
resolve to something `statfs` will not answer for.*

### 12.23 Security and performance pass over V3-2…V3-6 — 2026-08-31

A review of everything added since V3-1 against v1 §7 and §8: agent ingestion, the
Station endpoints, backup and its key ceremony, the scheduler, and the realtime channel.
Seven defects, and the pattern among them is worth more than the list: **not one was a
missing control. Every one was a control that had stopped matching the system around
it.**

#### The pattern, and the trigger it names

The findings below are the evidence; this is the part that generalises, and §0 rule 9
now carries it. Nothing in a line-by-line reading of the CSP line, the route definitions,
or the WebSocket handshake was wrong — each was still exactly what its author wrote, and
each would pass review again today. What changed was around them.

**The trigger: whenever a change alters what the service SERVES, what ROLES exist, or
what a mitigation ASSUMES, the controls that depended on the old shape must be
re-checked.**

- **SERVES** — §12.3 made this process serve the Station's HTML and JavaScript on the same
  port. The content security policy had been switched off with a comment saying the
  service returns only JSON, which was true on the day it was written.
- **ROLES** — six routes named no roles, which means every role, which was harmless while
  every role was a dashboard role. This same pass added a fourth, `AGENT`, and the set the
  routes were implicitly trusting silently grew.
- **ASSUMES** — the cleanest of the three. §12.9 accepted a token in the query string,
  because a browser cannot set a header on an upgrade, and mitigated it with a short TTL.
  The mitigation was sound and remained sound; it simply stopped applying once Fastify's
  request logging put that token into a world-readable file. Fifteen minutes is a real
  defence against an attacker who must catch the token in flight, and no defence at all
  against one who can read a file at leisure.

Each of these is invisible to review of the diff that caused it, because **the change that
breaks the control does not touch the control**. The re-check therefore has to be triggered
by the *kind* of change, which is why it is a rule in §0 rather than something to notice.

#### Security

**A live access token was being written to the log in cleartext.** The WebSocket
handshake carries its token as a query parameter, because a browser cannot set a header
on an upgrade — a tradeoff §12.9 documented and mitigated with a short TTL. The
mitigation addressed the wrong risk. Fastify logs `req.url`, so every reconnect wrote a
bearer token into `api.log`, on the same volume as the database, readable by anyone who
can read the data directory — a wider set than the people who may hold a session.
Fifteen minutes of validity is not "safe"; it is fifteen minutes during which reading a
file is enough. A serializer now redacts the parameter and keeps the rest of the URL,
which a support call still needs. Found by reading the service's own log during the
free-space work, not by reviewing the code that wrote it.

**The content security policy was switched off with a comment saying this service
returns only JSON.** True when written; false since §12.3 made this process serve the
Station's HTML and JavaScript on the same port. A policy is now set, and
`upgrade-insecure-requests` is explicitly *removed* rather than left to helmet's default
— §7.1 makes LAN traffic deliberately plain HTTP, so the default would have every tablet
rewrite its requests to `https://` against a service that does not answer there. A
hardening header taking the Station off the air is a real way to lose a shop's morning.

**Six routes were authenticated but named no roles**, which means every role. That was
harmless while "any role" and "the Station's roles" were the same set — and this same
pass added a fourth role. Every route now names its roles; `/auth/me` and
`/auth/logout-all` are the two documented exceptions, because reading back who you are
and dropping your own sessions belong to every caller. `rbac-matrix.test.ts` pins the
whole table, and pins the route inventory too, so a route added later cannot slip past
the matrix without failing a test.

**The Print Capture Agent now has its own role.** Its password sits in cleartext in
`agent-settings.json` on the cashier PC — the machine a shop's staff use all day and the
one running three of four capture modes inside the print path. Until now the only account
it could use was a Station login, so that file carried the ability to register customers,
redeem vouchers, search customers by name and read card numbers. `AGENT` can post a
capture and nothing else; the agent's client calls exactly two endpoints, so the
narrowing costs it nothing. `INGEST_ROLES` keeps OWNER, because §12.15 accepts losing a
capture on a full disk on the grounds that the invoice reaches the log and the paper
receipt is in the cashier's hand — which only helps if somebody may re-enter it.

**The manager app's login was a deny-list.** It refused `role === 'STATION'`, so the new
role would have been let in to meet a wall of 403s with no explanation. It is an
allow-list now, matching the Station's own login and the rule the API states on every
route. It also stopped duplicating the `Role` union and imports it, which is why the two
drifted.

**A query parameter could produce a 500.** `/vouchers/reconciliation?date=` accepted any
string and handed `new Date(...)` to Prisma; a typo produced an Invalid Date, an
unserialisable filter and a 500 that reads as a server fault and invites a retry. §7.4
says Zod on every boundary, and a `z.string()` that validates nothing satisfies the
letter of that and none of the point.

#### Correctness, found while reviewing settlement

**End-of-day reconciliation bucketed by the UTC day.** In Baghdad (UTC+3) a voucher
issued before 03:00 local was filed under the previous day — §13.1's error, in the one
place §13.1 had not been applied. It survived because the shop is shut at that hour,
which is a fact about opening times rather than about the code, and stops holding for a
merchant who trades late or sits in another zone. A reconciliation report that disagrees
with the drawer by one day of vouchers is worse than no report: it sends somebody looking
for a theft that did not happen. `localDayBounds` in `shared-types/period.ts` now owns
the arithmetic, and takes a local date key as well as an instant — a caller handed a
calendar date has no instant to convert, and every hour it might invent is wrong in some
timezone.

#### Performance

**`audit_log` had no index on `action`, and three hot reads filter by it.** The Backup
screen's history, the scheduler's dueness check every five minutes, and `keyStatus` —
which the dashboard calls on every window focus. All three walked the merchant's entire
trail. The shape of that is the point: the scan grows with the gap since the last
successful backup, so **the query degrades in exact proportion to how long backups have
been broken** — slowest precisely when someone is looking at the screen that exists to
tell them so. Fixed with `@@index([merchantId, action, createdAt])`, and `keyStatus`'s
`count` became an existence check, since the question is settled by the first row.

**Money aggregates above Int32 were checked rather than assumed.** §13.5 permits `Int`
for per-row money and warns that aggregates are not bounded. The report path was tested
against a customer summing to 3,000,000,000 IQD and returns it correctly — the JavaScript
reduce and the SQL `groupBy` both. Recorded so the next person does not have to re-derive
it.

**Rate-limit buckets are per authenticated user, not per address** — verified, not
assumed. The registration order of the limiter and the auth hook made it look as though
`request.auth` could not be set in time; it is, because @fastify/rate-limit attaches per
route and route hooks run after instance hooks. Now pinned by a test, because the
failure mode is silent and expensive: one client recovering from an outage throttling the
till mid-sale.

#### Recorded, not fixed

- **`getOverview` loads every transaction in the range** and reduces in JavaScript,
  because the timeseries buckets by the merchant's local day and SQLite cannot do that
  without hardcoding an offset. At 30 days that is a few thousand rows; at 365 it is
  closer to 180,000. Acceptable at one supermarket's volume and worth revisiting before
  it is not.
- **There is still no way to create a user in the field.** The seed makes them, and the
  installer does not. Adding `AGENT` sharpens a gap that already existed for every other
  role, and provisioning has to be solved before an installation can be handed over.

### 12.24 The Expo app is gone, and the hoist hazard it was hiding — 2026-08-31

§1's last migration step: `apps/_deprecated_assistant` is deleted. The gate it was held
behind is met — the Loyalty Station builds, is served by the API on the manager machine's
own port, answers on a tablet, and has its own suite. The unused
`@walaa/config/tsconfig/react-native` preset went with it, along with two stale `.gitignore`
entries pointing at a directory that had already been renamed.

**Deleting it broke the Station's build, and the reason is worth keeping.** pnpm hoists
every package into `node_modules/.pnpm/node_modules/`, one version per name, and
TypeScript finds what it lands there while walking up from a *dependency's* own directory.
This workspace holds React 18 (Station, manager desktop) and React 19 (the Next
dashboard). The Expo app's `@types/react@18` had been winning that hoist, and so it was
deciding which `React.ReactNode` `lucide-react` and `react-router-dom` were typed against
— for every app, regardless of what each app declared. Removing an app nothing else
depends on handed the hoist to React 19 and produced `TS2786: 'Route' cannot be used as a
JSX component` in a package that had not been touched.

`.npmrc` said "Hoist nothing implicitly — workspace packages must declare their own deps",
which was an intention rather than a setting: `hoist-pattern` was left at its default of
`*`. It now excludes `@types/*`, so each app sees the types it actually declares.

**The two `hoist-pattern` lines are one setting, and collapsing them restores the bug.**
`hoist-pattern[]=*` followed by `hoist-pattern[]=!@types/*` reads like a contradiction and
is not: the first restores pnpm's default, the second carves `@types/*` back out of it.
Deleting the negation as redundant — or tidying the pair down to the single line that
"means the same thing" — reinstates exactly the condition above. It will not fail at the
point of the edit. It fails later, in whichever app loses the hoist race after the next
unrelated dependency change, with a `TS2786` in a file nobody touched. `.npmrc` carries
the reasoning in its own comment block, in front of whoever is holding the file; this
paragraph is the copy that survives a rewrite of that file.

The failure is the interesting part. A dependency deleted in one package silently
retyped another, the error named a file nobody had edited, and nothing in the message
pointed at a lockfile. Changing the hoist pattern requires a full reinstall, which also
clears the generated Prisma client — `pnpm --filter @walaa/api db:generate` afterwards, or
every test fails with "did not initialize yet".

The shape is §0 rule 9 one layer down, in the build inputs rather than the controls:
nothing declared the dependency, so nothing flagged its removal, and what changed was
around the code that broke.

React 18 and 19 still coexist, so §13.7's `declaration: false` workaround remains
load-bearing and stays.

#### Addendum, 2026-08-31: the fix was verified on one app, and it broke another

Excluding `@types/*` from the hoist fixed the Station and left the manager desktop
failing to compile — `TS2786: 'XAxis' cannot be used as a JSX component`, and the same for
every recharts element and for `react-router-dom`'s `NavLink` render prop. It was found
while building §12.25, on `main`, with nothing of §12.25's applied: **the previous session
verified the hoist change against the app that had broken and not against the ones that
had not.**

The mechanism is the mirror image of the original bug. An app resolves `@types/react`
from its own `node_modules`, which is why the apps were fixed. A **package that ships its
own `.d.ts`** does not: recharts' types say `import * as React from 'react'`, and
TypeScript resolves that by walking up from recharts' own directory inside the pnpm store.
With `@types/*` no longer hoisted there is no `@types/react` anywhere on that path, so
`React.ReactNode` resolved to nothing at all. Before the change there was exactly one —
the Expo app's React 18 — which is the bug §12.24 exists to describe. Both states are
wrong; they are wrong in opposite directions.

The fix is neither hoist pattern. `pnpm-workspace.yaml` now declares `@types/react` as a
peer dependency of `recharts` and `react-router-dom` through `packageExtensions`, so pnpm
links **the right one into each instance**: the React 18 types beside the React 18
recharts, the React 19 types beside the React 19 one. Both copies genuinely exist in this
workspace and both are now correct, which no single hoisted version could be.

**Restoring `hoist-pattern[]=*` would also silence it**, and would put back the original
bug. If a third-party package's types stop resolving, add it to `packageExtensions` — do
not touch `.npmrc`.

The general shape is §0 rule 9 once more, and it is worth naming because this is the
second time in two sessions: **a fix verified only where the symptom appeared is a fix
verified nowhere else.** The change altered what every package could see; the re-check
owed was every package, not the one that had complained.

### 12.25 Pre-printed physical cards — 2026-08-31
*(merchant requirement, relayed by the operator. **The requirement is settled; the design
below is proposed and awaiting confirmation** — the operator asked to see the barcode
format, the schema, and the two enforcement mechanisms before any code is written.)*

The merchant will hand out durable pre-printed cards — ivory or PVC — carrying a serial he
orders in batches, instead of a thermal card printed at the moment of registration.
Registration changes from *generate a number and print it* to *assign a card that already
exists*. This supersedes §6.2 #4 as the **primary** path. §6.2 #5 (a reprint returns the
same number) is unchanged, and §6.3's thermal printing survives in full as the fallback — a
customer must never be turned away because the stock drawer is empty.

**The rule the whole design hangs on: the customer record is the identity, the card is only
a credential.** Balance and history belong to the customer and follow them across any number
of cards. Any design in which history lives on the card is wrong, and the schema below is
shaped to make that arrangement unrepresentable rather than merely discouraged.

#### The barcode value — no geometry change at all

Sixteen digits, Code 128C, exactly as §12.12 froze it. Only the **meaning** of the digits
changes, and only for pre-printed cards:

```
  card.v2  (pre-printed)     000042 1739205846
                             └────┘ └────────┘
                             serial   HMAC check
                             6 digits  10 digits

  card.v1  (thermal, unchanged)  4821009377 461152
                                 └────────┘ └────┘
                                  random     truncated HMAC
```

| | |
|---|---|
| Digits | 16 — unchanged |
| Code 128C data characters | 8 — unchanged |
| **Modules** | **143**, including both 10-module quiet zones — unchanged |
| Width at 0.33 mm | 47.19 mm — unchanged; 58 mm paper keeps about 10.8 mm of margin |

Keeping the total at sixteen is the point. The module-width dial stays untouched, the
`design/receipts/` fixtures stay valid, the Station's *submit on sixteen digits* rule
(§12.13) still self-terminates a scan, and the 4-4-4-4 grouping a customer reads down a
phone line still works. Leading zeros cost nothing: Code 128C encodes `00` as one character
like any other pair, and `normalizeCardNumber` has always carried the value as a string.

**The check code now carries all of the security, which is why it takes ten digits and not
six.** §12.12's six-digit signature was one of *two* barriers — a forger also had to land on
one of a few thousand live values inside a 10^10 random space. A serial is public by design:
it is printed large on the card so the merchant can order, count and support by it, so
anyone holding one card knows a valid serial and can read off its neighbours. That second
barrier is gone, so the signature has to absorb it. Ten digits give one guess in 10^10,
which against the 120/min rate limit on the resolve path is roughly **79 years of continuous
attack** for a single expected forgery — and that attack needs a station credential on the
shop LAN before it can begin.

Stated honestly: this is weaker *in the abstract* than v1's two barriers multiplied
together, and far stronger than either barrier alone. The trade buys a number that
identifies its own serial and batch, so a support call can cross-check the printed serial
against the scanned digits, and a mis-keyed digit is caught rather than silently resolving
to a different customer.

**What the check code does not fix.** A card someone finds on the floor is a genuine card,
and no cryptography changes that. The answer to a lost card is the `LOST` state below and
how quickly it is reported; the exposure is one basket's discount plus sight of a balance,
bounded by a phone call. The HMAC exists to stop a forged card being *manufactured* from a
serial, which is the attack a bare sequential number would have opened.

**Two schemes coexist and both stay valid.** `card.v1` (random payload) keeps minting for
every thermally printed card, unchanged; `card.v2` is only for pre-printed stock.
Verification tries both — two in-memory HMACs — and the `card` row is the authority on
identity either way. Nothing already in a customer's wallet stops working.

**Consequence for the secret, and it is sharper than before.** The check code derives from
`QR_TOKEN_SECRET` through a domain-separated subkey. §12.11 already forbids regenerating
that secret on a machine whose cards are printed; with pre-printed stock the same mistake
also destroys **blank cards sitting in a drawer that no customer has ever touched**. The
prohibition is now about physical inventory, not only about issued cards.

**The batch export file is the sensitive artefact of this whole feature.** It has to contain
every card number in the range or the card printer cannot print the barcodes — which means
the printing vendor necessarily learns every number in the batch. Two things make that
survivable: an unassigned card is worth nothing until somebody physically hands it over at a
station, and a leaked batch can be voided wholesale. Both belong in the setup guide, along
with deleting the file once printing is done. Generation and export are audited.

#### Card lifecycle

The states are the merchant's, unchanged in name: `PRINTED` · `ASSIGNED` · `LOST` ·
`REPLACED` · `VOID`. Legal transitions, and nothing else:

```
  PRINTED ──assign──► ASSIGNED ──reported lost──► LOST ──replacement──► REPLACED
     │                    └────────replaced (damaged)──────────────────► REPLACED
     └──void (misprint)─► VOID
```

`PRINTED` and `VOID` have no owner; `ASSIGNED`, `LOST` and `REPLACED` all keep the customer
id, because who held a dead card is exactly what a support call asks about. Nothing returns
to `PRINTED`, and nothing leaves `VOID` or `REPLACED`.

Every non-`ASSIGNED` state is refused at the scan with **its own message**, never a generic
error — a card replaced last week and a card never issued are different conversations at the
counter. The one deliberate exception: an unknown number and a failed check code answer
identically. Distinguishing them would tell an attacker their check digits were right, which
is the same oracle §12.19's constant-time comparison refuses to be.

#### Two database-level guarantees

**Assignment is one conditional UPDATE**, the shape v1 §13.9 already uses for coupon
redemption: every precondition sits in the WHERE clause —
`SET customerId=?, status='ASSIGNED' WHERE id=? AND status='PRINTED' AND customerId IS NULL`
— and the service asserts that exactly one row changed. A second attempt matches zero rows,
so an assigned card can never be reassigned and one customer's details can never land on
another's card. A read-then-write would let two stations both believe they held a blank.

Alongside it, a **partial unique index** — `UNIQUE(merchantId, customerId) WHERE status =
'ASSIGNED'` — makes "one live card per customer" a fact the database keeps rather than a
rule the code remembers. It has a useful side effect: a replacement *must* retire the old
card before the new one can be assigned, because the index refuses the intermediate state.
Prisma cannot express a partial unique index, so it lives in the migration SQL, which is
already how this project applies migrations (§12.11).

**Batch ranges cannot overlap, because a range is not a claim.** Every serial in a batch is
materialised as a `card` row under `UNIQUE(merchantId, serial)`, so a second batch covering
the same numbers fails on insert — not on a validation that code might skip. Generation runs
in one transaction that reads `MAX(serial)`, allocates `[max+1, max+quantity]`, and writes
the card rows and the batch row together. **The merchant chooses the quantity and never the
starting serial**, which removes the collision he is worried about instead of warning him
about it. Serial is `NULL` for thermal cards: they have no physical inventory to track, and
letting them consume serials would corrupt the "how many blanks are left" count that the
batch screen exists to answer.

#### Open — needs an answer before build

- **May a `LOST` card be restored to `ASSIGNED`?** "I found it" is a real support call. The
  partial index already makes the dangerous version impossible — a customer who has been
  issued a replacement cannot hold a second live card — so allowing it is safe wherever it
  is possible at all. Proposed: allow, audited. Not implemented without a decision.
- **Serial capacity is 999,999** at six digits, with a hard refusal rather than a rollover.
  Confirm that ceiling is comfortable.

#### Answered, and built — 2026-08-31

*(operator answers to the two open questions above, plus what the implementation
found. The design in this section is no longer a proposal: it is what the code does.)*

**A `LOST` card may be restored, audited, with an actor and a stated reason.**
Refusing would push staff into issuing a replacement nobody needed — which costs a
physical card and retires a good one. Building it surfaced something better than the
partial index, though: replacing a card retires it to `REPLACED`, so the **state guard
answers first**, and it answers with the reason that is actually true for the person at
the counter — *this card was replaced* — rather than the index's blunter *you already
hold a live card*. The index stays as the backstop for any later path that leaves a card
`LOST` while its holder acquires another. Nothing reaches it today, which is the correct
order of defences rather than a redundancy, and the test says so in as many words.

**999,999 is the ceiling, with a hard refusal and no rollover.** Enforced in three
places on purpose: `mintPrePrintedCardNumber` throws, `generateCardBatch` refuses with a
message naming the ceiling, and a CHECK constraint on `card_batch` makes a row past it
unwritable. A refusal stops the line and produces a phone call; a rollover silently
re-issues a serial that is already in somebody's wallet, and the first anyone would know
is two people holding one number.

**The `QR_TOKEN_SECRET` warning now lives where the person who could do it is looking.**
It is on the key-ceremony screen itself — not only in §12.11 and not only in a manual —
because the screen is where a manager thinks about server keys. Wording:
*«لا تُعِد توليد مفاتيح الخادم بعد طباعة بطاقات الولاء. تغييرها يُبطل كل البطاقات
المطبوعة — بما فيها البطاقات الجاهزة في الدرج التي لم تُسلَّم لأي زبون بعد.»* The
handover doc repeats it.

**"Void the entire batch" is a single action on the batch screen.** The remedy for a
leaked export file only counts if somebody will actually perform it, and a merchant told
to void a thousand cards one at a time will not. It touches `PRINTED` stock only: a card
already in a customer's hand is not collateral for a spill of numbers, and taking it away
would punish them for it.

#### Two defects the build surfaced, neither in the card code

**The card number printed backwards on every screen that showed it.** Under the RTL page
direction the bidi algorithm lays the four groups out right-to-left, so
`0000 0122 6577 3350` rendered as `3350 6577 0122 0000`. It had been wrong since §12.12
and no test could see it — the string is correct, the DOM is correct, and only the pixels
lie. The whole justification for a sixteen-digit number over the v1 token was that a
customer could **read it down a phone line** (§12.12), so this quietly removed the reason
the format exists. Every card-number display now carries `dir="ltr"`, and the comment at
each site says why so a later tidy-up does not strip it as noise.

Found by looking at the screen after registering a customer, which is §12.19's lesson
arriving again: *a screen is not verified until someone looks at it.*

**The manager app was carrying its own copy of the customer DTO.** Renaming
`barcodeToken` → `cardNumber` in `shared-types` did not break `Customers.tsx`, because
the local `interface CustomerDto` went on describing a shape the server had stopped
sending. Exactly the drift §12.23 found in the manager's login, where a copied `Role`
union quietly disagreed with the API about which roles exist. **A duplicated type does
not fail loudly; it fails by staying plausible.** It imports `Customer` from
`@walaa/shared-types` now, as CLAUDE.md §9 required all along.

#### What is verified, and what is not

Verified against the running service and both real clients: a batch of five generated
(range `000001 — 000005`, start computed, not chosen); the export produced with all five
numbers and a manifest carrying none of them; a blank card scanned at the Station showing
*«بطاقة جديدة غير مُسلَّمة — بطاقة رقم 000001»* and carrying that card into registration;
the customer registered onto it with no print dialog and *«سلّم البطاقة للزبون»*; the
card reported lost and re-scanned as `CARD_REJECTED / LOST`; replaced with `000002`,
after which `000001` scans as `CARD_REJECTED / REPLACED` naming its successor and the new
card resolves to the same customer with their history intact; and the manager's batch
screen reporting `جاهزة: 3 · مُسلَّمة: 1 · مستبدَلة: 1` with the next serial at `000006`.

386 tests pass (317 API, 69 shared-types), typecheck and lint clean across all six
packages.

**Not verified, and it cannot be from here:** a real card printed by a real vendor on
real PVC, read by a real scanner. The 0.33 mm module is decided by their printer, ink and
card surface. That is the checklist item, not a code item.

### 12.26 The Stitch exports, and what they are authoritative for — 2026-08-31
*(operator ruling, after the fidelity audit. Supersedes CLAUDE.md §6's instruction to
align implementation to the exports, and retires §6.7 #1 and #2 outright.)*

The Stitch exports arrived in `stitch_wala_a_loyalty_management_dashboard/`: thirteen
screens, a `design.md`, and a machine-readable design system. The audit found that they
describe **the v1 product**. They were generated before the pivot, so six of the thirteen
are screens for things v3 deliberately stopped building — the coupon redemption flow, the
Expo assistant's four screens, and a customer detail carrying a coupon list and a
`طريقة الربط: QR / رقم الهاتف` column. CLAUDE.md §6 says to align implementation to the
exports and then apply §6.7; **followed literally, that instruction walks six screens
backwards.**

This is §0 rule 9 in the design layer. The Stitch project was the correct design source
right up until §2 changed what the product does and §12.24 deleted the app four of those
screens belong to. Nothing about the exports decayed; what they described did.

#### The ruling

**The exports are authoritative for LAYOUT and VISUAL GRAMMAR only, on the four screens
that survive** — Overview, Customers, Customer detail (structure), and the dashboard
Login. Their content model is discarded entirely.

Explicitly **not** to be regressed to match them, because matching would remove working
v3 behaviour: discount type / min / max / **absolute cap** / the live margin warning
(§2.3 — `_4` has none of them, and "fidelity" there would strip the financial
guardrails); voucher reconciliation and capture health in Reports; phone-only customer
search with the uniqueness hint (§1.4); self-hosted fonts; the absence of spinners; the
storage banner. The dashboard login stays phone/username — the export asks for an email
and there is no email anywhere in the user model.

**Where the exports disagree among themselves, the implementation wins.** The nav rail
appears in three incompatible versions — five items in `_2`, six in `_1`/`_3`/`_4`/`_5`
(including a `الفروع` that does not exist and an `الأعضاء` that renames `الزبائن`), and
seven in the app. The seven are correct. Vocabulary standardises on **الزبائن**, never
الأعضاء.

**Tokens and fonts follow §6.2 and §6.3, which §6 already settled.** Worth recording
*why* it matters here: every export ships the §6.2 tokens **and** a full Material-3
palette that contradicts them — `primary: #005440` against the mandated accent `#0F6E56`,
which appears demoted to `primary-container`, and `error: #ba1a1a` against signal-red
`#B0322E`. So the exported class names cannot be lifted verbatim even where the layout
is right. Three screens (`_4`, `_7`, `_9`) set body text in **IBM Plex Sans** — the Latin
family, not IBM Plex Sans **Arabic** — with Plus Jakarta Sans and JetBrains Mono
alongside; Arabic there renders through silent browser fallback. That is a defect in the
export, not a design decision. Icons stay `lucide-react`, which `design.md` §8 asks for
itself. Nothing from an export `<head>` ships: every one of them loads
`cdn.tailwindcss.com`, Google Fonts, and avatar images from `lh3.googleusercontent.com`,
and §12.3 is local-only.

#### §6.7 #1 and #2 are retired

**#1, the «التكاملات» screen: retired.** It asked for per-branch operating mode,
connection status and sync health, with API and DB-Agent shown as inactive placeholders.
The **Capture screen is its v3 successor** and carries exactly that — mode, agent status,
codepage, calibration. A separate Integrations screen would be a second door onto the
same room, and the placeholders it existed to show are §12.4's out-of-scope tiers.
Recorded here so nobody builds it from the v1 spec later.

**#2, the dual amount states: moot.** It asked the mobile invoice screen to render both
auto-captured and manual amount entry. In v3 the amount arrives from the print stream and
no operator screen enters it at all; §13.6's `amount: null` path is handled by the agent
and the manager's calibration flow, not by a till-side form.

**#3 (sync indicators) and #4 (the RTL pass) stand**, and #4 earned its keep this session
— see the card number rendering backwards in §12.25.

#### The v3-only surfaces have no design reference, and that is accepted

The Loyalty Station in its entirety — including **the main scan screen, the most-used
screen in the product** — plus Capture and its calibration flow, Backup, the key
ceremony, Modules, the storage banner, and the discount settings that actually enforce
§2.3, were all built directly against the §6 tokens with no Stitch screen behind them.
*(Operator ruling: no regeneration cycle now. Revisit only if the merchant objects to a
specific screen.)*

#### The four gaps where the exports were genuinely ahead — built

1. **A reporting window.** Overview and Reports both hardcoded `range=30d` while the API
   had accepted `7d | 30d | 90d | 365d` since it was written; the control was the only
   missing piece, and a manager asking about last quarter had no way to ask it. A
   segmented control rather than a date picker, because the server takes four fixed
   windows and a calendar would promise precision it does not have.
2. **The customer list.** This screen was a *lookup* — one phone in, one customer out —
   which answers "who is this?" and cannot answer "who are my customers?".
   `CustomerListQuerySchema` had existed since v1 **with no endpoint behind it**. Now
   `GET /customers` with category filter, sort, and paging, plus an audited CSV export.
   Sorting by spend cannot be an ORDER BY — cumulative spend is derived and never stored
   (§5.3) — so it ranks from one grouped query over the active period, ties broken by
   registration date so paging stays stable.
3. **Two report breakdowns**: customers by category, and how many customers reached each
   discount tier in the current period. Both count people rather than summing money, so
   §13.5's Int32 caution does not reach them — stated because the two look alike and only
   one of them would. Flat horizontal bars, not pies (§6).
4. **The applicable-rules card on customer detail.** The export has a *per-customer
   override* card here, and **v3 removed `customer_override_rule`** along with the coupon
   model it belonged to. Rebuilding it would reopen a path around §2.3's minimum, maximum
   and absolute cap — all three only bound a discount if there is a single ladder for them
   to bound. So the card shows the live ladder with the customer's current tier
   highlighted and says plainly that the shop's rules apply to everybody, which answers
   the manager who remembers the old screen instead of leaving them hunting for a button.
   **If per-customer overrides are ever wanted back, that is a discount-model decision,
   not a design-fidelity one.**

#### A defect the gap work surfaced

**Two bare adjacent numbers read as one.** The category breakdown rendered a count and a
share side by side — `9` and `75٪` — and the pair displayed as `975٪`. Found by looking
at the panel, not by any test: the DOM was correct and only the reading was wrong. The
count carries its unit now (`9 زبون`) and the share is set apart. On a panel that is
nothing but numbers, adjacency is ambiguity.

### 12.27 Two rules the card work earned — 2026-08-31
*(operator ruling. Both come out of defects found while building §12.25, and both
are about failures that a passing test suite cannot see.)*

#### Format-for-humans is verifiable only by looking

**The class.** Any value that is formatted *so a person can read it* — grouped,
spaced, padded, mirrored, wrapped, aligned — is correct only on the screen. The
string can be right, the DOM can be right, every unit test can pass, and the
rendering can still be wrong. **A unit test cannot check a format whose whole
purpose is legibility, because it is not comparing what the reader sees.**

The instance that named it: the sixteen-digit card number rendered backwards on
every screen that showed it. `formatCardNumber` returned `0000 0122 6577 3350`
correctly and a test asserted so; under the RTL page direction the bidi algorithm
laid the four groups out right-to-left and the reader saw `3350 6577 0122 0000`.
It had been wrong since §12.12 and **it silently removed the only reason the
sixteen-digit format exists** — §12.12 chose it over the v1 token specifically so a
customer could read the number down a phone line. The format survived; the reason
for it did not.

**So, the rule.** Anything formatted for a human to read gets a **rendered check**
before it is called done — a screenshot, or a DOM read of the text as displayed —
not only a unit test on the formatting function. That covers at minimum: card
numbers, phone numbers, serials, money, dates, and any number set beside another
number.

The second instance, found the same day and by the same means: the category
breakdown put a count and a share side by side, and `9` next to `75٪` displayed as
`975٪`. Two bare adjacent numbers read as one. No test could see that either — the
DOM was correct and only the reading was wrong. The count carries its unit now.

This is §12.19's lesson one layer down. That one said a screen is not verified
until somebody looks at it; this says *which* things on a screen most need looking
at, and why the test suite will not cover for you.

#### No client redeclares a server DTO

**The rule: every shape that crosses the wire is declared once, in
`packages/shared-types`, and imported by both sides.** A client may write an inline
wrapper at a call site — `api.get<{ card: CustomerCard }>` — but every *name* in it
comes from the contract package.

CLAUDE.md §9 has said this since v1. It was broken anyway, three times, and each
time it failed the same way — **silently, by staying plausible**:

- §12.23: the manager's login copied the `Role` union, so it went on refusing
  exactly the roles it was written against while the API grew a fourth.
- §12.25: the manager's customer list copied the customer DTO, so renaming
  `barcodeToken` → `cardNumber` in the contract **did not break it**. The duplicate
  described a shape the server had stopped sending.
- Found while writing this: `SessionUser` was a *subset* of the API's `AuthUser`,
  missing the `merchantName` the server has sent since the Station needed a shop
  name to print. Nothing broke, because a missing field never does.

A duplicated type does not fail at the point of duplication. It fails later, in
another commit, as a screen showing `undefined`.

**The check.** `packages/shared-types/src/__tests__/no-duplicate-dtos.test.ts`
fails the build when a client types an API call with anything it declared itself.
It reads the type argument of every `api.get/post/put/patch<…>` in the client apps
and requires each name in it to be imported from `@walaa/shared-types`. That is the
precise rule rather than a proxy: the type argument *is* the client's claim about
what the server returns, and the contract package is the only thing entitled to
make that claim. Local UI types are untouched, because they never appear there.

A second assertion guards the guard — it counts the API calls found and fails if
the count collapses, so a renamed helper cannot turn the check into a green test
that checks nothing.

Fourteen shapes moved into the contract to make it pass: the reports
(`OverviewReport`, `ProgrammeReport`, `ReportRange`), the backup and key-ceremony
shapes including `KeyStatus`, `LoginResponse`, `DiscountConfigResponse`,
`CustomerListResponse`, and `FeatureFlagKey`. The API imports them as its own
return types, so server and client cannot drift without a type error **in the same
commit**.

*Recorded honestly: writing this section, the first draft of the shared `KeyStatus`
invented a `confirmedByName` field and dropped `backupsEnabled` — a third variant,
created while removing the second. Comparing against both existing copies caught
it. The shape that decides whether a shop's backups are openable is not one to
reconstruct from memory.*

**Adding a value to a union is a known trigger for this class** *(third instance,
§12.28, 2026-09-01)*. The two above were duplicated *shapes*; this one was duplicated
*display text*, and it is the same failure with a different surface. The manager's
Reports screen named the settlement strategy with a **two-way ternary** — «قسيمة كوسيلة
دفع» if `VOUCHER_AS_PAYMENT`, else «مصروف ترويجي يومي». Correct while the union had two
members. Adding a third silently relabelled every `MERCHANT_DEFINED` reconciliation as a
promotional expense: **wrong on screen, with every test green**, because an `else` branch
cannot fail.

So the rule extends: **every place that maps a union to text a person reads comes from
one source, keyed by the union.** For settlement that is `SETTLEMENT_STRATEGY_LABELS`, a
`Readonly<Record<SettlementStrategy, string>>` in the contract package, imported by the
API for the settings response and by the manager for the reconciliation panel. A fourth
strategy is then a compile error at every place that must handle it.

Two things worth naming, because neither is obvious:

- **The `no-duplicate-dtos` check does not catch this**, and should not be extended to
  try. A ternary over a union is not a client declaring a wire shape; the type argument
  is honest. What makes this catchable is a `Record` keyed by the union — an exhaustive
  mapping, not another test. Prefer that shape over a ternary or a `switch` with a
  `default` anywhere display text is chosen from an enum.
- **`string` in a response type disarms it.** `DayReconciliation.settlementStrategy` had
  been widened to `string`, so the ternary type-checked and a `Record` lookup would have
  too. A union that reaches a client as `string` has already lost the property that would
  have caught the mislabel.

**The practical instruction:** when adding a member to any union in
`packages/shared-types`, grep for every existing member by name before finishing. Each
hit outside the contract package is a place that has to handle the new one, and the ones
that compile anyway are exactly the dangerous ones.

#### Per-customer discount overrides are DISCARDED BY DESIGN

*(operator ruling, 2026-08-31 — recorded so no future session rebuilds them as a
design-fidelity fix.)*

The v1 Stitch customer-detail screen has a per-customer override card
(«لا توجد قاعدة مخصصة — يطبَّق النظام العام», with an "add a custom rule" action),
and v1 had `customer_override_rule` behind it. **v3 removed that table along with
the coupon model it belonged to, and it is not coming back.**

They are **discarded, not missing.** The reasoning, which is the operator's:

§2.3's minimum rate, maximum rate and **absolute value cap** exist to stop a
configuration that loses money on every qualifying sale — on a 25,000 IQD basket at
2–4% net margin, a 10% discount costs the shop roughly 1,750 IQD of a ~750 IQD
profit. **All three guardrails only bind while there is one ladder for them to
bind.** A per-customer exception is not one more rule; it is a second ladder that
none of the three reaches, and it reopens every one of them at once.

What the detail screen shows instead is the live ladder with the customer's current
tier highlighted, and a line saying plainly that the shop's rules apply to
everybody. That answers the manager who remembers the v1 screen, rather than
leaving them hunting for a button — and it is a *report* of the rules rather than a
second place to set them.

If per-customer discounting is ever genuinely wanted, it is a **discount-model
decision** requiring its own guardrails, not a fidelity fix. It does not arrive by
way of a design export.

### 12.28 §9 closed, and the default became the strategy that assumes nothing — 2026-09-01
*(operator ruling. Closes §9, which had stood open since v3 began, and supersedes
§12.8's "§9 remains open".)*

The merchant settles discounts by his own accounting method and withdrew the
split-payment question about Al-Bayan. The system's responsibility ends at capturing
the invoice, calculating the discount under §2.3, recording both, and printing a slip
with gross / discount / net. **Bookkeeping is his.**

**Both existing strategies are kept, by instruction.** Nothing is removed: another
store may well want the procedure printed, and the interface that made the mechanism
pluggable is exactly what makes it a settings change rather than a rebuild.

**What was actually missing was a neutral option, so one was added.** Neither existing
instruction is neutral — each states a procedure, and states a different one:

- `VOUCHER_AS_PAYMENT` — «استلم {net} نقداً + هذه القسيمة … لا تعدّل الفاتورة» —
  presumes the POS takes a second tender on one invoice.
- `DAILY_PROMOTIONAL_EXPENSE` — «استلم {gross} كاملاً، ثم سلّم الزبون {discount} …» —
  presumes it does not, and prescribes a cash hand-back at the till.

`MERCHANT_DEFINED` is the third, and the new default: it states the discount value with
gross and net, says to apply it per the store's own procedure, and names no mechanism.

**Why a third strategy rather than rewording one of the two.** Rewording
`VOUCHER_AS_PAYMENT` to be neutral would have made its own name, its label and its
`requiresSplitPayment: true` describe something it no longer did — which is deleting it
while keeping its identifier, the opposite of the instruction to keep both. It would
also have been retroactive: §12.9 stamps the strategy on each voucher at issue time
precisely so a settings change cannot reinterpret slips already in a drawer, but
`describe()` regenerates the words on every reprint, so changing a strategy's text
changes what already-issued slips say when reprinted. A new name leaves old vouchers
reprinting exactly as they printed.

**The §9 cash-drawer rule is now structural rather than textual.** The two explicit
strategies each carry a warning that protects the cashier, and each warning only makes
sense inside its own mechanism — «لا تعدّل الفاتورة» presumes one, «لا تستلم مبلغاً
أقل» presumes the other. The neutral instruction carries neither, deliberately. The
guarantee it seems to give up was never really coming from the wording: the voucher is
written in the same database transaction as the discount, so a reduction a customer
received always has a record explaining it. **The cost is honest and worth stating** —
under `MERCHANT_DEFINED` the slip no longer tells a cashier what not to do. A store
that wants that sentence on the paper picks one of the other two.

**Existing rows keep the strategy they hold.** The migration changes a column default,
not any stored value. An upgrade must not switch a store to different wording than the
cashiers there have learned to read.

**Three drifted declarations were found on the way in**, all the §12.27 failure mode —
a shape spelled out a second time and then quietly falling behind. `DiscountConfigResponse`
redeclared the discount-type, period-type and settlement unions as string literals;
`DayReconciliation` had widened `settlementStrategy` to `string`; and the manager's
Reports screen named the strategy with a **two-way ternary** — which, with a third
strategy added, would have labelled every `MERCHANT_DEFINED` reconciliation «مصروف
ترويجي يومي» and been wrong on screen while every test stayed green. All three now
come from the enum, and the Arabic names live once in
`SETTLEMENT_STRATEGY_LABELS`, keyed by the union so a fourth strategy is a type error
rather than a mislabel.

### 12.29 A known failure signature: blank screen, empty API log — 2026-09-01
*(found running the current build locally, the day after §12.28 added an export.)*

**The symptom.** The manager app renders nothing at all — a blank white page — and
**the API log shows zero requests from it**, while the Station on the same machine is
talking to the same server normally. That combination is the diagnostic: the app is
failing before it ever reaches the network, so it is not connectivity, not the setup
screen, and not the server.

The console says what it actually is:

```
Uncaught SyntaxError: The requested module '/node_modules/.vite/deps/@walaa_shared-types.js?v=…'
does not provide an export named 'SETTLEMENT_STRATEGY_LABELS'
```

**The cause.** Both clients list `@walaa/shared-types` in `optimizeDeps.include`, so Vite
pre-bundles it into `node_modules/.vite/deps`. **That cache is keyed on the lockfile and
the config, not on a linked workspace package's source.** Adding an export to
`packages/shared-types` therefore invalidates nothing: the app imports a name the cached
bundle does not contain, and an ES module import failure kills the whole entry before
React mounts — hence a blank page rather than an error boundary.

The evidence, which is how to confirm it in ten seconds rather than reading source:

| | |
|---|---|
| cached bundle built | 31 Aug 19:34 |
| `enums.ts` last changed | 1 Sep 06:11 |
| occurrences of the new export in the cached bundle | **0** |

**Dev only.** `vite build` does not use that cache, so a production bundle was never
affected, and neither typecheck nor the test suite can see it — the TypeScript path
resolves to the source, which was correct all along.

**The fix: `vite --force` in both `dev` scripts.** It re-optimizes on every start, which
measures at ~500 ms and is nothing against a blank screen carrying no usable error.
`tauri dev` inherits it through `beforeDevCommand: "pnpm dev"`.

*(Operator ruling: `--force` rather than removing `@walaa/shared-types` from
`optimizeDeps.include`. Keeping the pre-bundle and paying the re-optimize is a known
cost; changing what gets optimized trades this symptom for an unknown one.)*

**Record the signature, not just the fix.** The next new export will do the same thing to
anyone whose cache predates it, possibly at a merchant's site rather than on a bench.
Blank screen + no requests in the API log + a `does not provide an export named …` line
now has one answer: the dep cache is stale. Clear it and restart —

```
rm -rf apps/manager-desktop/node_modules/.vite apps/station/node_modules/.vite
```

---

### 12.30 The Station's guided two-step flow, and the order it enforces — 2026-09-02
*(operator ruling: card first, then invoice. Settled, not a question.)*

The Station was one screen and one field: scan the card, and the server took the
most recent unattributed capture from the branch. It worked, and it left two things
to chance.

**The order is now enforced by the UI, not merely by habit.** Card first, invoice
second, with the step named on screen at all times. CLAUDE.md §0 rule 1 and §1.2
have said identity comes before the transaction since v1, and the reason is
concrete rather than procedural: **an invoice scanned before a customer is an
unowned pending invoice waiting for whoever scans next to claim it** — precisely the
mis-attribution the design exists to prevent. Practically the order is also the easy
one, because the card is already in the customer's hand while the invoice is still
with the cashier.

**A lookup that could commit is a lookup that eventually will.** Step 1 is a new
endpoint, `POST /scan/identify`, and it writes nothing: no attribution, no discount,
no voucher, no row. It was not folded into `/scan/card` behind a flag, because an
endpoint that sometimes commits and sometimes does not is one wrong argument away
from claiming a sale during what the operator believed was a lookup. The two acts
have different consequences and get different doors. A test asserts the invariant
directly — after an identify, the captured transaction is still unattributed and no
voucher exists.

**Step 2 names the invoice instead of guessing it.** The receipt barcode is parsed
with the §13.6 parsers and the invoice number is passed to `/scan/card`, which
already accepted an `invoiceId` and matches the capture exactly. Attribution now
lands on the invoice in the operator's hand rather than on whatever printed most
recently — the same guard, moved from "usually right" to "checked".

**The amount never comes from the receipt scan.** It comes from what the Print
Capture Agent recorded, which is what the POS recorded (§0 rule 4). The receipt
barcode's job at the Station is to *identify* an invoice, not to price one, and a
`pipe-delimited` payload carrying a total does not change that.

**The fallback is a comparison, not a guess.** Registers that print no barcode, and
barcodes that will not read, both exist. So the identify response carries the
branch's pending capture, and the Station offers it **by invoice number and amount**
with the instruction to match it against the paper before confirming. That is the
old automatic behaviour, made visible and made the operator's choice. Manual typing
of an invoice number is also accepted — an operator typing `INV-9824` is a supported
path, not an error.

**Offline is unchanged in what it costs.** Identification is impossible with the
server unreachable, so a network failure at step 1 queues the card alone, exactly as
the one-step flow did: the spend is credited on reconnect, there is no slip for that
basket, and the screen says so rather than implying one is coming. A failure at
step 2 queues the card *with* the invoice number, so the replay attributes the sale
the operator chose.

**Printing became an explicit act.** The slip used to print automatically on a
qualified scan. It now renders on screen first — at paper width, as a preview — and
prints when the operator presses the button. Two reasons: the customer sees the
figures before the paper exists, which is what was asked for; and `window.print()`
opens a modal dialog, which would have covered the preview and stolen focus from the
scan field in the same instant.

**The preview renders `PrintableSlip` itself.** Not a second markup of the same
paper. A separate preview is a second description that stays plausible while it
drifts, and the first person to notice would be a customer holding a slip that does
not match what they were shown. `zoom` magnifies the block rather than
`transform: scale()`, because zoom reflows and cannot overlap what follows it.

#### Three defects the preview found by being looked at

All three are §12.27's class — right string, right DOM, wrong reading — and none was
visible to a test.

1. **`بطاقة ••••1234` rendered as `بطاقة 1234••••`.** Label and masked digits shared
   one interpolated string; the bidi algorithm resolved the mask against the Arabic
   paragraph and put it on the far side of the number. The label is now a separate
   string and the number sits in a `<bdi dir="ltr">`.

2. **The slip's date printed as `19:42 ,02/09/2026`.** `toLocaleString('en-GB')`
   produces `02/09/2026, 19:42`; the comma is bidi-neutral, so under the RTL page it
   migrated. This was on the **printed paper** as well as the screen and had been
   since the slip was written — it took putting the paper on a screen to see it.
   The date, the invoice number and the voucher code are now each wrapped in an
   isolating `Ltr` helper.

3. **The slip's discount label disagreed with its own value.** A fixed-amount ladder
   of 7,500 capped by §2.3's absolute ceiling to 5,000 printed
   `الخصم (7,500 د.ع)` beside `− 5,000 د.ع` — two different sums of money on one
   line of a slip a cashier takes money off a till for, with no way to tell which one
   to use. `formatDiscountLabel` now states the value **applied** for a fixed amount.
   A percentage keeps its rate, because a rate and a sum are different units and
   cannot be confused: `3٪` beside `− 5,000 د.ع` reads correctly even when capped.

The third one is worth naming separately: **it is not a formatting bug.** It is a
money-communication defect on the one piece of paper that instructs a cashier, and
it reached the screen only because the slip was rendered where a person could read
it. §12.27 said human-readable formats need a rendered check; this says the check
catches more than formatting.

#### What the operator sees, per state

Every state names its next action, because an operator who has to work it out does
it slowly and differently each time:

| State | What it says |
|---|---|
| Step 1 idle | «ابدأ بالبطاقة — قبل الفاتورة» |
| Unknown / blank card | enrolment offered; the field stays live for the next scan |
| Lost / replaced / void | the honest reason, and «بحث عن الزبون» — never "retry" |
| Step 2 idle, capture waiting | the invoice by number and amount, with «طابق الرقم والمبلغ…» |
| Step 2 idle, nothing captured | «اطلب من الكاشير طباعة الفاتورة، ثم امسح الباركود عليها» |
| Qualified | total large, then the slip preview, then «طباعة القسيمة» |
| Not qualified | the progress sentence — a sales prompt, never a rejection |
| Named invoice not captured | «لا توجد فاتورة بانتظار الربط» plus what to do |

The scan field stays live through a card refusal, so the next card needs no tap
first. It is deliberately **not** live on the result screen: a stray scan there would
wipe the slip the customer is reading.

The primary action is pinned to the bottom of the viewport. The preview is a whole
receipt tall, and on a tablet in portrait the print button would otherwise sit below
the fold — an operator with a queue does not scroll to find the button they press on
every sale (§6.5).

---

### 12.31 The Station guide, and the surface it must not become — 2026-09-02
*(operator request)*

A «دليل الاستخدام» button on the Station login screen opens a five-screen
walkthrough: logging in, the two-step scan order, what each scan outcome means,
registering a customer and replacing a lost card, and what the connection indicator
is telling you.

**It opens from the login screen, before anyone signs in.** That placement is the
whole point rather than an arbitrary spot: the operator most in need of it is the one
who cannot get past that screen, and "the password comes from the manager and cannot
be changed here" is one of the five things it says. A guide reachable only after a
successful login would be missing its first reader.

**It is reading matter, and that is a constraint with teeth.** Five screens, three
controls — next, back, close — and nothing that changes any state. §6.4 forbids a
settings screen anywhere in this app, and a help section is exactly where the first
one arrives: as "just a link to the server address", then "just a way to re-pair the
scanner", each one reasonable on its own. There is no such link here and none should
be added. The way to change anything is the manager app, behind manager
authentication.

**The copy lives in `lib/guide.ts`, not in the component.** It is long enough to
deserve reviewing as copy rather than as markup (CLAUDE.md §9), and the wording of
what a station operator is told about an unrecorded sale is not a detail to find by
reading JSX. The audience is a cashier: no field names, no endpoints, and none of
"sync", "queue" or "token". Every line is either something to do or something they
will see.

**Currently reachable only from login.** Deliberate, and the narrower of the two
options: adding an entry to the scan screen's header would put a fourth control on
the one screen §6.4 wants at its most minimal. If mid-shift access turns out to
matter, the header is where it goes — but it is a change to make on evidence rather
than in anticipation.

One RTL note worth recording because auto-generated designs get it backwards (§6.7
#4): **on this page "back" points right and "next" points left.** `ChevronRight` is
therefore on the back control and `ChevronLeft` on the forward one — the opposite of
what the component names suggest, and correct. Verified by looking, along with the
progress dots, whose index 0 must sit rightmost.

---

### 12.32 The cards screen, and two bugs the rebuild produced — 2026-09-02
*(operator request: layout, a fuller batch section, obvious printing, a quieter
destructive action)*

#### Why the content sat against the edges

`Card` in the manager app carries no padding of its own — `CardHeader` brings its
own `px-6 py-4` and the body is whatever the screen puts there. Every other screen
wraps its body in a `p-6`; the cards screen did not, so its figures and its table
touched the card border on three sides. Not a missing token, just a missing wrapper,
and it is worth naming because the same omission is invisible in review: the markup
looks like every other screen's.

#### The table became one panel per batch

A batch is not a row of five values. It is a serial range, five status tallies, a
provenance line, two printing actions and one destructive one, and pressing that into
table cells is what produced the cramped rows. Each batch now has its own panel with
its own sections — which is also what lets the destructive action sit visually
**below** the others rather than beside them at equal weight.

Every tally is shown even at zero. A row that appears only when non-zero leaves the
reader wondering whether it is missing or absent, and zero is drawn plainly whatever
the tone: colouring a nought amber says a batch has losses when it has none.

#### The sequence is stated, not implied

§12.25 removed the merchant's ability to choose a starting serial precisely so two
batches could not collide. The screen showed the next serial in a corner and left the
guarantee to be inferred. It now has its own panel — where the sequence has reached,
what the next batch takes, how much has been printed — under a line saying the system
picks the serials. **An unstated guarantee reassures nobody**, and the reassurance was
the point of the design.

#### Reprinting a serial range

`POST /cards/batches/:id/export` now takes an optional `serialFrom`/`serialTo`. The
case is ordinary: a stack jams in the card printer, a run comes out misaligned, a
handful are damaged in transit. Reprinting the whole batch to recover forty cards
means pulling every number in it out of the machine again, and the export file is the
one artefact of this feature worth stealing.

Three properties, each with a reason:

- **The audit entry records what was actually read** — rows and range. "Who has seen
  these numbers" stays answerable, which it would not be if every reprint were logged
  as a full-batch export.
- **A partial reprint does not advance the batch's status.** Reprinting two cards does
  not mean the batch has been sent to the printer.
- **An overhanging range is clamped, not refused.** The merchant is reading serials
  off a damaged stack; an off-by-one at the end of the run should produce the cards
  that exist. A range entirely outside the batch is still an error, and **half a
  range is refused** — "from 40" with no end could mean to the end of the batch or a
  typo that dropped it, and neither reading is safe on a file of card numbers.

#### Two bugs this produced, and what they have in common

Both were introduced by the change and both were caught by looking at real output
rather than by any test that existed.

**1. The range filter leaked into the batch tallies.** `counts` was computed by
tallying the rows just fetched, which used to be the whole batch and now was the
requested slice. A three-card reprint reported a five-card batch as containing three
— on the screen that renders that very response. The counts come from a `groupBy`
over the whole batch now, which also reads the tallies without pulling a single card
number out of the database.

**2. A body schema broke every client that sends no body.** Adding
`ExportCardBatchRequestSchema` to the route made a POST with **no body at all** fail
with 400: Fastify hands the validator `null`, and a Zod `.default({})` only fires on
`undefined`. The browser was fine — it sends `{}` with a JSON content-type — so the
new UI worked perfectly while curl, scripts and the packaging smoke test broke.

That second one is **§12.20 read from the other end**. There, the browser broke
because the tests used curl; here curl broke because the feature was built against
the browser. The rule generalises past HTTP verbs and header defaults to this:

> **A request shape is supported only if some real client builds it that way in a
> test.** Adding a body schema to an endpoint that previously took no body is a
> breaking change to every caller that sends none, and it is invisible from the app
> that prompted the change.

Both shapes are now covered by tests, and the schema uses `z.preprocess` rather than
a default so `null` and `undefined` both mean "the whole batch".

#### One more rendered check

The reprint confirmation first read «...للمدى 000002 — 000004 — 3 بطاقة»: three
em-dashes in one line, one of which belongs inside the range. Read aloud it is not
clear which dash separates what. The count moved to the front and the dash between
them went — §12.27 applied to a sentence rather than a number.

---

### 12.33 Reports became charts, and the colour was computed rather than chosen — 2026-09-02
*(operator request: a chart for every section, distinct colours per category,
colourblind-safe, never meaning by colour alone, 2D, and every state covered)*

#### The palette is a measurement, not a taste

§6.2 gives the product **one** accent and reserves amber, red and green for status.
That is right for the UI and insufficient for a chart: one accent cannot tell five
capture modes apart, and painting a fifth series in the warning amber would make a
colour that means *something is wrong* mean *series 4* instead.

So charts get their own categorical scale, anchored on the brand accent and run
through `dataviz/scripts/validate_palette.js` rather than eyeballed. Two findings
worth keeping:

- **The brand accent itself fails as a series colour.** `#0F6E56` measures OKLCH
  chroma 0.091 against a 0.10 floor — the point below which a hue stops reading as
  an identity and starts reading as grey. `#0E7C60` is the nearest step in the same
  hue that clears it (under 4° of hue drift). The UI keeps `#0F6E56`; this is a
  chart-only substitution with a number behind it.
- **The slot order is the CVD-safety mechanism.** All 24 orderings of the four
  non-status hues were enumerated against the validator; the chosen one maximises
  the worst adjacent pair at ΔE 18.5 (deuteranopia) against a target of 8, and 19.3
  against the normal-vision floor of 15. The order is recorded in `lib/viz.ts`
  alongside the numbers, so a future edit can be checked rather than argued about.

One check does not pass outright: magenta sits at 2.69:1 against the white surface,
below the 3:1 mark. **That WARN is not dismissable — it obligates a relief
channel**, so every series on every chart carries a visible direct label and every
chart has a table view. Which is also, exactly, what the operator asked for.

The tier ladder is **ordinal**, not categorical: swapping two tiers would change what
the chart says, so it takes a one-hue ramp whose lightness carries the order. Its
light end needed three attempts — `#9EDCC7` and `#6BC9AD` both looked fine and
measured 1.55:1 and 1.98:1 against a 2.0 floor. **The eye cannot see a 2:1
boundary.** That is the case for running the script.

#### Colour follows the entity, never the row

`CAPTURE_MODE_COLOR` and `CATEGORY_COLOR` are `Record`s keyed by the enum, so a
filtered response cannot shift an assignment and there is no index to cycle past. A
manager who learns that the orange bar is the serial bridge must not find orange
meaning something else next week because one mode went quiet. **Verified by
observation**: switching the range reorders the capture rows by count, and
SPOOL_WATCH stayed teal while its position moved.

An enum value this build has never seen gets grey, deliberately — "not one of the
known things" rather than impersonating a slot that means something else.

#### The glow, kept where it cannot cost legibility

The operator asked for glow, shadow and light. It is implemented as a **shadow cast
beneath the mark**, tinted with the mark's own hue — never a halo around the data
and never a lift on the fill. Contrast between a series and the surface is the thing
the validator measured; anything that alters the fill invalidates that measurement.
The fill keeps the exact validated hex.

#### Every state, in the same visual language

Seed data never produces an empty panel, a single-point chart, a 4-million-to-1
ratio or a label the width of the card — so the states were rendered by stubbing
`window.fetch` in the running app and letting the **real components** draw them.
That is the §12.20 principle applied to states rather than clients: a state that no
real render has produced has not been checked.

Two defects came out of it, and neither was visible in development:

1. **Counts were not thousand-separated.** `4200000 زبون` sat one card away from
   `987,654,321 د.ع` — the two most prominent numbers on the screen formatted by
   different rules, the ungrouped one unreadable at a glance. Every real figure in
   the seed data has four digits or fewer, which is why nothing showed it. All count
   formatters now group the way money does.
2. **The attribution rate disappeared in table view.** It lived in the chart's
   children, so switching to the table replaced it — in the one view a reader most
   wants the caption. `ChartFrame` grew a `footer` slot that survives the toggle.

The states, and what each does:

| State | Behaviour |
|---|---|
| Empty | Flat grey rules where the bars would be, and a **panel-specific sentence** — an empty capture panel and an empty tier panel mean different things |
| Single point | Drawn at its true share of the scale; never stretched to full width unless it is 100% |
| Zero row | No bar, label still present — the gap is visible as a gap |
| Long label | Table view carries it in full; the bar row truncates rather than reflowing the chart |
| Huge ratio | The bar cannot show 4,200,000 : 1, and **the direct label is why that is survivable** — the number is read, not measured off a sliver |
| Refetch | Previous figures held at 45% opacity, never a skeleton flash — no layout jump |

#### One deliberate divergence from the skill

The dataviz guidance says a large standalone figure should use proportional digits,
because `tabular-nums` makes `121` look loose at display sizes. **This product goes
the other way**: §6.3 sets IBM Plex Mono with aligned digits on all money, and the
reason is operational rather than typographic — the same figure is read off a screen,
off a thermal slip, and down a phone line, and it should look the same in all three.
`tabular-nums` stays. Recorded so the divergence reads as a decision.

---

### 12.34 Glass, and the arithmetic that decided where it goes — 2026-09-02
*(operator request, with three constraints: contrast must still meet accessibility
standards over every background; not on dense tables or small text; the §6.2 palette
stays — glass is a surface treatment, not a new palette)*

#### The placement rule is computed, not aesthetic

Text contrast through a translucent surface depends on what is behind it. This
product has **no photographic background anywhere**, so the worst case is bounded and
can be worked out rather than guessed. Measured, for §6.2's own ink and steel:

| Glass sits over | ink `#1A1D21` | steel `#6B7280` |
|---|---|---|
| the canvas `#F7F8FA` (α 0.78) | 16.6:1 | **4.76:1** ✓ |
| content — a chart bar, the accent (α 0.92) | 15.0:1 | **4.30:1** ✗ |
| the guide's dim scrim (α 0.88) | 15.1:1 | **4.32:1** ✗ |

**Steel does not reach 4.5:1 over content at any alpha worth using** — not even at
1.0, where it measures 4.83:1 on pure white and has nowhere left to go. So:

- `.glass` (α 0.78) — sits on the canvas with nothing behind it. **Any text.**
- `.glass-panel` (α 0.92) — overlaps content. **Ink and controls only.**
- `.glass-scrim` — the dimmer behind a dialog. The dialog stays opaque.

A panel that must carry secondary prose stays opaque. That is not a limitation to
design around; it is the answer.

#### Where it went, and where it deliberately did not

| Applied | Why it is safe there |
|---|---|
| Station login + first-run setup | On the canvas, alone. First surface anyone sees |
| Manager login + first-run setup | Same |
| Manager nav rail | On the canvas beside content, not over it — steel labels clear 4.76:1. The frosting is texture rather than refraction; nothing scrolls behind it |
| Station result action bar | Overlaps the slip preview. Buttons and ink only — **verified: zero `steel` descendants in the live DOM** |
| Station guide scrim | The dimmer only |

| Refused | Why |
|---|---|
| **The guide panel itself** | Its body text is steel over a dimmed backdrop — the exact failing case. A help screen harder to read than the app it explains is a poor trade for a texture |
| **Chart surfaces** | `viz.ts`'s categorical palette was validated against a SOLID surface. Translucency changes the effective background and **invalidates every contrast number in §12.33** |
| **Data tables and small text** | The operator's own constraint, and correct |
| **Status banners** | Their amber/danger tint *is* the signal. Diluting a warning's ground to make it prettier is making it quieter |
| **The slip preview** | It is a picture of paper |

#### The bug: a class that was present and doing nothing

First implementation applied `.glass` via `addComponents` and it computed to
`backdrop-filter: none` on an opaque white — **present in the DOM, correct in the
source, and visually identical to an ordinary card.**

Tailwind's `components` layer loses to `utilities`, and every card in this product
already wears `bg-surface shadow-card`. The class was there; the cascade discarded
it. The fix is a doubled selector — `.glass.glass`, specificity 0,2,0 — which beats
a single utility class without `!important` and without callers having to strip the
utilities being replaced.

**It was caught by reading the computed style in the running app, not by looking at
the markup.** That is §12.20's habit applied to CSS: a class name in a JSX file is a
claim about what the browser will do, and the browser is the only thing that can
confirm it. A second lesson came with it — the preset is a `.cjs` outside Vite's
watched sources, so the change needed a dev-server restart before it appeared at all.

`prefers-reduced-transparency` and `forced-colors` both switch every glass surface
back to opaque white. `backdrop-filter` degrades to the flat translucent fill where
unsupported, which is why the alpha is high enough to carry the contrast alone.

---

### 12.35 The rename to "Customer loyalty", and the four identifiers that stayed — 2026-09-02
*(operator request, with an explicit instruction to flag what renaming would break
before changing it)*

#### What changed, and what did not

Everything a person **reads** was renamed. Every identifier the **operating system**
keys on was not. The full table, with the specific failure attached to each
identifier, is in `packaging/README.md` under *"Renaming the product"* — it belongs
beside the installer, which is where anyone would go to change one.

The short version: window titles, in-app wordmark, installer publisher and
descriptions, and the Windows service **display** name all say *Customer loyalty*
now. `productName`, `identifier`, `SERVICE_NAME`, `FIREWALL_RULE`,
`%PROGRAMDATA%\Walaa\`, the database and env filenames, and the `/health` service
string all still say *walaa*, and each has a comment or a README row saying why.

Two of those are worth restating here because the reasoning is not obvious:

- **`FIREWALL_RULE`.** The rule is created and deleted *by name*. Renaming it
  orphans the old one — left open on the shop's network with nothing left that knows
  how to close it — and adds a duplicate beside it.
- **`/health` → `"service":"walaa-api"`.** `testApiUrl()` in the Station refuses any
  address whose `/health` does not answer with exactly that string. Changing it makes
  **every already-paired station** report "this is not a Walaa server" until someone
  walks to each one and re-runs setup.

#### What an existing installation would do if `productName` changed

The question the operator asked, answered concretely (full walk-through in the
README):

`productName` sets the install directory. Point a new installer at
`%PROGRAMFILES%\Customer loyalty\` and install over an existing shop, and the
pre-install hook — which looks for `$INSTDIR\runtime\walaa-service.exe` to stop the
service before copying — finds an empty new directory and **passes over silently**.
The old service is never stopped. The post-install hook then tries to register
`WalaaApi`, which already exists, and shows its "could not be registered" dialog.

Result: **two installations on disk, one service still running the old binaries, and
a warning box.** The shop keeps working, because the old service is still serving —
which is the part that makes this dangerous rather than obvious. The data survives
either way; `%PROGRAMDATA%\Walaa` is untouched by both installers, which is exactly
why it is on the do-not-rename list.

If the rename is wanted anyway, the fix is one addition, not a rewrite: read
`InstallLocation` from the uninstall registry key — which is keyed on `identifier`,
and `identifier` is not changing — and run `uninstall` against the service
executable found there before the file copy. **It cannot be verified from a
development machine**; it needs a real prior installation to upgrade over.

#### The icon, and two things about the supplied asset

All sixteen files in CLAUDE_v2.md §5.2 were generated from `customer_loyalty.ico`
via the §5.3 workflow. `icon.ico` was then rebuilt with PIL, because the Tauri
generator emits 16/24/32/48/64/256 and §5.2 names **128** — which the generator
omits and a 24 px frame replaces. The rebuilt ICO carries exactly the six frames the
spec lists. The unused `android/` and `ios/` output was deleted; this bundle targets
NSIS only.

Two properties of the supplied artwork, neither a defect exactly, both worth knowing:

1. **It is fully opaque.** All 65,536 pixels are alpha 255, with a flat `#EDEBEC`
   field around the glass tile at roughly 11% padding. App icons are normally
   transparent outside the mark; this one will show a grey square on a dark taskbar.
   In-app it showed as a grey patch with hard corners on a white card, so `BrandMark`
   renders it with a 24% radius and a hairline ring — an icon chip. **The artwork
   itself is untouched**: keying the field out would halo the soft glass edges, and
   redrawing a supplied brand mark is not a component's job.
2. **Its largest frame is 256 px.** `icon.png` (512) and `Square310x310Logo.png` are
   therefore **upscaled**, and will be softer than the rest. A transparent 1024 px
   master would fix both this and the point above in one step.

#### The placeholder that was replaced

The sidebar, both logins and both setup screens carried a teal square with the
letterform «و» — written by CLAUDE_v2.md §5.3 step 3, which explicitly called it a
stand-in *"to be replaced before first distribution"*. It has been. The mark is now
the same artwork the taskbar and installer show, because two drawings of a brand are
two brands.

---

### 12.36 RULE — user-visible names are free; OS identifier strings are frozen — 2026-09-02
*(operator ruling, made permanent. This is a standing rule, not a record of one
rename.)*

> **Any name a person reads may be changed at will. No string the operating system
> keys on may be changed — not the installer's product name, not the Service Control
> Manager's service name, not the firewall rule's name, not the data directory.
> Renaming one of those does not rename an installation; it *isolates* it, leaving
> the old one installed and running while the new one stands beside it.**

The failure this prevents is specifically the one that looks fine: **a shop silently
running a store of outdated executables.** Nothing errors, the tills keep working,
and the only symptom is that the update did not take.

#### The two lists

| Free to change | Frozen |
|---|---|
| Window titles, browser tab titles | `tauri.conf.json` → `productName` |
| In-app wordmark and branding | `tauri.conf.json` → `identifier` |
| Installer publisher, descriptions | `SERVICE_NAME` (`WalaaApi`) |
| Windows service **display** name | `FIREWALL_RULE` (`Walaa Loyalty API`) |
| Every Arabic UI string | `%PROGRAMDATA%\Walaa\`, `walaa.db`, `walaa.env` |
| App icon and mark | `/health` → `"service":"walaa-api"` |
| | `WALAA_DATA_DIR`, `@walaa/*` package names |

Each frozen entry has a distinct failure, and they are worth keeping separate
because a future reader will be tempted to treat them as one squeamish rule:

- **`productName`** sets `$INSTDIR` **and the uninstall registry key** — Tauri's NSIS
  template defines `UNINSTKEY` as `…\Uninstall\${PRODUCTNAME}`, not the bundle id.
  Rename it and the installer targets a new directory and writes a new registry
  entry, so Add/Remove Programs shows two products and the old install is never
  touched.
- **`identifier`** is the bundle id. Not the uninstall key (see above — that was
  checked in the generated template, not assumed), but still the app's identity to
  the OS and to any future updater.
- **`SERVICE_NAME`** is how an upgrade finds the service it is replacing. It is also
  what makes the rename *recoverable* — see the fix below.
- **`FIREWALL_RULE`** — rules are created and deleted by name. A rename orphans the
  old rule, left open on the shop's network with nothing that knows how to close it,
  and adds a duplicate beside it.
- **`%PROGRAMDATA%\Walaa\`** holds the live database **and the backup encryption
  key**. Renaming it strands both.
- **`/health` → `"service":"walaa-api"`** — `testApiUrl()` in the Station refuses any
  address that does not answer with exactly this string. Change it and **every
  already-paired station** reports "this is not a Walaa server" until a person walks
  to each one and re-runs setup.

#### The hook that makes a future rename possible

*(written 2026-09-02, **unverified** — see the warning below)*

`NSIS_HOOK_POSTINSTALL` now runs `walaa-service.exe uninstall` unconditionally
before `install`.

That single line is the whole fix, and the reason it works is the rule above: **the
service is deregistered by NAME, and the name is frozen.** So the new build can
retire a previous installation it cannot even see on disk — different directory,
different product name, different registry key, same `WalaaApi`. `uninstall` stops
the old service with a grace period first, which is also what releases the SQLite
file before the new service starts.

It sits in POSTINSTALL rather than PREINSTALL because on a renamed install
`runtime\` does not exist yet at PREINSTALL time. It is idempotent: `uninstall`
returns success when nothing is registered, and on a same-path upgrade PREINSTALL
has already done it.

An earlier draft read `InstallLocation` from the uninstall registry key, on the
assumption that the key was keyed on `identifier`. **Reading the generated
`installer.nsi` showed it is keyed on `${PRODUCTNAME}`**, which is exactly the thing
that would have changed — so that draft would have looked up a key that does not
exist and silently found nothing. Recorded because the assumption was reasonable and
wrong, and the only thing that caught it was opening the template.

> **UNVERIFIED.** The renamed-install path has never executed against a real prior
> installation and cannot be from a development machine — it needs a box that
> already has one. The no-op cases (first install, same-path upgrade) are the only
> ones exercised. **Do not describe this as working.** It is untested code with a
> clear rationale, waiting for a machine that can prove it.
---

### 12.37 §2.3's cap is now reported, not only enforced — 2026-09-02
*(operator ruling, following §12.30's slip defect)*

§12.30 fixed a display bug: a slip printing `الخصم (7,500 د.ع)` beside `− 5,000 د.ع`
after the absolute cap trimmed the discount. **The operator's point was that the
display was the smaller half of the problem.**

> The cap binding is not a neutral fact. It means the tier ladder is asking for more
> than the merchant decided to give. If it binds on every qualifying sale, the ladder
> is misconfigured — and §2.3 exists to protect the margin, so it should say so.

**A guardrail that never reports is a guardrail nobody can tune.** The system was
computing exactly how much it withheld on every sale and throwing the number away.

#### What is stored, and why it had to be

`transaction.discount_uncapped_value` — what the ladder called for **before** §2.3's
absolute ceiling, a tier's own `maxDiscountValue`, or a basket smaller than the
discount trimmed it.

It is set equal to `discountValue` whenever nothing bound, which makes the pair
self-describing: `uncapped > value` **is** the test for "the cap bit here", and the
difference is what it saved. No flag column, no second source of truth.

The migration backfills existing rows with `discount_value`, i.e. "nothing was
trimmed". That is **absence of evidence, not a claim that no cap ever bound** — the
uncapped figure for a historical row is genuinely unknowable. It keeps
`uncapped >= value` true everywhere, so the reported saving can never come out
negative, which a test pins.

#### What the manager sees

A panel on Reports, beside capture health — both answer *is this configured right?*

| Figure | Meaning |
|---|---|
| «فواتير طُبّق عليها الحد الأقصى» | Count, **as a share of discounted sales** |
| «ما وفّره الحد الأقصى» | Σ(uncapped − applied) over the range |
| Amber advice, at ≥ 67% | «الحد الأقصى يعمل في أغلب الخصومات — مستويات الخصم أعلى مما قرّرته» |

**The share is against discounted sales, not all captures.** "The cap binds on most
discounts" and "the cap binds on 2% of footfall" are different sentences, and only
the first says the ladder is wrong. Two thirds is the threshold because a cap that
catches the occasional wholesale invoice is the cap working as designed; a hair
trigger would train the manager to ignore it.

#### The gap this closed, found while testing it

Setting a rule above the cap through the API is **already refused** —
`PUT /discount/rules` answers «القواعد تتجاوز الحدود المسموحة في إعدادات المتجر». So
in principle the misconfiguration cannot be created.

In practice the dev database contains exactly that state: a 7,500 fixed-amount rule
under a 5,000 cap, written by the seed, which goes to the database directly and never
passes the validator. **Any path that is not the API can produce a configuration the
API would reject** — a seed, a restore, a hand-edit, a future import. Reporting is
what catches the configuration that validation never saw, which is a better argument
for this feature than the one it was requested on.

#### Bounds

`forgoneDiscountValue` sums across every transaction in the range, so §13.5's per-row
Int32 bound does not cover it. It accumulates in JavaScript rather than SQL — exact
to 2^53, which a year of a supermarket's discounts does not approach — matching how
`discountsGranted` beside it has always been computed. A partial index carries the
capped rows, which are a small minority of a table that grows with every sale.
