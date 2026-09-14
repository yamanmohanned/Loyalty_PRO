# CLAUDE.md — Supermarket Loyalty Platform ("ولاء")

> **Purpose of this file:** This is the single source of truth for building the
> Supermarket Loyalty Platform. Claude Code MUST read this file at the start of every
> session and adhere to every directive, standard, and constraint below. When any
> instruction here conflicts with a default habit, THIS FILE WINS.
>
> **Companion file:** `PROMPT.md` contains the execution kickoff prompt and build order.
> Read `PROMPT.md` after this file.

---

## 0. Non-Negotiable Rules (read first)

1. **Never break the core loop.** The heart of this product is: *scan customer → scan
   invoice → link → notify*. Every decision optimizes this loop for speed and correctness.
2. **Idempotency is mandatory.** The same invoice can NEVER be linked twice. Enforce at the
   database level (unique constraint) AND the API level (idempotency check).
3. **RTL-first, always.** Every screen is right-to-left Arabic. This is not a
   post-processing step — build it in from the first component.
4. **Data minimization.** Store the least customer data possible. Phone number is the
   identifier. No sensitive personal data.
5. **Security is a first-class requirement, not a phase.** Apply the security standards in
   §7 to every endpoint and screen as you build it, not at the end.
6. **Verify before claiming done.** Never report a feature complete without running it.
   Run the build, run the tests, confirm the output. Evidence before assertions.
7. **No mock/fake data in production paths.** Use realistic Iraqi seed data only in
   clearly-marked dev seeds.
8. **Ask when genuinely blocked; otherwise proceed.** If a decision is reversible and
   low-cost, make it and note it. If it's irreversible or a security/data-model decision
   with no clear default here, stop and ask.

---

## 1. Product Overview

### 1.1 What this is
A customer loyalty and rewards system for a supermarket. Customers earn a discount on their
next visit once their cumulative spending over a defined period crosses a merchant-defined
threshold. The system attributes anonymous printed invoices to known customer accounts.

This belongs to the category of **Post-Purchase Loyalty Systems**.

### 1.2 The core loop (memorize this)
```
Customer pays at register → receives printed invoice → hands it to the assistant
        → assistant scans CUSTOMER QR (identity)      [STEP 1 — always first]
        → assistant scans INVOICE barcode (purchase)  [STEP 2]
        → amount auto-filled if encoded, else manual entry
        → system links invoice to customer, updates cumulative balance
        → threshold check → issue coupon if crossed
        → WhatsApp notification sent to customer
```
**Rule:** Customer identity is ALWAYS captured before the invoice. Never allow an invoice to
be scanned without a customer already selected in the current session.

### 1.3 The two applications
- **Manager Dashboard** — Web. For the store owner/manager. Full control over rules,
  customers, reports, settings, integrations.
- **Cashier Assistant App** — Mobile (phone/tablet, used beside the register). Speed-first.
  Executes the core loop.

### 1.4 Two identification methods (hybrid)
- **Primary:** Customer QR code (permanent, generated once at registration, shown from
  WhatsApp). ~1 second.
- **Fallback:** Phone number lookup (a UNIQUE identifier — NOT a name search). Used when the
  customer has no QR ready. Returns exactly one account or zero (→ new registration).

Name search is explicitly **forbidden** as an identification method (not unique, too slow in
a queue).

---

## 2. Architecture

### 2.1 Guiding principle: source-agnostic core
The loyalty core must not care *how* an invoice arrived. Every invoice source produces the
same **Normalized Invoice Schema** before entering the core. This makes the scanning
approach and any future accounting integration interchangeable at the edges.

### 2.2 Integration tiers (build order matters)
```
TIER 3 — Universal Mode (Scanning)   ← BUILD THIS NOW. The default, works everywhere.
TIER 1 — API Integration             ← Future. If the merchant's accounting software has an API.
TIER 2 — Local DB Agent              ← Future & optional. HIGH CAUTION (see §2.4).
```
For the current build, implement **Tier 3 (Scanning) only**. Design the ingestion boundary
(the "Integration Gateway") so Tiers 1 and 2 can be added later without touching the core.

### 2.3 The Normalized Invoice Schema (the contract)
Every source MUST emit this shape. This is the central data contract of the system:
```json
{
  "invoice_id": "INV-9824",
  "amount": 85000,
  "currency": "IQD",
  "branch_id": "BAG-01",
  "customer_identifier": "07701234567",
  "occurred_at": "2026-08-24T10:42:00Z",
  "source": "scan | api | db_agent",
  "amount_capture": "auto | manual"
}
```
Put this type in a **shared package** (`packages/shared-types`) imported by web, mobile, and
backend. Single definition, no drift.

### 2.4 Local DB Agent — caution (for future reference, do not build now)
Reading a third-party accounting DB directly is **not automatically legal or safe**. Before
ever enabling it: verify the specific software's license permits read access; treat schema
changes across updates as a breakage risk; isolate the agent's DB credentials; make the
agent read-only. Prefer API (Tier 1) over DB access (Tier 2) always. Document this caveat
wherever the agent is referenced.

### 2.5 Multi-tenancy readiness (build the seam, not the product)
Build for a **single merchant now**, but include `merchant_id` on every core table and scope
every query by it from day one. This lets the system become multi-tenant SaaS later without a
data-model rewrite. Do not build tenant onboarding/billing now — just the isolation seam.

---

## 3. Technology Stack

Chosen for consistency with the developer's existing toolchain and for being production-grade.

### 3.1 Monorepo
- **Turborepo** + **pnpm** workspaces.
- Structure:
  ```
  apps/
    dashboard/     → Next.js (manager web dashboard)
    assistant/     → Expo / React Native (cashier mobile app)
    api/           → Fastify (backend service)
  packages/
    shared-types/  → Normalized schema, DTOs, enums (TS)
    ui/            → Shared design tokens / primitives where sensible
    config/        → Shared eslint/tsconfig/tailwind preset
  ```

### 3.2 Backend (`apps/api`)
- **Fastify** (TypeScript) — HTTP API service.
- **Prisma** ORM + **PostgreSQL** — primary datastore.
- **Zod** — runtime validation on every request boundary.
- **JWT** auth (access + refresh) with role-based access control.
- **Argon2** for password hashing.
- **Pino** for structured logging.
- Background jobs: a lightweight queue (**BullMQ** + Redis) for notifications and threshold
  processing. If Redis is undesirable initially, a simple DB-backed job table is acceptable
  for MVP — note the tradeoff in code.

### 3.3 Manager Dashboard (`apps/dashboard`)
- **Next.js** (App Router, TypeScript).
- **Tailwind CSS** with **RTL** configured globally (`dir="rtl"`, logical properties).
- **shadcn/ui** components (customized to the design system in §6).
- **Recharts** for charts (flat, 2D, accessible — see §6 anti-patterns).
- **TanStack Query** for server state; **React Hook Form** + Zod for forms.

### 3.4 Cashier Assistant App (`apps/assistant`)
- **Expo** (React Native, TypeScript).
- **expo-camera** for QR + barcode scanning (supports both symbologies).
- **Offline-first local store:** **WatermelonDB** (or SQLite via `expo-sqlite`) with a
  **sync queue**. Operations are written locally first, then synced to the API when online.
- **expo-secure-store** for token/credential storage (never AsyncStorage for secrets).
- **React Navigation** (bottom tabs + stacks), RTL-aware.
- **Reanimated** for the scan-success animation (the one "hero" motion — see §6.6).

### 3.5 Notifications — WhatsApp
- Use the **WhatsApp Business Cloud API** (Meta) as primary.
- **Reality to encode:** business-initiated messages require **pre-approved message
  templates**. Build a template abstraction so message content maps to an approved template
  with variables (customer name, invoice amount, balance, amount-to-next-threshold).
- Provide a **provider interface** (`NotificationProvider`) so Twilio or another gateway can
  be swapped in. Include a **dev/stub provider** that logs messages instead of sending, for
  local development.

### 3.6 QR generation
- Server generates a **signed, opaque customer token** (not the raw phone number) encoded in
  the QR. The token resolves to the customer server-side. Never encode PII directly in the QR.

---

## 4. Data Model (PostgreSQL / Prisma)

Design the schema to satisfy these entities and constraints. Field lists are the intent;
refine types in Prisma. Every core table carries `merchant_id`.

### 4.1 Entities
- **merchant** — id, name, created_at. (Single row for now; seam for multi-tenancy.)
- **branch** — id, merchant_id, name, code (e.g. "BAG-01"), created_at.
- **user** (staff) — id, merchant_id, branch_id (nullable for owner), name, username/phone,
  password_hash (Argon2), role (`OWNER` | `MANAGER` | `ASSISTANT`), is_active, created_at.
- **customer** — id, merchant_id, phone (unique per merchant), name, category
  (`REGULAR` | `WHOLESALE` | `VIP`), qr_token (unique, signed), created_at.
- **loyalty_rule_set** — id, merchant_id, period_type (`WEEKLY` | `MONTHLY` | `CUSTOM`),
  period_start/period_end (for custom), is_active. Holds the default tiers.
- **loyalty_tier** — id, rule_set_id, threshold_amount, discount_pct, coupon_validity_days,
  sort_order.
- **customer_override_rule** — id, merchant_id, target_type (`CUSTOMER` | `CATEGORY`),
  target_id/category, threshold_amount, discount_pct, coupon_validity_days. (Overrides the
  default for a specific customer or category.)
- **transaction** (linked invoice) — id, merchant_id, branch_id, customer_id, invoice_id,
  amount, currency, occurred_at, source (`SCAN` | `API` | `DB_AGENT`), amount_capture
  (`AUTO` | `MANUAL`), linked_by_user_id, device_id (nullable), created_at.
  - **UNIQUE constraint: (merchant_id, branch_id, invoice_id)** → the idempotency/fraud guard.
- **coupon** — id, merchant_id, customer_id, discount_pct, source_threshold_amount, issued_at,
  expires_at, status (`ACTIVE` | `USED` | `EXPIRED`), redeemed_at (nullable),
  redeemed_by_user_id (nullable).
  - Enforce single-use: redemption transitions ACTIVE→USED atomically; reject if not ACTIVE.
- **balance_snapshot** (optional cache) — customer_id, period_key, cumulative_amount,
  updated_at. Cumulative balance can be computed from transactions; cache per period for
  dashboard speed. Keep the computed value authoritative, the cache derived.
- **notification_log** — id, merchant_id, customer_id, channel, template, payload, status
  (`SENT` | `FAILED` | `STUBBED`), sent_at, error (nullable).
- **audit_log** — id, merchant_id, actor_user_id, action, entity_type, entity_id,
  before_json, after_json, created_at. Log: rule changes, coupon redemptions, manual amount
  entries, customer edits.

> **Schema addenda (Phase 0).** The implemented Prisma schema extends §4.1 where §7 or
> correctness demanded it. Every addition is justified in **§13**. Summary: a
> `refresh_token` table (§7.1 needs revocable refresh tokens); `merchant.timezone` and
> `merchant.currency`; `period_key` on `transaction`, `coupon` and `balance_snapshot`;
> `transaction.idempotency_key`; `coupon.source_transaction_id`; `CouponStatus.SUPERSEDED`;
> `NotificationStatus.PENDING`; and `is_active` flags on `branch` and `customer`.

### 4.2 Integrity rules
- Cumulative balance is **derived from transactions** within the active period — never
  hand-edited.
- Coupon issuance is triggered by a threshold crossing detected after a transaction commits.
- All money stored as **integer minor-agnostic IQD** (IQD has no common minor unit in
  practice — store whole dinars as integers; document the unit clearly). Never floats for money.
- Timestamps stored in **UTC**; render in local time in the UI.

---

## 5. API Surface (representative — refine as built)

All endpoints: JSON, versioned under `/api/v1`, Zod-validated, JWT-protected (except auth),
role-checked, rate-limited.

- `POST /auth/login` → issue access + refresh (role-aware).
- `POST /auth/refresh` → rotate tokens.
- **Customers**
  - `POST /customers` → register (name, phone, category) → returns customer + signed qr_token.
  - `GET /customers?query=&category=&sort=&page=` → list (dashboard).
  - `GET /customers/:id` → detail (balance, transactions, coupons).
  - `GET /customers/resolve?identifier=` → resolve by qr_token OR phone (assistant lookup).
    Returns one customer or 404.
  - `PATCH /customers/:id` → edit (audited).
- **Transactions (the core loop)**
  - `POST /transactions` → link an invoice. Body = Normalized Invoice Schema + customer_id.
    - **Idempotent:** duplicate (branch_id, invoice_id) → 409 with the existing record.
    - On success: updates balance, runs threshold check, may create a coupon, enqueues
      notification. Response includes new cumulative balance + amount-to-next-threshold +
      any coupon just issued.
- **Coupons**
  - `GET /customers/:id/coupons` → list.
  - `POST /coupons/:id/redeem` → mark USED atomically (audited). Reject if not ACTIVE/expired.
- **Rules**
  - `GET /rules` / `PUT /rules` → default rule set + tiers.
  - `POST /rules/overrides` / `PATCH` / `DELETE` → customer/category overrides.
- **Reports**
  - `GET /reports/overview?range=` → KPIs.
  - `GET /reports/...` → tiers distribution, top customers, category split, etc.
- **Sync (mobile offline)**
  - `POST /sync/batch` → accepts a batch of queued operations from the device; processes each
    idempotently; returns per-item results so the device can clear its queue precisely.

---

## 6. Design System

> **Design source of truth:** The visual designs live in the developer's **Stitch project,
> ID `12203193888392364805`**. Treat the Stitch screens as the primary visual reference.
> Export them from Stitch (HTML/CSS or Figma) and align implementation to them, THEN apply
> the modifications in §6.7. Where Stitch output and the tokens below disagree, the tokens
> below are authoritative for color/type/spacing; Stitch is authoritative for layout intent.

### 6.1 Atmosphere
Calm, retail-grade, quietly premium operations tooling. Balanced density (4–5/10). Restrained,
meaningful motion (5/10). Instantly legible under queue pressure.

### 6.2 Color tokens
- `canvas` #F7F8FA · `surface` #FFFFFF · `ink` #1A1D21 (never pure black) · `steel` #6B7280
- `border` rgba(17,24,39,0.08)
- `accent` **#0F6E56 (Deep Teal — the single brand accent)** · `accent-tint` #E1F5EE
- Semantic only: `amber` #B26B00 (warning/approaching) · `red` #B0322E (error/duplicate) ·
  `green` #1E7B4D (success/linked)
- One accent. Semantic colors carry status meaning only, never decoration.

#### 6.2.1 Two teals, and why they must not be merged
*(operator ruling, 2026-09-02. Both values are correct. Do not "fix" the
inconsistency by collapsing them — this section exists to stop exactly that.)*

| Token | Value | Used for |
|---|---|---|
| `accent` | **#0F6E56** | Every UI surface: buttons, focus rings, chips, links, active nav |
| chart series slot 1 | **#0E7C60** | Data-visualisation marks only — `packages/…/viz.ts` |

They differ because a **UI accent and a data-series colour are measured against
different requirements**, and #0F6E56 passes the first and fails the second.

**The measurement.** #0F6E56 has OKLCH chroma **0.091**, against a **0.10 floor** for
categorical series colour. Below that floor a hue stops reading as an *identity* and
starts reading as grey — which is fatal for a mark whose entire job is to say *which
series this is*, and irrelevant for a button, whose job is done by its shape,
position and label. #0E7C60 is the nearest step in the same hue that clears the floor
(hue drift under 4°, so it still reads as the brand teal).

This was computed, not chosen: `dataviz/scripts/validate_palette.js` reports the
chroma, the CVD separation and the contrast for any candidate. The numbers behind the
whole chart palette are recorded in `apps/manager-desktop/src/lib/viz.ts`.

**Why the resolution is two values rather than one:**

- *Move the UI to #0E7C60 too?* That changes the brand colour of every button in the
  product to satisfy a constraint that only applies to charts. **Changing the brand
  colour is a brand decision, not a fallout of a chart palette** — if it is ever
  wanted, it gets made deliberately and on its own terms.
- *Use #0F6E56 in charts anyway?* It measurably fails, and the failure is invisible
  in review: a slightly-grey teal beside four other hues looks fine to the person who
  chose it and reads as "no colour assigned" to someone scanning a chart.

So: **the UI palette above is unchanged and authoritative for the product. The chart
scale is a separate, validated instrument that happens to start at the brand hue.**
A future reader who notices the two hex values and wants to reconcile them should
re-read this section rather than pick one.

### 6.3 Typography
- Display/headings: **Cairo** (Arabic). Body/UI: **IBM Plex Sans Arabic**.
  All money/numbers: **IBM Plex Mono** (aligned digits in tables/cards).
- Base body ≥16px. Amounts rendered large + bold + monospace.
- **Banned:** Inter, any serif, generic system fonts. (Verify Arabic font availability; if a
  named font is unavailable in the target environment, substitute the closest quality Arabic
  face and record the substitution.)

### 6.4 Components
- Buttons: flat, no glow; primary = solid Deep Teal; secondary = ghost + border; 1px
  press-down; min height 48px (52px for mobile primary actions).
- Cards: 16px radius; near-invisible tinted shadow; used only when elevation groups content.
- Inputs: label ABOVE, helper/error BELOW; Deep Teal focus ring; min 48px; large tap targets.
- Amount inputs: oversized monospace, "د.ع" suffix pinned inside.
- Loaders: **skeletal shimmer** matching layout — never circular spinners.
- Empty states: composed illustration + one line + single action — never bare "No data".
- Status chips: pill; tinted background from the semantic color's lightest stop, text in its
  darkest stop.

### 6.5 Layout
- Dashboard: fixed navigation rail on the **RIGHT** (RTL) + fluid content; max-width 1440px.
- Mobile: single column; primary action pinned to the thumb zone (bottom).
- 8px spacing rhythm. `min-h-[100dvh]` never `h-screen`. No overlapping elements. No
  3-equal-column card rows.

### 6.6 Motion
- Micro-interactions 150–300ms, native easing; spring feel on confirmations.
- **The one hero animation:** the scan-success confirmation (subtle scale + fade check-mark).
  Invest polish here — it's the emotional payoff of the core loop. Everything else stays
  restrained. Animate transform/opacity only. Respect `prefers-reduced-motion`.

### 6.7 Required modifications to the Stitch designs
Apply these on top of the exported Stitch screens:
1. **Add an "Integrations" section** to the manager dashboard (nav item "التكاملات"): shows,
   per branch, the operating mode (Scanning / API / DB Agent), connection status, and sync
   health. For now only "المسح اليدوي (Universal Mode)" is active; API/Agent shown as
   "غير مفعّل" placeholders.
2. **Invoice amount screen (mobile) must render BOTH states:** auto-filled (green "تمت القراءة
   تلقائياً" + editable "تعديل") and manual entry (oversized monospace input). Ensure Stitch's
   version covers both, not just one.
3. **Sync status indicators** (متصل / قيد المزامنة / غير متصل) on the assistant Home and
   Transactions screens — reinforcing offline-first. Add if absent from Stitch output.
4. **RTL correctness pass:** auto-generated designs frequently mis-mirror direction. Verify
   nav rail is on the right, chevrons point right for "back", all text right-aligns, and no
   horizontal overflow on mobile.
5. **Coupon redemption screen** must prominently show the manual instruction to the cashier
   ("أبلغ الكاشير بتطبيق خصم X٪") since discounts are applied manually on the main register.

### 6.8 Screen inventory
- **Dashboard (web):** Login · Overview · Customers list · Customer detail · Loyalty Rules
  editor · Reports · Settings · **Integrations (new)**.
- **Assistant (mobile):** Login · Home (ready-to-scan) · Scan customer QR · Phone fallback ·
  Scan invoice + amount (auto/manual) · Success confirmation · Quick new-customer
  registration · Redeem coupon · Transactions history.

---

## 7. Security Standards (apply continuously)

1. **Auth:** short-lived access JWT (~15m) + rotating refresh token. Argon2 password hashing.
   Refresh tokens revocable (store hashes server-side).
2. **RBAC:** enforce roles on every endpoint (`OWNER`/`MANAGER` = dashboard;
   `ASSISTANT` = core loop + lookups only). Assistants cannot change rules or view full
   financial reports.
3. **Transport:** HTTPS/TLS only. HSTS on the dashboard. No secrets in the client bundle.
4. **Input validation:** Zod on every request body/param/query. Reject unknown fields.
5. **Idempotency & fraud:** DB unique constraint on (merchant_id, branch_id, invoice_id);
   API returns 409 on replay. Coupons single-use via atomic state transition. Rate-limit
   `/transactions`, `/auth/*`, `/customers/resolve`.
6. **Secrets:** environment variables via a validated config module; never hardcoded. Provide
   `.env.example`. Keep real secrets out of the repo and out of logs.
7. **SQL safety:** Prisma parameterized queries only; no raw string interpolation.
8. **Mobile secret storage:** `expo-secure-store` for tokens; never AsyncStorage for secrets.
9. **QR safety:** signed opaque token, not raw PII. Validate signature server-side on resolve.
10. **Audit trail:** append-only `audit_log` for rule changes, redemptions, manual amount
    entries, customer edits. Never mutate audit rows.
11. **PII discipline:** phone is the only required identifier. No sensitive categories stored.
12. **Least privilege everywhere:** DB roles, API scopes, and (future) Local Agent all
    read/write only what they must.

---

## 8. Performance & Reliability Standards

- **Core-loop latency:** the online `POST /transactions` round-trip target < 800ms on a
  normal connection; the on-device confirmation must feel **instant** (write local first,
  reconcile in background).
- **Offline resilience:** every assistant operation succeeds offline and syncs later. No data
  loss on connection drop. The device is the temporary source of truth until synced.
- **Sync correctness:** batch sync is idempotent per item; partial failures don't corrupt the
  queue; the device clears only confirmed items.
- **Dashboard:** cache cumulative balances per period for list/overview speed; keep the
  computed value authoritative.
- **Images/assets:** WebP/vector; reserve layout space (CLS < 0.1).
- **Indexes:** index the hot paths — `customer.phone`, `customer.qr_token`,
  `transaction (branch_id, invoice_id)`, `transaction.customer_id`, `coupon.customer_id`,
  `coupon.status`.

---

## 9. Coding Standards

- **TypeScript strict** across all apps. No `any` without a written justification comment.
- Shared types live in `packages/shared-types` and are imported — never duplicated.
- **Validation at boundaries** (API in/out, form in) with Zod; infer TS types from Zod schemas.
- Errors: typed, meaningful, never swallowed. API returns consistent error envelopes.
- Naming: descriptive; Arabic UI copy in centralized locale files, not scattered in JSX.
- Commits: small, focused, conventional (`feat:`, `fix:`, `chore:` …).
- No dead code, no commented-out blocks left behind, no TODOs without an issue reference.
- Environment: everything runnable via documented `pnpm` scripts from the repo root.

---

## 10. Testing & Definition of Done

A feature is **done** only when:
1. It builds with no type errors and no lint errors.
2. It runs and was manually exercised (evidence, not assumption).
3. Core business logic has tests: **idempotent linking**, **threshold→coupon issuance**,
   **coupon single-use**, **cumulative balance computation**, **offline sync reconciliation**.
4. Security checks for the touched surface are in place (auth, validation, rate limit,
   idempotency where relevant).
5. RTL and both connection states (online/offline) are verified for touched screens.
6. It's documented where a future reader needs it (env vars, non-obvious decisions).

**Never claim completion without running the verification.** If you cannot run something,
say so explicitly and describe exactly what remains unverified.

---

## 11. What NOT to do (anti-patterns)

- Do not allow scanning an invoice before a customer is selected.
- Do not permit a duplicate invoice to create a second transaction.
- Do not store money as floats. Do not store PII in the QR. Do not log secrets or tokens.
- Do not build the Local DB Agent now, and never present direct DB access as automatically
  legal/safe.
- Do not use Inter, serif fonts, pure black, neon glows, emojis-as-icons, circular spinners,
  or 3-equal-column card rows.
- Do not centralize business logic in the UI; keep it in the API/services.
- Do not mark work complete without verification.
- Do not over-build multi-tenancy — only the `merchant_id` isolation seam for now.

---

## 12. Glossary

- **Core loop** — scan customer → scan invoice → link → notify.
- **Normalized Invoice Schema** — the single invoice data contract (§2.3).
- **Universal Mode** — the scanning tier that needs no accounting integration (what we build now).
- **Integration Gateway** — the ingestion boundary where all invoice sources normalize.
- **Threshold / Tier** — spend level that earns a discount.
- **Coupon** — auto-issued single-use discount with an expiry.
- **Override rule** — per-customer or per-category rule that supersedes the default.

---

## 13. Decision Log

Material decisions made during the build that §1–§12 did not already settle. Later
sessions inherit these — do not re-litigate them without a reason, and append here when
you make a new one.

### 13.1 Loyalty periods — fixed calendar window, shared by all customers
*(confirmed by the operator, 2026-08-24; implemented Phase 0)*

A loyalty period is a **fixed calendar window every customer shares**, and cumulative
spend **resets to zero at each boundary**. Everyone on a MONTHLY rule set resets together
on the 1st. Chosen over a rolling per-customer window because a shop owner can explain it
to a customer in one sentence, and because it makes `period_key` a stable, sortable,
cacheable string.

`period_key` formats: `2026-08` (MONTHLY) · `2026-W35` (WEEKLY, ISO week) ·
`custom:2026-08-01..2026-08-31` (CUSTOM).

**Boundaries are computed in the merchant's local timezone, never UTC.** A purchase at
01:00 on 1 September in Baghdad is 22:00 on 31 August UTC; bucketing that in UTC files it
under the wrong month and silently corrupts the reset. Hence `merchant.timezone`
(default `Asia/Baghdad`). Timestamps are still *stored* in UTC per §4.2 — only the
bucketing is local.

Implementation: `computePeriodKey()` in `packages/shared-types/src/period.ts`. It is pure
and deterministic so the offline assistant app and the server always agree.

### 13.2 Multi-tier issuance — one coupon per tier per period, higher supersedes lower
*(confirmed by the operator, 2026-08-24)*

Each tier fires **at most once per customer per period**. Crossing a higher tier
**supersedes** the coupon from a lower one: the old ACTIVE coupon transitions to
`SUPERSEDED` and the new one is issued. A customer therefore holds **at most one active
earned coupon**, and discounts never stack.

`SUPERSEDED` is a distinct status rather than reusing `EXPIRED` so the audit trail records
*why* a coupon stopped being usable.

Enforced in the database, not only in service code: `@@unique([customerId, periodKey,
sourceThresholdAmount])` on `coupon`. Two concurrent links that both cross the same
threshold cannot mint two identical coupons.

**Clarification (Phase 1):** superseding is scoped to **one period**. A still-valid
coupon earned in a previous period is never retired by this period's crossing — that
spend was different spend, and confiscating a reward already given would read to the
customer as the shop taking something back. So a customer may briefly hold last
period's unexpired coupon alongside this period's new one. Within a single period they
hold at most one earned coupon, which is what stops discounts stacking.

### 13.3 Override rules — most specific wins, and an override replaces the whole ladder
*(reversible call, noted 2026-08-24)*

Resolution order: **CUSTOMER override → CATEGORY override → merchant default rule set.**
Since `customer_override_rule` carries a single tier (not a list), an override **replaces
the entire default ladder** with that one tier rather than shifting one rung of it.
`EffectiveRules.origin` reports which layer supplied the rules, so the customer detail
screen can show it.

### 13.4 Phone numbers normalise to E.164 on write
*(reversible call, noted 2026-08-24)*

Input accepts every shape a human or keypad produces (`07701234567`, `7701234567`,
`+9647701234567`, `009647701234567`, with spaces/dashes); storage is always E.164
(`+9647701234567`). The per-merchant UNIQUE constraint on `customer.phone` is only
meaningful if every write normalises first — otherwise one human becomes two accounts.

Implementation: `normalizePhone()` / `PhoneInputSchema` in
`packages/shared-types/src/phone.ts`. Validation is deliberately **not** restricted to
today's carrier prefixes (075/077/078/079): new ranges get allocated, and rejecting a real
customer at the register is the worse failure.

### 13.5 Money is `Int`, with a documented bound
*(reversible call, noted 2026-08-25)*

Money stays a plain integer `number` (whole IQD) rather than `BigInt`. Every per-row money
value here is bounded: a single invoice, a tier threshold, and a customer's cumulative
spend *within one period* all sit far below Int32 (2,147,483,647 IQD ≈ 40× an extreme
wholesale month). This avoids a BigInt serialisation tax across TS/Zod/JSON on the core
loop.

**The one exception:** an all-time `SUM` across every transaction in a report query is
*not* bounded. Those aggregates MUST cast to `BIGINT` in SQL before summing. Any report
added in Phase 2 or 5 has to honour this.

### 13.6 Invoice barcode parsing is pluggable, built against a reconstructed receipt
*(open — still needs a real sample from the merchant)*

The register's barcode encoding is unknown (no sample receipt as of 2026-08-25), so
parsing goes through an `InvoiceBarcodeParser` interface
(`packages/shared-types/src/invoice.ts`). A parser always returns the invoice number and
returns the amount **only** when the symbology actually carries it; `amount: null` forces
manual entry. This is why the invoice screen must render both states (§6.7 #2).

**Reference fixtures** live in `design/receipts/` — reconstructed 80 mm thermal receipts
at true POS geometry (72 mm printable, 203 dpi, 576 dots, 1-bit) carrying real,
checksummed Code 128 symbols. `verify-barcode.mjs` decodes them back out of the rendered
pixels, so the fixtures are proven scannable rather than merely decorative.

Two parsers ship, tried most-specific first
(`packages/shared-types/src/invoice-parsers.ts`):

| Parser | Payload | Amount |
|---|---|---|
| `pipe-delimited` | `INV-9824\|85000` | auto-captured |
| `invoice-number-only` *(default)* | `INV-9824` | `null` → manual entry |

Two rules bind every parser, now and later:

1. **The invoice number is mandatory; the amount is not.** `amount: null` is a normal
   result, not a failure.
2. **A doubtful amount is worse than no amount.** A wrong amount silently corrupts a
   customer's balance; a null one merely costs four keystrokes. Never guess.

**Still needed:** one real receipt photo. The likely outcome is that one of the two
parsers already matches; if not, the real format is one more parser and no other change.

### 13.7 Toolchain choices
*(all reversible; noted 2026-08-25)*

| Choice | Why |
|---|---|
| **Zod 3.24** (not 4.x) | Broadest compatibility with `fastify-type-provider-zod`, `@hookform/resolvers` and shadcn examples. Revisit if a Zod 4 feature is needed. |
| **Tailwind 3.4** (not 4.x) | The well-trodden path for shadcn/ui, which §3.3 mandates. |
| **`@node-rs/argon2`** (not `argon2`) | Same Argon2id algorithm, but ships prebuilt binaries. The `argon2` package needs node-gyp and Visual Studio build tools on Windows. |
| **Postgres on host port 5433** | Another project's Postgres already owns 5432 on the dev machine. Container-side port is unchanged. |
| **Extensionless relative imports** | `moduleResolution: "Bundler"` throughout. Neither webpack (Next) nor Metro (Expo) maps `./foo.js` back to `foo.ts`, so `.js` suffixes break the shared packages at build time. **Consequence:** `apps/api` must be bundled for production (tsup/esbuild in Phase 1), not run as raw ESM under plain node. |
| **`declaration: false` in the app tsconfig presets** | Apps never emit `.d.ts`. Leaving it on makes TS demand portable names for inferred types, which fails (TS2742) under pnpm's isolated store when React 18 (Expo) and React 19 (Next) coexist. |
| **`dotenv-cli` for Prisma scripts** | The Prisma CLI only looks for `.env` beside the schema. One `.env` at the repo root stays the single source of secrets; `dotenv -e ../../.env --` hands it over. |

### 13.8 Known deferred items

- **`package.json#prisma` seed config is deprecated** and will be removed in Prisma 7.
  It works on 6.19 but prints a warning on every command. Migrate to `prisma.config.ts`
  before upgrading to Prisma 7.
- **Fonts are loaded from Google Fonts** in the dashboard. Self-host before production so
  the register is not dependent on an outbound CDN.
- **`apps/assistant` bundles no font files yet.** Phase 3 must bundle Cairo, IBM Plex Sans
  Arabic and IBM Plex Mono; until then RN falls back to the system Arabic face and money
  uses `fontVariant: ['tabular-nums']` for digit alignment.

### 13.9 Backend engineering decisions (Phase 1)
*(all reversible unless noted; recorded 2026-08-26)*

**The core loop runs at SERIALIZABLE isolation.** Read Committed would let two
concurrent links for the same customer each compute a cumulative sum missing the
other's uncommitted row. A duplicate coupon is already impossible (unique
constraint), but a *missed* threshold crossing is not — and a customer silently not
receiving the discount they earned is the worst failure this system has. Register
volume makes the isolation cost negligible; `withSerializableRetry` absorbs the
occasional 40001 conflict.

**Auth is opt-OUT, not opt-in.** A global `onRequest` hook authenticates every
request; only an explicit `config.public` marker skips it. A route added later
without thinking about auth is therefore protected by default. The failure mode of
the opposite arrangement is a silently public endpoint — the bug nobody notices
until it matters. A side effect: an unknown path returns 401 rather than 404 to an
unauthenticated caller, which also denies route enumeration.

**Refresh tokens are opaque randoms, not JWTs**, stored only as SHA-256 hashes, and
they rotate on every use. Reuse of an already-rotated token revokes the entire chain:
a replay is indistinguishable from a theft, and losing a session is a nuisance while
leaving a stolen token live is not. SHA-256 rather than Argon2 is deliberate — the
input is 48 bytes of full-entropy random, so there is no low-entropy secret to slow a
guesser down for.

**Coupon redemption is one atomic conditional UPDATE**, with every precondition in
the WHERE clause (`status = ACTIVE AND expiresAt > now`). A read-then-write would let
two cashiers both apply the same discount. Folding expiry into the same statement
matters too: the expiry sweep may not have run, and a lapsed coupon must not be
redeemable in that window.

**Notifications use a database-backed queue, not BullMQ + Redis** (§3.2 permits
this). The deciding reason is not avoided infrastructure but atomicity: the enqueue
joins the same transaction as the link it belongs to, so a committed transaction can
never be missing its notification, and a rolled-back one can never have sent a
phantom message. Cost: delivery needs a poller rather than a blocking pop. Revisit if
this becomes multi-merchant with real throughput.

**Rate limiting is in-process memory**, so limits are per-instance. Correct for a
single-instance deployment, wrong the moment it scales horizontally — switch to the
Redis store when a second instance appears. The limiter's `errorResponseBuilder` MUST
carry `statusCode: 429`: @fastify/rate-limit *throws* that object, and without the
status the error handler cannot distinguish a throttle from an unknown failure and
answers 500, which tells the client to retry exactly when it should back off.

**A duplicate is detected before insert, not only by catching the constraint.**
Postgres aborts an entire transaction when any statement in it fails, so after a
unique violation nothing further can be queried on that connection — including the
lookup naming who already holds the invoice. The common case is therefore a
pre-check inside the transaction; the genuine race throws a sentinel that the caller
re-queries after the transaction unwinds.

**Branch is verified, not trusted.** The Normalized Invoice Schema carries
`branch_id` because a future API-tier source legitimately declares its own, but a
bound user must match it. Otherwise an assistant at one branch could attribute sales
to another — both a fraud vector and a reporting mess. An OWNER is unbound and may
link anywhere.

**Tests run against a separate `walaa_test` database** and TRUNCATE between cases.
Pointing that at the dev database would destroy it, so the isolation is a safety
property rather than a convenience. Rate limiting is disabled in the general HTTP
suite (it would otherwise exhaust one shared login bucket mid-file) and covered by
its own suite with limiting left on.

### 13.10 Offline licensing — decided in Rust, enforced in the service
*(operator decisions, 2026-09-14; shipped in 0.3.0. Full account: `packaging/LICENSING.md`)*

**Where it runs.** Codes are Ed25519-signed JSON verified by `crates/walaa-license`,
compiled into a Node module the API loads (`@walaa/license-native`) with the provider's
public key embedded as a constant. The issuer (`tools/license-issuer`) is never shipped.
The UI decides nothing; it reads `GET /license`.

**Read-only refuses exactly three things**, in the service functions so the offline
sync replay meets the same gate: `scanCard` (a sale), `createCustomer`, `redeemVoucher`.
Capture, card batches, reports, exports, backups and restores stay open — a merchant's
data is never withheld. A queued sync item refused this way is FAILED, so the Station
keeps it and sends it again after activation.

**The clock.** The latest time seen is kept in three places (`installation_state`,
`HKCU\Software\Walaa`, `.license-clock` in the data folder); a clock more than two
hours behind it is TAMPERED until corrected, then clears by itself. A freshly issued
code resets a recorded time that lies after its issue. Perpetual licences ignore the
clock — there is no expiry to stretch.

**Nothing ordinary loses a licence.** The device ID is stored on first computation; a
changed source is an audit warning. Activated codes are mirrored to
`license-codes.json` beside the anchor, so restoring an older database puts them back.

**Two deviations from the brief, both forced:** the device ID is base-30, not Base32 —
excluding six of 32 symbols leaves 30; and only the Drive *upload* needs `drive_backup`,
because gating restore would strand a merchant replacing a dead PC.

**The honest limit.** The gate is JavaScript in the API bundle. An administrator who
edits that bundle bypasses it; the signature, device and clock checks raise the cost of
cheating, they do not make it impossible. `pnpm package:installer` refuses a build that
embeds the development key (`verify-license-key.mjs`).
