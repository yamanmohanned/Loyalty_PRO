# V3-0 Audit — Repository Summary

Read-only audit of `E:\loyalty` ahead of the v3 instant-discount pivot.
Produced 2026-08-27. No code was modified.

## Measured state

| Metric | Value |
|---|---|
| Source lines (TS/TSX/Prisma, excl. node_modules) | 8,993 |
| Passing tests | **108** (80 `apps/api`, 28 `packages/shared-types`) |
| Packages typechecking clean | 4 of 5 |
| Packages failing | **`@loyalty-pro/dashboard`** — `Cannot find module 'zod'` |
| Lint | 5 of 5 clean |
| Git commits | 9, all pushed to `github.com/yamanmohanned/Loyalty_PRO` |
| Uncommitted files | 14 (reports endpoints + v2/v3 spec files) |

## Phase completion, honestly

**Phase 0 (Foundation) — COMPLETE, verified.** Monorepo, shared contracts, Prisma
schema (13 tables, 33 indexes), first migration, Iraqi seed, RTL app shells.

**Phase 1 (Backend core) — COMPLETE, verified.** Fastify service: auth/RBAC/refresh
rotation, customers, the idempotent core loop at SERIALIZABLE isolation, coupon
engine, rules admin, offline sync, audit log. 80 tests. A live end-to-end run was
demonstrated against the running server.

**Phase 2 (Manager Dashboard) — ~15% COMPLETE, currently BROKEN.**

Built and working:
- `src/lib/locale.ts` (247 lines) — complete Arabic copy for all eight screens
- `src/lib/session.ts` (86) — httpOnly cookie session handling
- `src/lib/server-api.ts` (106) — server-side API client with transparent refresh
- Three Next.js route handlers (117 lines): login, logout, catch-all authenticated proxy
- `layout.tsx` + `globals.css` — RTL document shell, token-wired
- **API reports layer** — `reports.service.ts` (428 lines), `reports.routes.ts` (94),
  10 tests, all green. This was Phase 2 backend work and it is genuinely done.

NOT built — **zero of the eight screens exist**:
Overview, Customers list, Customer detail, Rules editor, Reports, Settings,
Integrations, Login. `page.tsx` is still the Phase 0 foundation smoke page.
No UI primitives, no nav rail, no charts, no TanStack Query provider, no forms.

Broken: dashboard dependencies were never installed — `pnpm install` failed because
the C: drive is full. `@loyalty-pro/dashboard#typecheck` fails today.

## Structural finding that changes the plan

**`apps/manager-desktop` does not exist.** CLAUDE_v3 §1 classifies it as KEEP with
"v2 conversion stands entirely". In fact the build followed **v1** from Phase 0
through Phase 2 and produced a Next.js `apps/dashboard`. The v2 Tauri conversion was
specified but never performed. Phase V3-3 is therefore *"do the v2 conversion AND
apply v3 changes"*, not *"update the existing Tauri app"* — materially more work.

## Toolchain readiness for v3

| Requirement | State |
|---|---|
| .NET SDK (Print Capture Agent) | ✅ 9.0.311 and 10.0.102 installed |
| Visual Studio 2022 (MSVC for Rust) | ✅ present |
| **Rust / cargo (Tauri)** | ❌ **not installed** |
| **Free space on C:** | ❌ **146 MB** — Rust needs ~2 GB |
| Node 24 / pnpm 10 | ✅ |
| Postgres (to be retired) | running in Docker on :5433 |

## Assets whose value increased under v3

- `design/receipts/` — the reconstructed 80 mm thermal receipt, its real Code 128
  encoder, and `verify-barcode.mjs` (a from-pixels decoder). Built in Phase 1 as a
  barcode-parser fixture; under v3 this is a **ready-made test fixture for the Print
  Capture Agent parsing pipeline** (§4.5).
- `packages/shared-types/src/invoice-parsers.ts` — the pluggable
  `InvoiceBarcodeParser` pattern maps almost directly onto v3's external
  `pos-template.json` requirement (§4.5 #3).
- `packages/shared-types/src/period.ts` — timezone-correct period bucketing. v3 §5.3
  keeps derived balances, so this survives untouched.
