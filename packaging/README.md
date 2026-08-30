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

   Two things to say out loud while handing this over:

   - **The whole data directory is the backup target**, and `walaa.db` alone is not a
     backup. SQLite runs in WAL mode, so the most recent transactions live in
     `walaa.db-wal` until a checkpoint folds them in. Copy the database without its
     `-wal` sidecar and you have silently restored to an older day.
   - **Growth is slow and free space is not.** The database is not what fills this
     drive; Windows updates, restore points and whatever else the machine is used for
     are. Re-check free space on any support visit.

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
