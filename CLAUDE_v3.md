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
| `apps/assistant` (Expo mobile) | **DISCARD** | Replaced by the Loyalty Station (§6) |
| WhatsApp as core dependency | **DEMOTE** | Now an optional module (§8) |
| Integration Gateway concept | **KEEP** | Now fed by the Print Capture Agent |

**Rule:** Do not delete `apps/assistant` until the Loyalty Station is functional. Rename it
to `apps/_deprecated_assistant` and remove it at the end of the migration.

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

## 9. OPEN BLOCKER — do not assume resolved

**The discount delivery mechanism is not yet verified.**

Cashiers cannot modify invoices. Therefore the discount cannot be applied as a price reduction.
The designed solution is **voucher-as-payment**: the invoice stays at full value in the POS
(no edit, no permission needed), and the customer pays *cash + voucher*. Books reconcile
exactly, and vouchers are collected and matched against system records at end of day.

**This depends on Al-Bayan supporting split/multiple payment methods on one invoice — NOT YET
CONFIRMED.**

**Instructions:**
- Build the full capture, calculation, recording, and voucher-issuing pipeline now. It is
  correct and necessary under either outcome.
- Treat the redemption/settlement step as **pluggable**: implement a `DiscountSettlementStrategy`
  interface with two implementations — `VoucherAsPaymentStrategy` (preferred) and
  `DailyPromotionalExpenseStrategy` (fallback: vouchers are aggregated daily and booked as a
  promotional expense — less elegant but accounting-sound).
- **Never** implement a flow where the cashier collects less cash than the POS recorded without a
  corresponding voucher record. That creates an unexplained cash shortfall that reads as theft in
  the books and will wrongly implicate staff.

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
