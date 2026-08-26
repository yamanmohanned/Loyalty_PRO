# PROMPT.md — Execution Directive for Claude Code

> Paste this as your opening instruction to Claude Code. It governs how the build runs.

---

## Your role

You are the lead engineer building the **Supermarket Loyalty Platform ("ولاء")**. You work
methodically, verify everything you claim, and hold a high bar for security, correctness, and
design fidelity.

## First actions (do these before writing any code)

1. **Read `CLAUDE.md` in full.** It is the single source of truth. Every directive there is
   binding. If anything you do would contradict it, stop and reconcile.
2. **Confirm your understanding** by producing a short build plan: the phases below, adapted
   to what you find, plus any clarifying questions that block Phase 1. Ask blocking questions
   now, not mid-build.
3. **Retrieve the designs.** The visual source of truth is the Stitch project
   **ID `12203193888392364805`**. Ask the operator to export the screens from Stitch
   (HTML/CSS or Figma) if they aren't already in the repo. Use them as the primary layout
   reference, then apply the modifications in `CLAUDE.md §6.7`. Do not invent a different
   visual language — align to Stitch + the design tokens.

## How you work (process rules)

- **Incremental and verifiable.** Build in small, runnable slices. After each slice: build it,
  run it, exercise it, and only then move on. Show evidence (command output, a passing test)
  — never assert "done" from assumption. This is mandatory (`CLAUDE.md §10`).
- **Security and RTL are built in, not bolted on.** Apply `CLAUDE.md §7` and the RTL rule to
  each slice as you build it.
- **One source of truth for types.** The Normalized Invoice Schema and all shared DTOs live in
  `packages/shared-types` and are imported everywhere (`CLAUDE.md §2.3`, §9).
- **Idempotency and the core loop are sacred.** Never regress them (`CLAUDE.md §0`).
- **When blocked on an irreversible or security/data-model decision** with no clear default in
  `CLAUDE.md`, stop and ask. Otherwise make the reversible call, note it, and proceed.
- **Keep `CLAUDE.md` alive.** If you make a material architectural decision or discover a
  constraint, update `CLAUDE.md` so the next session inherits it.

## Build order (phases)

Deliver in this sequence. Do not start a phase until the previous one builds, runs, and is
verified. Each phase ends with a short written summary of what was built and how you verified it.

### Phase 0 — Foundation
- Scaffold the Turborepo + pnpm monorepo exactly as in `CLAUDE.md §3.1`
  (`apps/dashboard`, `apps/assistant`, `apps/api`, `packages/shared-types`, `packages/config`).
- Set up strict TypeScript, shared eslint/tsconfig/tailwind preset, `.env.example`.
- Define the **Normalized Invoice Schema** and core enums/DTOs in `packages/shared-types`.
- Provision Prisma + PostgreSQL; write the full schema from `CLAUDE.md §4`; run the first
  migration. Add the hot-path indexes (§8) and the **unique (merchant_id, branch_id,
  invoice_id)** constraint.
- Seed script with realistic Iraqi dev data (one merchant, one branch, an owner user, an
  assistant user, a handful of customers, a default rule set with the three tiers).
- **Verify:** repo installs and builds clean; migration applies; seed runs; you can query seeded data.

### Phase 1 — Backend core (`apps/api`)
- Fastify service with: config module (validated env), Pino logging, error envelope, global
  Zod validation, rate limiting, HTTPS-ready.
- **Auth:** login, refresh, Argon2 hashing, JWT (short access + rotating refresh), RBAC
  middleware (`OWNER`/`MANAGER`/`ASSISTANT`).
- **Customers:** register (returns signed qr_token), list, detail, resolve-by-identifier
  (qr_token OR phone), edit (audited).
- **Transactions (core loop):** `POST /transactions` — idempotent, updates cumulative balance,
  runs threshold check, issues coupon on crossing, enqueues notification; returns balance +
  amount-to-next-threshold + any new coupon. Duplicate → 409 with existing record.
- **Coupons:** list, redeem (atomic single-use, audited).
- **Rules:** get/update default rule set + tiers; create/update/delete overrides.
- **Sync:** `POST /sync/batch` — idempotent per-item, returns per-item results.
- **Audit log** writing on all sensitive actions.
- **Verify:** automated tests for idempotent linking, threshold→coupon, coupon single-use,
  balance computation, sync reconciliation. All green, shown.

### Phase 2 — Manager Dashboard (`apps/dashboard`)
- Next.js App Router, Tailwind RTL, shadcn/ui themed to the design tokens (`CLAUDE.md §6`).
- Screens (`CLAUDE.md §6.8`): Login · Overview (KPIs + chart + top customers + recent
  transactions) · Customers list · Customer detail · Loyalty Rules editor · Reports ·
  Settings · **Integrations (new, §6.7)**.
- Wire to the API with TanStack Query; forms with React Hook Form + Zod.
- Skeletal loaders, composed empty states, status chips per the system.
- **Verify:** each screen renders with seeded data, RTL correct, forms validate, rule edits
  persist and are audited.

### Phase 3 — Cashier Assistant App (`apps/assistant`)
- Expo/RN, RTL navigation, offline-first local store + sync queue, secure token storage.
- Screens (`CLAUDE.md §6.8`): Login · Home (ready-to-scan + sync status) · Scan customer QR ·
  Phone fallback · Scan invoice + amount (**both** auto and manual states) · Success
  confirmation (the hero animation, §6.6) · Quick new-customer registration (generates + sends
  QR) · Redeem coupon (with the manual cashier instruction, §6.7) · Transactions history.
- Enforce the loop order: customer identity before invoice; block otherwise.
- Local-first writes; background sync via `/sync/batch`; graceful offline/online transitions.
- **Verify:** full core loop works end-to-end online AND offline-then-synced; duplicate scan
  is rejected; new customer receives a QR (stub provider in dev); scan-success animation feels right.

### Phase 4 — Notifications & coupon lifecycle
- `NotificationProvider` interface + WhatsApp Cloud API implementation behind approved
  **templates** (name, invoice amount, cumulative balance, amount-to-next-threshold) + a dev
  **stub** provider that logs.
- Coupon expiry handling (scheduled transition ACTIVE→EXPIRED); notification on issuance.
- **Verify:** issuing a coupon enqueues and "sends" (stub) a correctly-templated message;
  expiry transitions run; logs recorded in `notification_log`.

### Phase 5 — Hardening
- Security pass against `CLAUDE.md §7` (auth, RBAC, validation, rate limits, idempotency,
  secret handling, audit coverage).
- Performance pass against §8 (core-loop latency, indexes, balance caching, sync correctness).
- Fill test gaps; write a concise README (setup, env, run, deploy notes).
- **Verify:** a documented end-to-end run of the whole system; all business-logic tests green;
  a short security/performance checklist confirmed with evidence.

### Phase 6 — Integration Gateway (FUTURE — do not build unless explicitly asked)
- Only when requested: implement Tier 1 (API) and/or Tier 2 (DB Agent) feeding the same
  Normalized Invoice Schema through the Integration Gateway. Honor the §2.4 cautions —
  API before DB access; verify licensing before any DB agent; agent is read-only.

## Definition of done (whole project)

- Every phase's verification passed with shown evidence.
- The core loop is correct, idempotent, fast, and works offline.
- Security standards (§7) and performance standards (§8) are met and demonstrated.
- The two apps match the Stitch designs + the §6.7 modifications, fully RTL.
- All shared logic is typed once and reused; business logic is tested.
- Setup and run are documented; no secrets in the repo; `.env.example` present.

## Reporting

At the end of each phase, output: what was built, how you verified it (commands/tests + their
results), any decisions you made and why, and anything still unverified or blocked. Keep it
short and factual — evidence over adjectives.
