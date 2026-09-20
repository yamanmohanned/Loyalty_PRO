# Releasing ولاء

Every command block here was run as written on 2026-09-17, in a fresh Windows PowerShell 5.1
window on the build PC (a block is one window: its lines run in order). Where a step is not
runnable as a command, it says so instead of showing one. Artefact values are recorded in §5.

---

## 1. One command changes the version

The root `package.json` version is the product version and the only one anybody edits.
Every other version string — the API, the desktop app, the Station, the Tauri config,
the Cargo manifests, the shared packages, and the `API_VERSION` compiled into the service
— is derived from it.

```powershell
# edit "version" in E:\loyalty\package.json first, then:
Set-Location E:\loyalty
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

```powershell
Set-Location E:\loyalty
pnpm --filter @loyalty-pro/api db:template
git add apps/api/src/config/schema-fingerprint.ts apps/api/prisma/loyalty-pro-template.json
```

`EXPECTED_MIGRATIONS_FINGERPRINT` and `EXPECTED_SCHEMA_HASH` are compiled into the
service and decide whether it will open a database at all. They are derived values and
are checked like a lockfile, in three places:

- `pnpm test` — `db-template.test.ts`
- `.githooks/pre-commit` — when a migration or the schema is staged (also refuses when
  the fingerprints are regenerated but left unstaged)
- the head of `pnpm package:build`

Install the hook once per clone:

```powershell
Set-Location E:\loyalty
git config core.hooksPath .githooks
```

The generator rewrites the constants only when a value actually changed, so a rebuild
with no schema change produces no diff.

---

## 3. Build

One window, in this order. `package:verify` needs a licence code and two phone codes issued by
**your production key** (the staged runtime embeds it and accepts nothing else): the first three
lines issue them for this build PC (`WL-34V4-WZNE`) and for a shop that does not exist, and put
them where the script reads them. They extend this PC's own licence by one day each release.

```powershell
Set-Location E:\loyalty
$env:LOYALTY_VERIFY_LICENSE_CODE = ((& "E:\loyalty\tools\license-issuer\target\release\license-issuer.exe" --home "C:\Users\yaman\.loyalty-pro-issuer" --password-file "C:\Users\yaman\.loyalty-pro-issuer\PASSWORD.txt" renew --device WL-34V4-WZNE --days 1 | Out-String) -split 'Send the merchant this code \(the lines can be pasted as they are\):')[1].Trim()
$env:LOYALTY_VERIFY_UNLOCK_CODE = ((& "E:\loyalty\tools\license-issuer\target\release\license-issuer.exe" --home "C:\Users\yaman\.loyalty-pro-issuer" --password-file "C:\Users\yaman\.loyalty-pro-issuer\PASSWORD.txt" unlock --device WL-34V4-WZNE --days 1 --note "release verification" | Out-String) -split 'three groups:')[1].Trim().Split("`n")[0].Trim()
$env:LOYALTY_VERIFY_OTHER_UNLOCK_CODE = ((& "E:\loyalty\tools\license-issuer\target\release\license-issuer.exe" --home "C:\Users\yaman\.loyalty-pro-issuer" --password-file "C:\Users\yaman\.loyalty-pro-issuer\PASSWORD.txt" unlock --device WL-2222-2222 --days 1 --note "release verification - a shop that does not exist" | Out-String) -split 'three groups:')[1].Trim().Split("`n")[0].Trim()
pnpm package:build
pnpm package:verify
```

Then the installer — §6 (it needs the update-signing key in the same window).

`package:build` (version:check → fingerprint check → template → station → licensing module →
service host → stage) stages `packaging/dist/runtime` — the exact tree the installer bundles.
`package:verify` boots that tree in a clean room and runs its checks (55 on 0.3.1), including
that a first launch applies **no migration** and installs the shipped template instead — and
then **drives the staged bundle the way a merchant does**: first-run setup, the till and
capture-agent accounts, licensing (unlicensed → refused in Arabic → activated → trades; licence
destroyed → phone code → trades; module deleted → still trades), a customer, a captured invoice,
and the first sale. That last part exists because three blockers (no till account, no agent
account, a 500 on every installation's first sale) passed every earlier check: each check proved
the runtime booted, and none proved a shop could use it.

`stage` refuses a Station bundle older than its source, the same way it refuses a stale
service host.

---

## 4. Run the drills before you ship

These two run as written and provision everything themselves, against the staged runtime in
production mode:

```powershell
Set-Location E:\loyalty
pnpm --filter @loyalty-pro/api drill:kill 3
node apps/api/drills/matrix.mjs 4971
```

Each refuses to run unless the SQLite settings match production — `wal`,
`busy_timeout=5000`, `foreign_keys=1`, `synchronous=1`, `wal_autocheckpoint=512` — on
both its own connections and the service under test. A concurrency result obtained under
other settings is not a result about what ships.

**`drill:contention` and `drill:recover` are not runnable as commands on 0.3.x, and were not run
for 0.3.1.** Both need a production-mode service already running on a production-provisioned
database holding the development accounts (`Walaa!Dev2026`), passed as `<baseUrl> <dbPath>`.
The dataset they default to (`…f563cfe8…\scratchpad\prod-drill`) was provisioned on 2026-09-08 by
0.2.x, and 0.3.x refuses that database by design — a shop machine never migrates. Running them
again means provisioning a new dataset first; until that is scripted there is no correct
one-line command to write here. Their last passing runs are the 0.2.x records.

---

## 5. Record what you built

```text
Installer  E:\loyalty\apps\manager-desktop\src-tauri\target\release\bundle\nsis\ولاء_<version>_x64-setup.exe
```

Take the SHA-256 and put it wherever you record releases (this is the 0.3.1 file):

```powershell
Get-FileHash "E:\loyalty\apps\manager-desktop\src-tauri\target\release\bundle\nsis\ولاء_0.3.1_x64-setup.exe" -Algorithm SHA256
```

**0.3.1 (signed, current — the install-day build):** `ولاء_0.3.1_x64-setup.exe`, 33,881,377 bytes ·
`7EB47888D3264748C6463E877697B8F2269DAF65E0E5B9BB0A5DC115549B5967`. «ربط حساب Google» opens the
browser through the shell's opener and the Drive card shows one status at a time; rate limits
count only attempts that reached their operation; every settings action has a pending label and
one outcome; the licence issuer takes the password from any shell or file and renews as its own
command. **No migration** — the update feed is safe for 0.3.0 shops (§7). Production licence key
`FCA66207230B90CA` (confirmed by `verify-license-key.mjs`). Built 2026-09-17 from commit
`aa3b5b1` by running §1, §2, §3, §4 and §6 of this file as written, in that order, each block in a
fresh PowerShell window — all exit 0; `package:verify` 55 checks with the codes issued by §3's own
lines. (`db:template` gave the template a new identity; that file is committed with this record.)
An earlier build of the same source that day, `52C3E397…2692`, was used for the scratch walks in
`HANDOVER-0.3.1.md` §3 and is superseded by this one. `verify-signing --post`
confirmed the `.sig` (420 bytes, `92518563EDCB263F77E94FB2F5C36DDEA55E949FCC84F9D3654EFDA116479099`)
is by key `BE2E4C7B42C8D100`. `drill:kill 3` 8/8 and `matrix.mjs 4971` 12/12 against its staged
runtime. Not Authenticode-signed: SmartScreen will warn.

**0.3.0 (signed, superseded — never installed at a shop):** `ولاء_0.3.0_x64-setup.exe`, 33,877,004 bytes ·
`68AE613ECC0C9A2CB677227F55769174359D6C5F3001F7C43C36A345D75EB12B` — offline licensing
with the provider's **production** key (fingerprint `FCA66207230B90CA`, confirmed by
`verify-license-key.mjs`; emergency codes until 2046-09-09), bounded fail-open, sales held
on the manager PC. Built from `84f20cc` by `pnpm version:check && pnpm package:build &&
pnpm package:verify && pnpm package:installer`, all exit 0; `package:verify` ran with
`LOYALTY_VERIFY_LICENSE_CODE`, `LOYALTY_VERIFY_UNLOCK_CODE` and `LOYALTY_VERIFY_OTHER_UNLOCK_CODE`
issued for the build machine (`WL-34V4-WZNE`) and a non-existent shop. `verify-signing
--post` confirmed the `.sig` (420 bytes,
`8527AE1DCA2224C51CADA82C97B9E44ECB0F5E8DD4E9FFD5FC168F333D05B386`) is by key
`BE2E4C7B42C8D100`. **Adds two migrations — never publish it to the update feed for 0.2.x
shops (§7); install in person.** Not Authenticode-signed: SmartScreen will warn.

**0.2.3 (signed, superseded):** `ولاء_0.2.3_x64-setup.exe`, 33,700,381 bytes ·
`2656D60856CDBAC5C4453E72426FF996C6436F3F8A9778E0AC9C9600C25D49D1` — failed screens say
what failed and why; the restore test runs from its own card and records passes and
failures; restoring a chosen copy (local, USB, Google Drive) from the Backup screen;
Google Drive set up from Settings (see `GOOGLE-DRIVE-SETUP.md`). Built by
`pnpm version:write && pnpm version:check && pnpm package:build && pnpm package:verify &&
pnpm package:installer`, all exit 0, with the signing variables set as in `SIGNING.md`;
`verify-signing --post` confirmed the `.sig` (420 bytes,
`63F50C80155EB9AEE77E7F60EF0CB6DDDB310DB66A904AF6118E30ED693DB24D`) is by key
`BE2E4C7B42C8D100`, the one compiled into the app. No migration was added, so the update
feed is safe for this release (§7).

**0.2.2 (signed, superseded):** 33,688,310 bytes ·
`21930D9A56C60A72E36F2915AD9FF065E92423510E80C658FF0691EEED81D280` — the install-night
fixes.

**0.2.1 (signed, superseded):** 33,676,439 bytes ·
`5F4A10580EC8C8867806C38C17A1419F8AD85A1F4707D718A031CAB1A8C109F3`

**0.2.0 (signed):** 33,682,447 bytes ·
`AADF7480F9D4D55E52F2DC595FBDB288E9A634EFD8742BAD205FBE57DCE88137`

Both signed with key `BE2E4C7B42C8D100`, each with a 420-byte `.sig` beside it whose key
id was checked against the public key compiled into the app. 0.2.0 is kept because
`drill:upgrade` uses the pair to prove a shop's data survives a real version change.

---

## 6. Auto-update signing

Releases are signed. The key, where it lives, what happens if it is lost, and how to
publish an update are all in **`packaging/SIGNING.md`** — read that once before your
first release.

The short version:

In the same window as §3 (after `package:verify`). Once `PASSWORD.txt` is gone from this PC, put
the password from your password manager between quotes on the second line instead.

```powershell
Set-Location E:\loyalty
$env:TAURI_SIGNING_PRIVATE_KEY = "C:\Users\yaman\.loyalty-pro-signing\loyalty-pro-updater.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [IO.File]::ReadAllText("C:\Users\yaman\.loyalty-pro-signing\PASSWORD.txt").Trim()
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
  change, and an existing installation is checked against the new build at startup —
  and **refused**, because a merchant's machine never migrates. **Never publish such a
  release through the update feed**: installed copies apply updates on the next restart
  without asking, so it would stop every shop at once. Upgrade those shops in person, with
  a backup in hand (DEPLOYMENT.md §11).
