# ولاء — Walaa

A post-purchase loyalty platform for a supermarket. Customers earn a discount on their
next visit once cumulative spend within a period crosses a merchant-defined threshold.
The system attributes anonymous printed invoices to known customer accounts.

**The core loop:** scan customer QR → scan invoice barcode → link → notify.

> `CLAUDE.md` is the single source of truth for architecture, design and standards.
> `PROMPT.md` defines the build phases. Read both before changing anything.

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | Monorepo, shared contracts, Prisma schema + migration, dev seed | ✅ Done |
| 1 | Fastify API — auth, customers, core loop, coupons, rules, sync | Not started |
| 2 | Manager dashboard (Next.js) | Not started |
| 3 | Cashier assistant (Expo) | Not started |
| 4 | Notifications & coupon lifecycle | Not started |
| 5 | Hardening | Not started |

## Requirements

- **Node** ≥ 20.11 (developed on 24.13)
- **pnpm** 10.x
- **Docker** — for the local Postgres

## Setup

```bash
pnpm install
```

```bash
cp .env.example .env
```

Then fill in the three secrets in `.env`. Generate each with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` and `QR_TOKEN_SECRET` must each be a distinct
value. The config module refuses to boot if any is missing, under 32 characters, or still
the `replace-me` placeholder.

> **`QR_TOKEN_SECRET` is effectively permanent.** Rotating it invalidates every QR code
> already sent to a customer.

Start the database and apply the schema:

```bash
pnpm db:up && pnpm db:migrate && pnpm db:seed
```

Postgres binds to **host port 5433**, not 5432 — see `CLAUDE.md` §13.7.

## Everyday commands

Run from the repo root.

| Command | Does |
|---|---|
| `pnpm dev` | Runs every app's dev server |
| `pnpm build` | Production build, all packages |
| `pnpm typecheck` | Strict TypeScript across the workspace |
| `pnpm test` | All tests |
| `pnpm db:up` / `pnpm db:down` | Start / stop Postgres |
| `pnpm db:migrate` | Create and apply a migration |
| `pnpm db:seed` | Load the Iraqi dev fixtures (re-runnable) |
| `pnpm db:reset` | Drop, re-migrate and re-seed |
| `pnpm db:studio` | Prisma Studio |
| `pnpm --filter @walaa/api db:verify` | Assert the Phase 0 data invariants |

## Dev credentials

Created by the seed. **Development only** — production users are created through the API.

| Username | Role | Name |
|---|---|---|
| `owner` | OWNER | مصطفى الجبوري |
| `manager` | MANAGER | سارة العبيدي |
| `assistant` | ASSISTANT | حيدر الموسوي |

Password for all three: `Walaa!Dev2026`

## Layout

```
apps/
  api/          Fastify service + Prisma schema, migrations, seed
  dashboard/    Next.js manager dashboard (RTL)
  assistant/    Expo cashier app (RTL, offline-first)
packages/
  shared-types/ Normalized Invoice Schema, DTOs, enums — imported everywhere
  config/       tsconfig / eslint / tailwind presets + design tokens
  ui/           Shared UI primitives (grown in Phase 2)
design/
  stitch/       Vendored Stitch design exports — the layout source of truth
```

## The two rules that are not negotiable

1. **Customer identity is captured before the invoice.** There is no code path that links
   an invoice without a resolved customer — `LinkTransactionRequest.customerId` is
   non-nullable by design, so the loop order is enforced by the type system rather than by
   a UI guard alone.
2. **The same invoice can never be linked twice.** Guarded at the API *and* by a database
   `UNIQUE (merchant_id, branch_id, invoice_id)` constraint. `pnpm --filter @walaa/api
   db:verify` proves the database itself refuses a replay.

## Security notes

- `.env` is gitignored. Never commit real secrets; `.env.example` is the template.
- Customer QR codes carry a **signed opaque token**, never a phone number or any PII.
- Money is stored as whole-dinar integers, never floats. See `CLAUDE.md` §13.5 for the
  Int32 bound and the one place aggregates must cast to `BIGINT`.
- Phone numbers normalise to E.164 on write so the per-merchant unique constraint holds.
