# Facts kept in more than one place

Every constant, hash, manifest, version and duplicated literal in this repository that
is maintained by hand and can go stale without anything failing at the time.

**Why this file exists.** `EXPECTED_MIGRATIONS_FINGERPRINT` and `EXPECTED_SCHEMA_HASH`
shipped once as placeholder values nobody had ever generated — a guard that, in
production, would have refused every merchant's perfectly correct database. The
instance was easy to fix. The *shape* of it is not: a value that must be kept in step
with something else by memory fails at the worst possible moment, which is on somebody
else's machine, hours from anyone who could see why.

So the list is complete and the work is not. **Automated: anything whose staleness can
break a merchant's install or stop two machines talking to each other.** Everything else
is written down here and left alone deliberately — its staleness costs a wrong label or
an untidy log, and spending the night on it would have been the wrong trade.

---

## Automated — staleness breaks an install or a connection

| Fact | Kept in | Guarded by |
|---|---|---|
| **Schema fingerprints** — `EXPECTED_MIGRATIONS_FINGERPRINT`, `EXPECTED_SCHEMA_HASH` | `apps/api/src/config/schema-fingerprint.ts`, derived from `apps/api/prisma/migrations/` | `db:template:check` (recomputes and refuses), `db-template.test.ts`, `.githooks/pre-commit` (also checks the *index*, not just the working tree), head of `pnpm package:build` |
| **Shipped template ↔ its record** | `apps/api/prisma/walaa-template.db` / `.json` | `stage.mjs` refuses to ship a template whose sha256 disagrees with the record |
| **Product version** — was five places holding three values | root `package.json` is the source; API, desktop, Station, Tauri config, Cargo manifest, shared packages, and `API_VERSION` are derived | `packaging/scripts/version.mjs` (assert / `--write`), run by `version.test.ts` and by `package:build` |
| **`HASH_EXCLUDED`** — tables the runtime writes, kept out of the schema hash | `apps/api/src/lib/db-identity.ts` | `db-template.test.ts` asserts the *invariant* rather than the list: stamping everything the runtime stamps must not move the hash |
| **`logs/status.json`, `logs/startup-error.json`** — the files three processes in two languages meet at | `service-host/src/main.rs`, `src-tauri/src/status.rs`, `api/src/lib/startup-error.ts` | `version.test.ts`. These had already drifted: the shell read `<data>/status.json` while the service wrote `<data>/logs/status.json`, so a merchant was told his software was unreachable during every cold start |
| **`API_PORT=` key** the installer rewrites | `packaging/walaa.env.template`, `service-host/src/main.rs` | Coupling removed — the rewrite matches the key rather than the literal `API_PORT=4000`, so the template's default can change freely. Asserted in `version.test.ts` |
| **Required settings ↔ the installer's template** | Zod schema in `apps/api/src/config/env.ts`, `packaging/walaa.env.template` | `env-contract.test.ts`, against `requiredEnvKeys()` asked of the schema itself. A required setting missing from the template fails on a merchant's first launch **and nowhere else**, because every developer machine has a `.env` that satisfies it |
| **`{{PLACEHOLDER}}` names** ↔ the substituter | `packaging/walaa.env.template`, `service-host/src/main.rs` | `env-contract.test.ts` — a renamed placeholder otherwise reaches the merchant as literal text |
| **`walaa-demo.db`** name | `demo-guard.ts`, `service-host/src/main.rs`, `hooks.nsh` | `version.test.ts` |
| **Route inventory ↔ enforced roles** | `rbac-matrix.test.ts` | Already a guard, and it worked — it refused the six Google Drive routes until they were declared |
| **DTOs duplicated across packages** | `packages/shared-types` | `no-duplicate-dtos.test.ts` |

---

## Listed, not automated — staleness costs a label, not a shop

Each is a real duplication. None of them can stop a machine booting or two machines
talking, which is why they are here instead of in the table above.

| Fact | Kept in | If it goes stale | Why it is left |
|---|---|---|---|
| **The two teals** — `#0F6E56` (UI) and `#0E7C60` (chart series 1) | `packages/config/tailwind/preset.cjs`, `apps/manager-desktop/src/lib/viz.ts` | A chart series drifts from the brand hue | Deliberate and documented at length in `CLAUDE.md` §6.2.1, with `dataviz/scripts/validate_palette.js` able to recompute the chroma. The risk here is somebody "fixing" the inconsistency, which §6.2.1 exists to prevent — not silent rot |
| **`BUSINESS_TABLES`** — tables counted when reporting a database's contents | `db-identity.ts` | A new table is missing from a diagnostic count | Diagnostic output only. A short list is not worth a guard |
| **`STORAGE_FAILURE_SIGNATURES`** — driver message texts meaning "out of storage" | `apps/api/src/lib/prisma.ts` | A storage failure is reported less precisely | Degrades safely by design, and says so: any missed signature is still a 5xx and the Station still treats the write as unsaved. Missing one costs wording, not safety |
| **`DEMO_LOGINS`** and the demo seed data | `apps/api/src/lib/demo-credentials.ts`, `demo-data.ts` | A demo build publishes a credential that does not work | Already covered from the other end: `db:assert:login` performs a real login for every published account and `stage.mjs` refuses to ship a demo without it. The demo is also being dropped |
| **`MERCHANT_ID`** seed UUID | `demo.service.ts`, seeds | A seed points at a merchant that is not there | Development and demo only; never in a merchant's database |
| **`WalaaApi`** service name | `service-host/src/main.rs`, `hooks.nsh` | The uninstaller fails to deregister a service | Both sides are in the installer, changed together, and a mismatch is visible immediately at install time rather than later |
| **`com.walaa.manager`** WebView2 profile path | `src-tauri/src/lib.rs`, Tauri identifier | The credential-store purge stops finding the profile | Tauri owns the identifier; a mismatch degrades to "the purge does nothing", which is the pre-existing state, not a new failure |
| **`runtime/`, `station/`, `migrations/` directory names** | `stage.mjs`, `paths.ts`, `service-host`, `hooks.nsh` | The service cannot find what the installer staged | Covered end-to-end by behaviour instead: `package:verify` boots the staged runtime in a clean room and fails if any of them is wrong |
| **Locale keys** | `apps/manager-desktop/src/lib/locale.ts` | An unused key lingers, or a screen renders `undefined` | TypeScript catches a missing key at the call site. Unused keys are dead code, not a hazard |
| **`PATIENCE_MS`, poll intervals, retry counts** | various | A screen waits a little too long or too little | Tuning values with no second copy to disagree with |

---

## The rule for anything added later

Before committing a constant that has to match something else, ask where it fails if the
two drift. If the answer is "on a machine that is not mine", it belongs in the first
table with a guard. If it is "in a log I will read", the second table and a line here is
enough.
