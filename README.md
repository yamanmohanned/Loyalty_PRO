# Loyalty Pro — ولاء

A retail loyalty platform for a supermarket: a staged loyalty **journey** that rewards
a customer for coming back, a product **catalogue**, a QR-opened **storefront**, a live
**orders station** for staff, and a manager who can change almost all of it without a
developer.

**The core loop, unchanged:** scan the customer's card → read the invoice → link →
print the receipt.

> **This repository is a fork, not an upgrade.** It was copied from the frozen «ولاء»
> line at tag `walaa-frozen-0.3.1`, and every identifier Windows keys on — service
> name, install directory, data directory, database filename, registry anchor, port,
> update feed — was changed in one commit so both products can be installed on the same
> machine without touching each other. The frozen line is never modified from here.
> `packaging/scripts/verify-identity.mjs` fails the build if any of its identifiers
> comes back.

## What governs what

| File | Governs |
|---|---|
| `docs/PRD.md` | The product being built: the journey, catalogue, storefront, orders, the Hub, the roadmap P0–P6 |
| `CLAUDE.md` | Architecture, design system, security and coding standards — and the decision log |
| `docs/fork-study.md` | What the PRD asked for measured against the code that existed, and the two hazards its rename list missed |
| `docs/legacy/` | The frozen line's own documents. Read-only history; naming «ولاء» is what they are for |

## Requirements

- **Node** ≥ 20.11
- **pnpm** 10.x
- **Rust** stable — the licensing crate and the Windows service host
- **Windows** for the full product; the API and its tests run anywhere

## Setup

```bash
pnpm install
```

```bash
cp .env.example .env
```

Fill in the four secrets. Generate each with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` and `QR_TOKEN_SECRET` must each be distinct,
and `BACKUP_KEY` is 32 random bytes in base64. The config module refuses to boot on a
missing, short or placeholder value.

> **`QR_TOKEN_SECRET` is effectively permanent.** Rotating it invalidates every card
> already printed.

Then generate the Prisma client and the artifacts the suite needs:

```bash
pnpm db:generate
```

```bash
pnpm --filter @loyalty-pro/api db:template && pnpm --filter @loyalty-pro/station build
```

The second line is not optional for a green test run: `supersede-database.test.ts`
needs the shipped database template, and `rbac-matrix.test.ts` needs the Station bundle
because the API only registers its static routes when one exists.

## Everyday commands

Run from the repo root.

| Command | Does |
|---|---|
| `pnpm dev` | Every app's dev server (API 4100, manager 5183, station 5184) |
| `pnpm build` | Production build, all packages |
| `pnpm typecheck` | Strict TypeScript across the workspace |
| `pnpm lint` | ESLint across the workspace |
| `pnpm test` | The identity guard, then all tests |
| `pnpm verify:identity` | Just the identity guard — proves no frozen-line identifier survives |
| `pnpm db:generate` | Regenerate the Prisma client |
| `pnpm db:migrate` | Create and apply a migration |
| `pnpm db:seed` | Load the Iraqi dev fixtures (re-runnable) |
| `pnpm db:studio` | Prisma Studio |

Install the schema-fingerprint hook once per clone:

```bash
git config core.hooksPath .githooks
```

## Dev credentials

Created by the seed. **Development only.**

| Username | Role | Name |
|---|---|---|
| `owner` | OWNER | مصطفى الجبوري |
| `manager` | MANAGER | سارة العبيدي |
| `assistant` | ASSISTANT | حيدر الموسوي |

Password for all three: `Walaa!Dev2026`

## Layout

```
apps/
  api/              Fastify service, Prisma schema + migrations, seeds, the test suite
  manager-desktop/  Tauri 2 + Vite + React — the manager's desktop app (RTL)
  station/          The Loyalty Station — a browser app the API serves on its own port
packages/
  shared-types/     The invoice contract, DTOs, period and phone rules — imported everywhere
  config/           tsconfig / eslint / tailwind presets
  license-native/   The API's native licensing module (Rust → Node)
crates/
  loyalty-pro-license/  Offline licensing: device identity, signed codes, clock anchors
packaging/
  service-host/     The Windows Service host, in Rust
  scripts/          Staging, verification and the identity guard
agent/              The .NET print-capture agent, inherited unchanged
tools/
  license-issuer/   Holds the private key. Never shipped.
docs/
  PRD.md            The product specification
  legacy/           The frozen line's documents, read-only
```

## Before this ships

Two things are deliberately unfinished, and both block a merchant install rather than
development:

1. **The auto-updater is off.** It arrived from the frozen line pointing at that line's
   release feed with that line's signing key — which would have updated this product
   into the other one. Turning it on needs a new minisign keypair. See `CLAUDE.md`
   §13.15.
2. **The licence key is still the frozen line's.** `pnpm package:installer` now refuses
   to build an installer with it. The provider generates this product's own keypair
   with `license-issuer keygen`. See `packaging/LICENSING.md`.

## The rules that are not negotiable

1. **Customer identity is captured before the invoice.** No code path links an invoice
   without a resolved customer.
2. **The same invoice can never be counted twice** — guarded at the API and by a
   database constraint.
3. **A coupon is redeemed once**, by one atomic conditional update, even from two
   stations at the same instant.
4. **The loyalty event log is append-only.** Customer state is derived from it and can
   be rebuilt.
