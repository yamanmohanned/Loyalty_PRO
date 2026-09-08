# Shipping a build, and shipping an update

Everything you have to do on your side, in order. Nothing here needs the merchant to
receive a new file after the first one.

---

## 0. One-time setup you have already done

The updater signing keypair was generated once and lives at:

```
packaging/updater/walaa-updater.key       ← PRIVATE. Never commit. Never lose.
packaging/updater/walaa-updater.key.pub   ← public half, compiled into every build
```

**If the private key is lost, no installed copy can ever be updated again.** Not by
you, not by re-generating a new key — every app already in a shop only trusts the
public half it was built with, and the only fix is visiting each machine with a fresh
installer. Put a copy in a password manager today.

`.gitignore` excludes `packaging/updater/*.key`. The `.pub` is committed on purpose:
it is in `tauri.conf.json` anyway.

---

## 1. Build a demo release

```bash
pnpm --filter @walaa/packaging service:build     # <- see "the stale binary" below
pnpm --filter @walaa/api db:seed:demo
WALAA_DEMO=1 pnpm --filter @walaa/station build
WALAA_DEMO=1 node packaging/scripts/stage.mjs
node packaging/scripts/make-readme.mjs           # <- generates dist-demo/اقرأني.md
cd apps/manager-desktop
export TAURI_SIGNING_PRIVATE_KEY="$(cat ../../packaging/updater/walaa-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
WALAA_DEMO=1 pnpm tauri build --config '{"bundle":{"windows":{"nsis":{"installMode":"currentUser"}}}}'
```

### Two things about the demo build that are not obvious

**`service:build` first, every time.** `cargo check` type-checks without emitting a
binary, so an afternoon spent editing `packaging/service-host` can leave the previous
build sitting in `target/release`. Staging used to copy whatever was there and say
nothing, which shipped an installer whose API bundle was new and whose service host was
six hours old — an internally inconsistent product that failed on a clean machine and
looked like an application bug. `stage.mjs` now **fails the build** if the binary is
older than any file in `service-host/src`, and prints both timestamps. The command above
is what it will tell you to run.

**`installMode: currentUser` is what makes it a demo.** A per-machine install needs UAC,
registers `WalaaApi` with the Service Control Manager and writes a firewall rule — none
of which a merchant trying a demo should be asked for, and all of which would leave
state behind on his PC. Per-user means:

- no elevation prompt at any point;
- the NSIS hooks skip service registration entirely (they detect the demo by the shipped
  `walaa-demo.db`, the same signal the service host and the app shell use);
- the app supervises its own backend by launching `walaa-service.exe console`, which
  runs the **same** `supervise()` the Windows Service runs — so the demo exercises the
  merchant's real supervision path rather than a simplified stand-in;
- state lives in `%LOCALAPPDATA%\Walaa`, which the merchant can actually read.

### NSIS remembers where it last installed — check before you trust a rebuild

A per-user install records `InstallLocation` under
`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\ولاء`, and every later run of
the installer — including `/S` — goes **there**, not to the per-user default.

On the build machine that produced two installations at once: a current one at the
remembered path, and a stale one at `%LOCALAPPDATA%\ولاء` that the Start Menu shortcut
still pointed at. Launching the shortcut ran the previous day's binary, so a fix that
was genuinely present in the new build appeared not to work — and every signal said the
install had succeeded, because it had, somewhere else. It cost a full diagnosis cycle
and produced a bug report against code that was already correct.

A merchant receiving the product for the first time has no remembered path and is not
affected. **You are, on every rebuild.** Before concluding that a change did not take,
check where the installer actually put it:

```powershell
(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ولاء').InstallLocation
```

and check that the binary you are launching is the one you just built:

```bash
grep -c "COLLATE NOCASE" "<install dir>/runtime/walaa-api.cjs"   # 1 = has the current auth fix
```

To move an installation back to the default, run its own `uninstall.exe` first, then
install again.

### The database name is the isolation boundary

A demo build opens `walaa-demo.db`; production opens `walaa.db`. Neither has a code path
to the other's file, and the API re-checks at startup with `PRAGMA database_list` —
ground truth, not the configured URL — refusing to start, in Arabic, naming the file, if
they disagree. The demo seed also carries a provenance row that the runtime requires, so
"the installer placed this database" is a property of the file rather than an assumption
about its name.

This replaced a scheme where both builds opened `walaa.db`. On a machine with an earlier
install, the demo silently adopted a database it had never placed.

Output — both files matter:

```
src-tauri/target/release/bundle/nsis/ولاء_<version>_x64-setup.exe
src-tauri/target/release/bundle/nsis/ولاء_<version>_x64-setup.exe.sig
```

The `.sig` is not optional. It is what every installed copy checks before it will
apply the download, and a release published without it updates nobody.

### A production (non-demo) release

Drop `WALAA_DEMO=1` from all three commands. Then **verify the demo code is actually
gone** before you publish it to a real shop:

```bash
node packaging/scripts/verify-demo-isolation.mjs apps/manager-desktop/dist --expect production
```

That check exists because the first attempt at demo isolation failed silently: the
demo branches were guarded at runtime instead of at the call site, and every demo
string shipped in the production bundle. Do not skip it.

---

## 2. Publish the update

The app is built to read:

```
https://github.com/yamanmo/walaa/releases/latest/download/latest.json
```

So a release is three files on one GitHub release, and GitHub's `latest` alias does
the rest.

**Bump the version in three places first** — they must agree, or the installer name
and the feed will not match:

- `apps/manager-desktop/package.json` → `version`
- `apps/manager-desktop/src-tauri/tauri.conf.json` → `version`
- `apps/manager-desktop/src-tauri/Cargo.toml` → `version`

Build (step 1), then generate the feed:

```bash
node packaging/scripts/make-update-feed.mjs 0.1.1-preview \
  --base "https://github.com/yamanmo/walaa/releases/download/v0.1.1-preview" \
  --notes "ما الجديد في هذا التحديث"
```

That writes `packaging/dist/update/latest.json` with the version, the signature read
out of the `.sig`, and a percent-encoded URL (the filename is Arabic — an unencoded
URL works in a browser and fails from the app's HTTP client).

Then publish, with the tag matching the `--base` URL exactly:

```bash
gh release create v0.1.1-preview \
  "apps/manager-desktop/src-tauri/target/release/bundle/nsis/ولاء_0.1.1-preview_x64-setup.exe" \
  "packaging/dist/update/latest.json" \
  --title "0.1.1-preview" --notes "ما الجديد"
```

**Credentials:** `gh auth login` once, with a token carrying `repo` scope. Nothing
else. The updater signing key is used at *build* time, not at publish time.

Every running copy picks it up on its next launch: it fetches `latest.json`, compares
versions, downloads in the background, and shows one Arabic line offering a restart.
It also installs on the next ordinary exit if he ignores the line.

---

## 3. Verifying the update path without publishing

The whole chain runs against a local feed, which is how it was tested here:

```bash
# terminal 1 — serve the feed
node packaging/scripts/make-update-feed.mjs 0.1.1-preview --base "http://127.0.0.1:8787"
node packaging/scripts/serve-update-feed.mjs 8787

# terminal 2 — build an older version pointed at that feed
#   `dangerousInsecureTransportProtocol` is REQUIRED for http and must never appear
#   in a shipped build; the updater refuses plain http otherwise, correctly.
cd apps/manager-desktop
WALAA_DEMO=1 pnpm tauri build --config '{"bundle":{"windows":{"nsis":{"installMode":"currentUser"}}},"plugins":{"updater":{"endpoints":["http://127.0.0.1:8787/latest.json"],"dangerousInsecureTransportProtocol":true}}}'
```

Run the built `walaa-manager.exe` and watch the feed server's log. A working update
path prints two lines: `latest.json`, then the installer.

---

## 4. Code signing, SmartScreen, and what it costs

The installer is **unsigned**. On a machine that has never seen it, Windows shows a
blue full-screen **"Windows protected your PC"** panel with only a `Don't run` button
visible until the user clicks `More info`.

| Option | Cost / year | Removes the warning |
|---|---|---|
| Ship unsigned | 0 | No |
| OV code-signing certificate | ~$200–400 (Sectigo, DigiCert) | Only after enough installs build reputation — weeks to months, and the warning returns on every new version until then |
| **EV code-signing certificate** | ~$400–700 + a hardware token | **Yes, immediately** — EV certificates get SmartScreen reputation from day one |
| Microsoft Store | free–$19 one-off | Yes, but the app must pass certification and the Store flow is not a `.exe` you send over WhatsApp |

For one merchant receiving one file, unsigned plus the two lines below is the
proportionate answer. **Before you send it to more than a handful of shops, buy the
EV certificate** — the panel is the single worst first impression this product can
make, and at ten shops it costs more in phone calls than the certificate does.

### The two lines to send him

Send these with the file, in the same message:

> عند فتح الملف قد تظهر شاشة زرقاء من ويندوز مكتوب عليها «Windows protected your PC».
> هذا طبيعي لأن البرنامج جديد ولم يُسجَّل لدى مايكروسوفت بعد — اضغط «More info» ثم «Run anyway».

---

## 5. Demo isolation — what stops a demo reaching a real shop

Three independent things, all verified:

1. **The frontend flag is compiled in.** `__DEMO_MODE__` is a Vite `define`, so a
   production build folds every demo branch to `false` and Rollup removes it.
   `verify-demo-isolation.mjs` greps the built bundle to prove it.
2. **A demo build cannot be pointed anywhere.** `getApiUrl()` returns a fixed
   `127.0.0.1:4000` and `setApiUrl()` refuses to write. The first-run Setup screen —
   the only surface that has ever accepted a server address — is therefore never
   reached. There is no field in a demo build into which a real server URL can be typed.
3. **The destructive endpoint does not exist in production.** `POST /system/demo/reset`
   is registered only when `WALAA_DEMO=1`, which the service sets only when it finds
   the shipped demo database beside itself; and `buildDemoShop` re-checks the *open
   database filename* before deleting anything, so even a production install started
   with the flag set by mistake cannot wipe `walaa.db`.
