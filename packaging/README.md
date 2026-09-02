# `packaging/` — Windows distribution

The merchant receives **one setup file**. It installs the manager dashboard, the API
service and the SQLite database, registers the service to start with the machine, and
opens the LAN port the Loyalty Station needs (CLAUDE_v3.md §12.3).

This directory is the machinery for producing that file, and the evidence that it
works.

```
packaging/
  scripts/stage.mjs           bundles the API into a self-contained runtime directory
  scripts/verify-runtime.mjs  runs that directory in a clean room, outside the repo
  scripts/verify-service.mjs  exercises the service host without elevation
  service-host/               Rust — the Windows Service shim and supervisor
  dist/runtime/               build output (git-ignored)
```

The NSIS hooks live with the app they are bundled into, at
`apps/manager-desktop/src-tauri/nsis/hooks.nsh`.

---

## Build

From the repository root:

```bash
pnpm package:build       # cargo service host + staged runtime (esbuild, natives, node.exe)
pnpm package:verify      # both clean-room suites
pnpm package:installer   # the NSIS installer
```

The installer lands in
`apps/manager-desktop/src-tauri/target/release/bundle/nsis/`.

`stage` must run **before** `tauri build`: the staged directory is a bundled resource
of the Tauri app, and a stale one ships silently.

---

## What ships, and where it goes

| Path                           | Contents                                                                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `%PROGRAMFILES%\ولاء\`         | the Tauri dashboard executable                                                                                                    |
| `%PROGRAMFILES%\ولاء\runtime\` | `node.exe`, `walaa-api.cjs`, `walaa-service.exe`, `verify-install.ps1`, the Prisma query engine, the Argon2 addon, the migrations |
| `%PROGRAMDATA%\Walaa\`         | `walaa.db`, `walaa.env`, `logs\` — locked to SYSTEM and Administrators                                                            |

The split is the point. `Program Files` is read-only to the service account;
everything that changes lives in the data directory, which is also the only thing a
backup has to cover (§7.3).

**Uninstalling never deletes `%PROGRAMDATA%\Walaa`.** An upgrade runs an uninstall
first, and a shop's customers and transactions must not depend on the installer
getting that ordering right.

---

## The service

`walaa-service.exe` exists because Windows will not start an arbitrary executable as a
service — a service must talk to the Service Control Manager, and a Node process
cannot. It also supervises: restarts the API if it dies, captures its output, and
stops it cleanly.

```
walaa-service.exe install [--data-dir <path>] [--port <n>] [--delayed]
walaa-service.exe uninstall
walaa-service.exe start | stop | status
walaa-service.exe console        # foreground, for diagnostics
```

`--delayed` registers it as Automatic (Delayed Start). It is not the default: the
service depends on nothing that arrives late in boot, and delaying it means a shop
that has just had a power cut waits two minutes for a working till. Use it only on a
machine that demonstrably needs it.

`install` is what the NSIS post-install hook runs. It generates `walaa.env` with
**secrets unique to that installation** and strips the file's inherited permissions
down to SYSTEM and Administrators — `%PROGRAMDATA%` is world-readable by default, and
that file holds the JWT signing keys.

A consequence worth knowing before it surprises you: after installation, `console`
mode must be run **from an elevated prompt**. An ordinary user account cannot read
`walaa.env`, which is exactly the intent.

The NSIS hook calls `install` with no `--port`, so the service listens on 4000 —
which is also what the dashboard's first-run Setup screen offers by default. If you
install with `--port`, the same value has to be typed into that screen, and into the
address the Station tablet browses to.

---

## Installing, and the five checks that close the packaging phase

`verify` and `verify:service` cover everything that runs unelevated. What is left needs
the Service Control Manager, a real reboot, and a second device — and it is not
ceremony. **Check (b) is what validates CLAUDE_v3.md §3's choice of a Windows Service
over a Tauri sidecar.** If the API is not up after a reboot with nobody logged in, that
decision is wrong and the Loyalty Station must not be built on it.

### Before installing

Stop anything already using the API port — a `pnpm dev` API on 4000 will make the
service fail to bind, and the failure will look like the installer's fault:

```bash
netstat -ano | findstr :4000
```

### Install

Run the setup file (it elevates itself), or from an **elevated** prompt:

```bat
cd "%PROGRAMFILES%\ولاء\runtime"
walaa-service.exe install
walaa-service.exe status
```

Expected:

```
  configuration: C:\ProgramData\Walaa\walaa.env (created)
  permissions:   C:\ProgramData\Walaa locked to SYSTEM and Administrators
  service:       WalaaApi registered (automatic start)
  firewall:      inbound TCP 4000 allowed on private networks
  data:          C:\ProgramData\Walaa
  logs:          C:\ProgramData\Walaa\logs
```

### Then reboot, and run the checks

**Reboot fully. Do not open the dashboard afterwards** — the point is that the API does
not need it. From an elevated prompt:

```bat
powershell -ExecutionPolicy Bypass -File "%PROGRAMFILES%\ولاء\runtime\verify-install.ps1"
```

|       | What it proves                                                           | Expected                                                     |
| ----- | ------------------------------------------------------------------------ | ------------------------------------------------------------ |
| **a** | registered, `Automatic`, `LocalSystem`                                   | `StartMode=Auto`, `StartName=LocalSystem`                    |
| **b** | up after reboot, no login, dashboard closed                              | service start time **earlier than** `explorer.exe`'s         |
| **c** | `LocalSystem` can read _and_ write the database, nobody else can read it | `/health` answers, `SYSTEM:(I)(F)`, no `Users:` entry        |
| **d** | answers on the LAN address, not just localhost                           | listener on `0.0.0.0`, `200` from the machine's own LAN IP   |
| **e** | inbound rule on Private networks                                         | rule enabled, port matches, active profile Private or Domain |

The script prints PASS/FAIL with the evidence for each and exits non-zero on any
failure. One line will read **MANUAL**: open the printed URL on the tablet. Nothing on
the manager machine can prove reachability from another device.

### Two failures worth expecting

**The network profile is Public.** The firewall rule covers Private and Domain only, so
a shop network classified Public silently blocks the Station while everything looks
perfect on the manager PC. The script checks this explicitly. Fix:

```powershell
Set-NetConnectionProfile -InterfaceAlias 'Wi-Fi' -NetworkCategory Private
```

**The service starts before something it needs.** Nothing in the design suggests it
will — it binds a socket and opens a file — and the supervisor retries a child that
fails early. If a particular merchant PC disagrees, move it after the boot rush:

```bat
sc config WalaaApi start= delayed-auto
```

That costs the shop roughly two minutes of downtime after a power cut, which is why it
is not the default.

### Removing it

```bat
walaa-service.exe uninstall
```

Stops and deregisters the service and drops the firewall rule. **The data directory
stays** — deleting a shop's customers is a decision for a human with a backup in hand.

---

## Field setup checklist

**Fold this into the V3-6 setup guide.** Each item is something that is correct on a
bench and wrong in a shop, and each one presents as "the Station is broken" rather than
as itself.

### Before the installer runs — free space on the system drive

**Check this first.** It is the only item on this list that can stop the shop rather
than merely keep the Station from connecting. The database lives at
`C:\ProgramData\Walaa\walaa.db`, on the system drive, and there is no second copy of it
running anywhere. A full `C:` does not degrade this product — it halts it: writes fail,
so scans fail, discounts fail and sales are not recorded, at a till with a customer
standing at it. Reads keep working, so the dashboard still looks alive while every
scan errors. That is what makes it hard to recognise from the symptom.

```powershell
Get-PSDrive C | Select-Object @{n='FreeGB';e={[math]::Round($_.Free/1GB,2)}}
```

| Free on `C:` | Verdict                                                            |
| ------------ | ------------------------------------------------------------------ |
| **≥ 20 GB**  | install                                                            |
| 10–20 GB     | install, and tell the merchant it needs attention within the year  |
| **< 10 GB**  | **do not install.** Reclaim space first, then re-check.            |

Those numbers are not set by this product's appetite, which is small — roughly 110 MB
to install, and a database growing on the order of **200 MB a year** at 500 invoices a
day. They are set by what Windows needs in order to keep working around it: update
staging alone wants several GB, and below roughly 2 GB free Windows itself begins
failing in ways that present as application bugs. A machine installed at 9 GB free is
not broken today; it is scheduled to break on a Tuesday in eighteen months, with no
warning and no obvious cause.

**The same check applies to the cashier PC** before the Print Capture Agent is
installed there. Its queue is at `C:\ProgramData\Walaa\agent\queue`, and a full disk on
that machine is the worse of the two: captures stop, and for the three in-path capture
modes an agent that fails in the print path costs print jobs, not just loyalty records
(`agent/README.md`, §4.6 rule 3).

### After installing at a store, before leaving

1. **The network profile must be Private or Domain.** The firewall rule does not apply
   on a Public network, so the Station silently cannot connect while the manager PC
   looks perfect.

   ```powershell
   Get-NetConnectionProfile
   Set-NetConnectionProfile -InterfaceAlias 'Wi-Fi' -NetworkCategory Private
   ```

2. **The router must not enforce AP/client isolation.** Many consumer and guest
   networks block device-to-device traffic entirely: every device reaches the internet
   and none reaches each other. The Station is device-to-device by definition — a
   tablet talking to the manager PC — so isolation breaks it completely while every
   check on the manager machine still passes. Confirm from the tablet itself:

   ```
   http://<manager-lan-ip>:4000/health   ->   {"status":"ok","service":"walaa-api"}
   ```

   If that fails while the same URL works on the manager PC, look at the router's
   wireless settings ("AP isolation", "client isolation", "guest network") before
   looking at anything in this repository.

3. **Enable kiosk printing on the station's browser.** Otherwise every discount slip
   waits behind a print dialog somebody has to dismiss, with a customer at the
   counter. Launch the station like this:

   ```
   chrome.exe --kiosk-printing --kiosk http://<manager-lan-ip>:4000
   ```

   Then set the station's thermal printer as the default and print one test slip to
   confirm the paper width is right.

4. **The manager machine needs a stable address.** A DHCP lease that moves changes the
   URL the Station is configured with. Reserve it on the router, or set it statically.

5. **Nothing else may hold the API port.** A second install, or a developer's `pnpm dev`,
   takes 4000 and the service cannot bind.

   ```
   netstat -ano | findstr :4000
   ```

6. **Write down where the data lives and leave it with whoever maintains the machine.**
   Nobody monitors a path they were never told about, and none of these have a second
   copy.

   | Machine    | Path                                        | Contents                                                 |
   | ---------- | ------------------------------------------- | -------------------------------------------------------- |
   | Manager PC | `C:\ProgramData\Walaa\walaa.db`             | every customer, transaction and voucher                  |
   | Manager PC | `C:\ProgramData\Walaa\walaa.env`            | this installation's secrets — never paste into a ticket  |
   | Manager PC | `C:\ProgramData\Walaa\logs\`                | `api.log`, `service.log`                                 |
   | Cashier PC | `C:\ProgramData\Walaa\agent\queue\`         | captures not yet delivered                               |
   | Cashier PC | `C:\ProgramData\Walaa\agent\queue\rejected\` | captures the server refused — **a human must look here** |

   The data directory is locked to SYSTEM and Administrators, so listing it needs an
   elevated prompt. That is deliberate, and it is why the merchant's IT needs the path
   written down rather than expecting to stumble on it.

   ```powershell
   Get-ChildItem C:\ProgramData\Walaa -Force | Select-Object Name, Length, LastWriteTime
   ```

   **Read `api.log` as UTF-8, or its Arabic comes out as mojibake.** The file itself is
   correct — UTF-8, no BOM, which is what a JSON Lines file should be — but Windows
   PowerShell 5.1 defaults `Get-Content` to the ANSI codepage, and the Arabic error
   messages are exactly the ones worth reading:

   ```powershell
   Get-Content C:\ProgramData\Walaa\logs\api.log -Encoding UTF8 -Tail 200
   ```

   What the two readings look like on the same line:

   ```text
   -Encoding UTF8   "message": "تعذّر تجهيز مجلد النسخ الاحتياطي (EPERM): ..."
   the default      "message": "ØªØ¹Ø°Ù‘Ø± ØªØ¬Ù‡ÙŠØ² Ù…Ø¬Ù„Ø¯ ..."
   ```

   The BOM is omitted deliberately rather than overlooked: a BOM would fix the default
   reading, and would also break the first record for every JSON parser that reads the
   file. `service.log` needs no such care — the service host writes it in English.

   Two things to say out loud while handing this over:

   - **The whole data directory is the backup target**, and `walaa.db` alone is not a
     backup. SQLite runs in WAL mode, so the most recent transactions live in
     `walaa.db-wal` until a checkpoint folds them in. Copy the database without its
     `-wal` sidecar and you have silently restored to an older day.
   - **Growth is slow and free space is not.** The database is not what fills this
     drive; Windows updates, restore points and whatever else the machine is used for
     are. Re-check free space on any support visit.

     The service watches it too, and the manager dashboard raises a standing banner
     below 5 GB (amber) and below 2 GB (red) — the §12.15 thresholds, sampled once a
     minute. Tell the merchant what that banner means before they see it, because the
     one thing it asks for is exactly the thing that is hard to explain afterwards: the
     till stops recording sales when this drive fills. Every crossing is also written to
     the audit trail, so a drive that filled overnight and was cleared by morning is
     still answerable on a later support call.

7. **Complete the backup key ceremony, and make sure the key leaves the building.**

   The manager app will not open until this is done — on first run it shows the key
   ceremony instead of the dashboard, and backups do not run until the key is confirmed.
   That is deliberate. Walk the merchant through it before you leave, and use the print
   button so there is paper.

   **Say this to them in these words, and do not soften it:**

   > **Without this key, the backups cannot be recovered. Full stop.**
   >
   > Not by us. Not by Google. Not by anyone, ever. The backups are encrypted, and this
   > key is the only thing that opens them. If the shop's computer is stolen, burns, or
   > its disk dies — and this key existed only on that computer — then every backup you
   > have is a file nobody on earth can open. You will have done everything right and
   > lost everything anyway.
   >
   > That is worse than having no backups, because you would have trusted them.

   So the key must live somewhere the fire does not reach:

   - Printed and kept where the shop keeps its important papers — not taped to the
     machine, not in the drawer under it.
   - A second copy with the accountant, or the owner's home, or a safe deposit box.
   - **Not** only in a file on the same PC. **Not** only in a photo on a phone that is
     backed up to nothing.

   Write the **key fingerprint** (the short code the app shows, e.g. `1439846e8a17ed61`)
   on the paper too. It is safe to share and it is how anyone later confirms they are
   holding the right key for a given archive — the app says which fingerprint an archive
   needs.

   The confirmation is recorded in the audit trail with the name of the person who did
   it and the date, so "who has the key" is answerable years later. If the key is ever
   replaced, the ceremony reopens by itself and backups stop until it is confirmed
   again — that is not a fault.

---

## Findings from the packaging spike

**"A single binary" is the wrong target; a single installer is the right one.**
§12.3 asked for the API "compiled to a single binary". Node's SEA feature can embed
the bundle into a copy of `node.exe`, but the Prisma query engine (21 MB) and the
Argon2 addon are native `.node` files that must sit beside the executable regardless
— so SEA produces a single _file_ inside a directory that is still a directory, for
no size saving and an experimental-feature warning on every boot. The requirement the
merchant actually cares about — one setup file, no second installer — is met by the
NSIS bundle. Staging `node.exe` alongside a plain CJS bundle is simpler and debuggable.

**Size: 109 MB staged, 30 MB installed from.** `node.exe` is 86 MB of the staged
tree and the query engine 21 MB; NSIS compresses the lot to **30.1 MB** — small
enough to send over WhatsApp, which is how CLAUDE_v2.md §1 expects it to travel. The
Prisma client package is 74 MB in `node_modules`, nearly all of it WASM engines for
databases this product does not use; the staging allowlist takes 20 MB of it.

A control build with the runtime resource removed produced a **2.1 MB** installer, so
the runtime accounts for 28 MB of the 30 MB. That comparison is how the payload was
confirmed to actually be inside: NSIS compresses solidly, so the file names are not
greppable in the finished installer.

**The Prisma CLI does not ship.** Migrations are applied by the service at first boot
(`apps/api/src/lib/migrate.ts`), recorded in Prisma's own `_prisma_migrations` table
with Prisma's own checksum algorithm — verified against a CLI-provisioned database in
`apps/api/src/__tests__/migrate.test.ts`, so the two remain interchangeable.

**Stopping the child needed a mechanism, not a signal.** Windows has no SIGTERM, and
`GenerateConsoleCtrlEvent` needs a console that a service does not have. The host
closes the child's stdin and the API treats that as a stop request when
`WALAA_SUPERVISED=1`. Terminating is the fallback after a 15-second grace period;
WAL makes even that safe.

**The firewall rule is part of installation.** Windows blocks inbound 4000 by
default, so without the rule the Station simply never connects, and the failure looks
like a broken app rather than a closed port. The rule covers the **private and domain**
profiles only — a shop network classified "Public" will not match it. That check
belongs in the V3-6 setup guide.

**The installer is unsigned.** SmartScreen will warn on first run at every merchant.
Code signing is a purchasing decision, not a technical one; it is not in this spike.

**`C:` on the build machine has ~0.4 GB free** (§12.1). It was enough for the NSIS
tooling, but a default install into `Program Files` needs ~110 MB free on the target
drive and would be tight here. The MSI target was dropped — §12.3 asks for one NSIS
installer, and WiX would have needed another download onto that drive.

---

## Renaming the product — what is safe and what is not

*(added 2026-09-02, when the product was renamed to **Customer loyalty**)*

Everything a person **reads** was renamed. Every identifier the **operating system**
keys on was not, and the difference is not cosmetic caution — each one below has a
specific failure attached to it.

### Renamed

| Where | Now |
|---|---|
| Window title, browser tab | `Customer loyalty — إدارة المتجر` / `— محطة الولاء` |
| In-app wordmark (sidebar, both logins) | `Customer loyalty` |
| Installer publisher and descriptions | `Customer loyalty` |
| Windows service **display** name | `Customer loyalty API` — the SCM keys on the service *name*, so this is free |
| App icon, all sizes | Regenerated from `customer_loyalty.ico` |

### NOT renamed, and why

| Identifier | Value | What renaming it does |
|---|---|---|
| `tauri.conf.json` → `productName` | `ولاء` | **The install path.** See below — this is the one with real consequences |
| `tauri.conf.json` → `identifier` | `com.walaa.manager` | The uninstall registry key. A new identifier makes the installer add a *second* entry in Add/Remove Programs instead of upgrading the first |
| `SERVICE_NAME` | `WalaaApi` | The SCM key an upgrade uses to find the service it is replacing. Rename it and the old service keeps running from the old binaries, holding the API port and `walaa.db` open, so the new one cannot bind |
| `FIREWALL_RULE` | `Walaa Loyalty API` | Rules are created and deleted by name. A rename **orphans the old rule** — left open on the shop network with nothing to close it — and adds a duplicate |
| `%PROGRAMDATA%\Walaa\` | — | Holds `walaa.db`, `walaa.env` and `logs\`. Renaming it strands the live database **and the backup encryption key**. Never |
| `walaa.db`, `walaa.env` | — | Same |
| `/health` → `"service":"walaa-api"` | — | `testApiUrl()` in the Station refuses any address whose `/health` does not answer with exactly this. Changing it makes **every already-paired station** report "this address is not a Walaa server" until someone re-runs setup on each one |
| `@walaa/*` package names, `WALAA_DATA_DIR` | — | Internal. Churn with no user-visible benefit |

### What an existing installation would do if `productName` changed

This is the question worth answering before anyone takes that step.

`productName` sets the install directory (`%PROGRAMFILES%\<productName>\`) and the
executable name. Change it to `Customer loyalty` and install over an existing shop:

1. The new installer targets `%PROGRAMFILES%\Customer loyalty\`. **The existing
   install at `%PROGRAMFILES%\ولاء\` is not touched** — it stays on disk.
2. `NSIS_HOOK_PREINSTALL` checks `$INSTDIR\runtime\walaa-service.exe` to stop the
   service before copying files. `$INSTDIR` is now the *new*, empty directory, so
   that file does not exist and **the check silently passes over**. The old service
   is never stopped.
3. `NSIS_HOOK_POSTINSTALL` runs `install` from the new path. `WalaaApi` is already
   registered, so the SCM refuses, and the installer shows its "could not be
   registered" message box.
4. Net result: **two installations on disk, one service still running the old
   binaries, and a warning dialog.** The shop keeps working — the old service is
   still serving — but the new app is not running the new API, and the next person
   to look will find two entries in Add/Remove Programs.

Note that the data survives all of this: `%PROGRAMDATA%\Walaa` is untouched by
either install, which is exactly why it is on that list above.

**If the rename is wanted anyway**, the fix is one addition rather than a rewrite:
`NSIS_HOOK_PREINSTALL` should read `InstallLocation` from the uninstall registry key
(which is keyed on `identifier`, and `identifier` is not changing) and run
`uninstall` against the service executable it finds there, before the file copy.
That turns the above into a clean upgrade. It cannot be verified from a development
machine — it needs a real prior installation to upgrade over — so it should be
tested on a spare machine before it reaches a shop.
