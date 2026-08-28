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

| Path                           | Contents                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `%PROGRAMFILES%\ولاء\`         | the Tauri dashboard executable                                                                              |
| `%PROGRAMFILES%\ولاء\runtime\` | `node.exe`, `walaa-api.cjs`, `walaa-service.exe`, the Prisma query engine, the Argon2 addon, the migrations |
| `%PROGRAMDATA%\Walaa\`         | `walaa.db`, `walaa.env`, `logs\`                                                                            |

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
walaa-service.exe install [--data-dir <path>] [--port <n>]
walaa-service.exe uninstall
walaa-service.exe start | stop | status
walaa-service.exe console        # foreground, for diagnostics
```

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

## Verifying the parts that need Administrator

`verify-service.mjs` covers everything else; SCM registration needs
`SeCreateServicePrivilege`. From an **elevated** prompt:

```bat
cd "%PROGRAMFILES%\ولاء\runtime"
walaa-service.exe install
walaa-service.exe status
sc qc WalaaApi
curl http://localhost:4000/health
```

Expected: `status` reports `Running`; `sc qc` shows `START_TYPE : 2 AUTO_START` and a
`BINARY_PATH_NAME` ending in `run --data-dir C:\ProgramData\Walaa`; `/health` answers
`{"status":"ok","service":"walaa-api"}`.

Then the one that matters most — reboot the machine and call `/health` again without
logging in. The Loyalty Station and the capture agent depend on the API being up
before anybody touches the manager PC.

To remove:

```bat
walaa-service.exe uninstall
```

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
