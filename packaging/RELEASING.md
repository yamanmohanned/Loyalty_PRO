# Releasing ولاء

Every command here was executed as written. Values shown are from the 0.2.0 build.

---

## 1. One command changes the version

The root `package.json` version is the product version and the only one anybody edits.
Every other version string — the API, the desktop app, the Station, the Tauri config,
the Cargo manifest, the shared packages, and the `API_VERSION` compiled into the service
— is derived from it.

```bash
# edit "version" in package.json, then:
pnpm version:write
pnpm version:check
```

This matters more than it looks. The dashboard refuses a server whose `/health` reports
a different `major.minor` and says «خادم ولاء على هذا العنوان بإصدار مختلف». When those
strings drift, a manager and a station **from the same installer** refuse each other —
and not here: in the shop, when the till is connected.

`pnpm package:build` runs `version:check` first and stops if anything disagrees.

---

## 2. If you touched a migration, regenerate the fingerprints

```bash
pnpm --filter @walaa/api db:template
git add apps/api/src/config/schema-fingerprint.ts apps/api/prisma/walaa-template.json
```

`EXPECTED_MIGRATIONS_FINGERPRINT` and `EXPECTED_SCHEMA_HASH` are compiled into the
service and decide whether it will open a database at all. They are derived values and
are checked like a lockfile, in three places:

- `pnpm test` — `db-template.test.ts`
- `.githooks/pre-commit` — when a migration or the schema is staged (also refuses when
  the fingerprints are regenerated but left unstaged)
- the head of `pnpm package:build`

Install the hook once per clone:

```bash
git config core.hooksPath .githooks
```

The generator rewrites the constants only when a value actually changed, so a rebuild
with no schema change produces no diff.

---

## 3. Build

```bash
pnpm package:build      # version:check → fingerprint check → template → service host → stage
pnpm package:verify     # clean-room boot of the staged runtime + service-host checks
pnpm package:installer  # the NSIS installer
```

`package:build` stages `packaging/dist/runtime` — the exact tree the installer bundles.
`package:verify` boots that tree in a clean room and runs 20 checks, including that a
first launch applies **no migration** and installs the shipped template instead.

---

## 4. Run the drills before you ship

```bash
# a production-mode service on a production-provisioned database is required;
# see the header of each drill for how it provisions one.
pnpm --filter @walaa/api drill:contention <baseUrl> <dbPath> 30 <apiLogPath>
pnpm --filter @walaa/api drill:kill 3
pnpm --filter @walaa/api drill:recover <baseUrl> <sourceDbPath> <backupDir>
node apps/api/drills/matrix.mjs 4971
```

Each refuses to run unless the SQLite settings match production — `wal`,
`busy_timeout=5000`, `foreign_keys=1`, `synchronous=1`, `wal_autocheckpoint=512` — on
both its own connections and the service under test. A concurrency result obtained under
other settings is not a result about what ships.

---

## 5. Record what you built

```
Installer  apps/manager-desktop/src-tauri/target/release/bundle/nsis/ولاء_<version>_x64-setup.exe
```

Take the SHA-256 and put it wherever you record releases:

```powershell
Get-FileHash "...\ولاء_0.2.0_x64-setup.exe" -Algorithm SHA256
```

**0.2.0:** 33,672,204 bytes · `4183BDE1057068C899378934C4898637D64C1871347590D96AAFEA37AC751E56`

---

## 6. Auto-update signing

Releases are signed. The key, where it lives, what happens if it is lost, and how to
publish an update are all in **`packaging/SIGNING.md`** — read that once before your
first release.

The short version:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = "C:\Users\yaman\.walaa-signing\walaa-updater.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<from your password manager>"
pnpm package:build
pnpm package:installer
```

That produces the installer **and** a `.sig` beside it. Both go on the GitHub release,
with a `latest.json` — `packaging/scripts/make-update-feed.mjs` writes that from the
built artefacts rather than by hand.

Key id **`BE2E4C7B42C8D100`**. Its public half is compiled into every installed copy, so
**it cannot be changed retroactively**: a build that shipped without one could never
self-update, and rotating the key means visiting every machine. `signing-key.test.ts`
asserts that the private half is not in this repository and that the public half is
present and is genuinely a public key.

---

## 7. What the version number means to a running shop

- **Patch** (0.2.0 → 0.2.1): dashboard and API still talk. `testApiUrl` compares
  `major.minor` only, deliberately — a shop must not be locked out of its own data over
  a version digit.
- **Minor or major** (0.2.x → 0.3.0): every machine must be updated together. A manager
  on 0.3 will refuse a 0.2 server, correctly.
- **Any release that adds a migration**: the shipped template changes, the fingerprints
  change, and an existing installation is checked against the new build at startup. If
  it refuses, the message distinguishes a foreign database from a stale build — they
  need opposite remedies and only one of them is the merchant's problem.
