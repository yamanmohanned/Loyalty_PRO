# Pre-Integration Checklist — everything that must be true before V3-6 starts

> **Scope.** The V3-6 end-to-end run is: *capture → ingest → scan → discount → slip →
> real-time dashboard*, plus encrypted backup with a verified restore, plus the setup
> guide (`PROMPT_v3.md`, Phase V3-6). This file lists only what must already be **true**
> before that run begins. It invents nothing: every item cites the spec or decision-log
> entry it comes from.
>
> **Status legend.** `[x]` proven, with the evidence named · `[ ]` open · **BLOCKED**
> waiting on someone outside the code.
>
> Compiled 2026-08-31 from `CLAUDE.md`, `CLAUDE_v3.md` §§2–9 and §12.1–12.28 (settlement
> item updated 2026-09-01), and
> `PROMPT_v3.md`.

---

## A. Blocked — owned by the operator

Nothing in the codebase can move these. They are listed first because four of them gate
the run itself.

- [ ] **BLOCKED — Station reached from a second physical device.** §12.11's install check
  (d): a tablet could not reach `192.168.0.106:4000` on the test router. The evidence
  already points away from packaging — the socket is bound to `0.0.0.0`, the machine
  answers on that address itself, and the firewall rule is active on the profile in use —
  so this needs a network without AP/client isolation, not a change. **Do not "fix" it by
  rebinding the listener or broadening the firewall rule** (§12.11).
- [ ] **BLOCKED — Physical barcode print-and-scan.** A card printed on the Station's own
  thermal printer, then read back by the USB wedge scanner. Everything to date is
  simulated keyboard input. This is what proves the 16-digit card number (§12.12) survives
  the print → paper → scanner round trip, and that the scan field's three submit paths
  (Enter, Tab, sixteen digits — §12.13) match the shop's actual device.
- [ ] **Google Drive against the real Google.** The owner now sets Drive up entirely from
  Settings — client id and secret (stored encrypted), consent, account shown, a round-trip
  test, upload now, restore from Drive — following
  [`packaging/GOOGLE-DRIVE-SETUP.md`](packaging/GOOGLE-DRIVE-SETUP.md). All of it has run
  on the packaged build against a local stand-in for Google only; **it has never run
  against Google's servers.** That page's last section lists exactly what the first real
  connection must prove (loopback redirect for a Desktop client, real error bodies,
  about.get, a real upload/download/delete, the 7-day Testing expiry). Until it has, 3-2-1
  has two legs, not three. Scope stays `drive.file` — requesting wider is prohibited, not
  merely discouraged (§12.18, operator ruling).
- [ ] **Real Al-Bayan captured bytes.** §12.6 ruled this non-blocking for *building*, and
  it was. It blocks *integration with the real POS*: the parser is proven only against the
  synthetic ESC/POS fixtures in `agent/fixtures/`. Put the real capture beside them and
  compare (§12.14). **The day you go to get them has a written order of operations:
  [`agent/RUNBOOK-first-install.md`](agent/RUNBOOK-first-install.md)** — what to try, in
  what order, which log line means which mode is live, and what to bring back if nothing
  captures.
- [ ] **BLOCKED — Physical card stock exists.** §12.25 makes pre-printed cards the primary
  registration path: the customer is handed a card that **already exists in the database**,
  so until a batch has been generated, exported, printed by the card vendor and physically
  received, there is nothing to hand over. The thermal fallback (§6.3) keeps the Station
  working meanwhile — but a handover with no stock is a handover of the fallback path only,
  and the merchant asked for this feature precisely because thermal cards do not survive an
  Iraqi summer in a wallet.

---

## B. Site, network, and hardware

- [ ] Manager PC holds a **DHCP reservation** on the store router, so its address is stable
  (§7.1).
- [ ] Store Wi-Fi is **WPA2/WPA3** and permits **device-to-device traffic** (§7.1 — the
  same condition A/1 is waiting on).
- [ ] The manager PC's Windows network profile is **Private or Domain**. The installer's
  inbound rule covers those two profiles only — a network classified *Public* will not
  match it, and the Station simply never connects (§12.11).
- [ ] **Free space on the manager PC's system drive**: ≥ 5 GB to clear the WARN threshold,
  and separately ≥ `max(3 × database size, 2 GB)` or a backup will correctly refuse to run
  (§12.15, §12.18). This is an install prerequisite, not a runtime nicety.
- [ ] The **Station has its own thermal printer**, separate from the cashier's (§6.3).
- [ ] **Kiosk printing is enabled in the Station's browser**, or every card and slip raises
  a print dialog (§12.13; also in `packaging/README.md`).
- [ ] Cards handed to customers are **pre-printed ivory/PVC** (§12.25). Where the thermal
  fallback is used, the paper card is **card stock or laminated** — bare thermal paper fades
  within weeks in Iraqi heat (§6.3).
- [ ] **A card vendor is chosen and one of their proof cards has been scanned.** The vendor's
  printer, ink and card surface are what decide whether a 0.33 mm module reads — the one part
  of §12.25 this codebase cannot verify for itself. This is A/2's print-and-scan validation
  carried onto real stock: doing it only on thermal paper proves the fallback path, not the
  primary one (§12.25, §12.12).
- [ ] The **capture mode for this shop is determined**, `SPOOL_WATCH` preferred and
  auto-detection short-circuiting on it (§4.2, §4.3, §12.14). If Al-Bayan writes raw bytes
  to USB: relocate the printer to the agent machine and share it, or map `net use LPT1:` —
  never a kernel-mode filter driver (§4.4).
- [ ] For any **in-path** mode, the **one-step manual revert** is written down and to hand
  before the run (§4.6 rule 5). In-path modes carry a real window between process death and
  watchdog restart in which a print job is lost, not delayed — that residual risk is the
  reason `SPOOL_WATCH` is preferred, and it has to be accepted knowingly.

---

## C. Manager machine — the server

- [x] **Installed from one NSIS installer**, service registered `Automatic` / `LocalSystem`,
  up **10.7 s after boot and two seconds before login** with the dashboard closed —
  §12.11's reboot test, 22/22 checks, 2026-08-28. Checks (a), (b), (c), (e) passed;
  **(d) is item A/1 above**.
- [x] **Data directory locked** to SYSTEM and Administrators, database at
  `%PROGRAMDATA%\Walaa\walaa.db` (§5.1, §12.11). Consequence to remember during the run:
  reading the logs or the database needs an **elevated** prompt.
- [ ] `walaa.env` holds this installation's **own** secrets. Never regenerate
  `QR_TOKEN_SECRET` on a machine whose cards are already printed — it invalidates every one
  of them (§12.11), and with pre-printed stock it also kills **blank cards in a drawer that
  no customer has ever touched** (§12.25).
- [ ] **Backup key ceremony completed by the OWNER**, confirmed by re-entering the key, and
  the key **recorded off the machine** (§12.19). Backups answer 409 `BACKUP_BLOCKED` until
  this is done, by design. A MANAGER cannot complete it and is not walled by it — they get
  the dashboard with a standing banner (§12.19, corrected 2026-08-31).
- [ ] **Backup destinations configured and each one writable**: local directory (the service
  account's — an unwritable one now answers 507 naming the path, §12.19), the USB path, and
  the Drive folder id, which must name a folder **this app created** or be left unset,
  because `drive.file` cannot see anything else (§12.18).
- [ ] **A restore has actually been run and verified**, not merely scheduled. §7.3 calls
  this the most commonly skipped and most costly step. `restoreArchive` writes to a file and
  inspects it; restoring over the live database is deliberately not offered (§12.18).
- [ ] **Scheduler behaviour confirmed on this machine**: a machine started with the most
  recent daily slot uncovered backs up immediately rather than waiting for a timer (§12.21).
  Partial success — a USB stick in someone's pocket — is a **normal** outcome and must not
  read as failure (§12.18).

---

## D. Accounts and configuration

- [ ] **A user exists for each of the four roles**: `OWNER`, `MANAGER`, `STATION`, `AGENT`.
  ⚠ **There is still no way to create a user in the field** — the seed makes them and the
  installer does not (§12.23, *Recorded, not fixed*). Sufficient for a bench run; **blocks a
  real handover**.
- [ ] The agent authenticates with **its own `AGENT` credentials**, never a Station login.
  Its password sits in cleartext in `agent-settings.json` on the cashier PC, so that file
  must not carry the ability to register customers or read card numbers (§12.23).
- [ ] **At least one card batch generated, exported and physically received**, with the batch
  screen's `PRINTED` count matching the blanks actually in the drawer. The merchant chooses
  the quantity only; the system computes the starting serial, which is what makes a range
  collision impossible rather than merely warned about (§12.25).
- [ ] **The batch export file is off the machine once the card printer has finished.** It has
  to contain every card number in the range or the barcodes cannot be printed, which makes it
  the one artefact of this feature worth stealing — and means the printing vendor sees the
  whole batch. An unassigned card is worth nothing until someone hands it over, and a leaked
  batch can be voided wholesale; neither is a reason to leave the file lying about (§12.25).
- [ ] **Discount settings inside the guardrails**: type, min and max rate, and — the last
  line of defence — an **absolute IQD cap** applied after any percentage. Category
  exclusions were declined, so without the cap a 500,000 IQD basket at 10% gifts away
  50,000 IQD (§2.3).
- [ ] **Thresholds in the safe band** — 1–3% instant discount, or a fixed-value tier
  structure. On a 25,000 IQD basket, 10% loses roughly 1,750 IQD against a ~750 IQD net
  profit (§2.3).
- [ ] The **live margin warning** fires when a dangerous rate is entered (§2.3).
- [ ] **Feature flags at their intended state.** Shipping defaults: `cloud_backup` **on**
  (a mandatory safeguard that ships switched off is not a safeguard), `customer_card_printing`
  on, `voucher_reconciliation` on; `whatsapp_integration`, `sms_fallback`, `advanced_reports`
  and `auto_update` off (§8, §12.4).
- [ ] **Branch records match the branch each bound user is assigned to.** Branch is verified,
  not trusted: a mismatched bound user is refused, so a wrong branch id presents as a
  rejected capture at the till (v1 §13.9).
- [ ] **Merchant timezone is `Asia/Baghdad`.** Period boundaries and end-of-day
  reconciliation bucket by the merchant's **local** day, not UTC — a voucher issued before
  03:00 local otherwise files under the previous day, and the report then disagrees with the
  drawer (§12.23, v1 §13.1).

---

## E. Already proven — do not re-litigate these

Listed so the run does not spend its time re-deriving what is settled.

- [x] **Discount settlement is the merchant's own affair** — §9 **closed** by operator
  ruling (§12.28), the split-payment question about Al-Bayan withdrawn. The system prints
  gross / discount / net and prescribes no bookkeeping. The default `MERCHANT_DEFINED`
  instruction states the figures and defers the procedure, so the run needs no decision
  here. One thing worth doing on the day, and it is not a blocker: *show the merchant the
  printed sentence before the first customer sees it* — if he wants a procedure on the
  paper, `VOUCHER_AS_PAYMENT` and `DAILY_PROMOTIONAL_EXPENSE` are still there and it is a
  settings change on the Discounts screen, not a rebuild.
- [x] Service survives reboot with nobody logged in — the evidence for §3's Windows Service
  over a Tauri sidecar (§12.11).
- [x] **Fail-open**: `ForwardFirstTests` breaks the capture side every realistic way — throw,
  out-of-memory, block forever, fall behind, consumer death — and the receipt still reaches
  the printer whole and in order (§4.6 rule 3, §12.14).
- [x] Rejected captures are **set aside, never deleted** (`queue/rejected/`, §12.14).
- [x] CP864 presentation-form folding, and codepage detection scoring the decoded result
  rather than the printer's claim (§12.14).
- [x] Every route names its roles; `rbac-matrix.test.ts` pins the table **and** the route
  inventory, so a route added later cannot slip past it (§12.23).
- [x] Realtime: one WebSocket upgrade per dashboard, and the banner re-reads on reconnect
  (§12.22).
- [x] Money aggregates above Int32 return correctly — tested at 3,000,000,000 IQD, both the
  JavaScript reduce and the SQL `groupBy` (§12.23, v1 §13.5).
- [x] Rate-limit buckets are per authenticated user, not per address (§12.23).
- [x] The access token no longer reaches `api.log`; the CSP is set, with
  `upgrade-insecure-requests` explicitly removed so LAN plain HTTP keeps working (§12.23).

---

## F. Open, but explicitly **not** blocking integration

Recorded so scope stays honest and nobody widens the run.

- ASCII install path and installer filename — deferred to final release; the app stays
  Arabic on every screen (§12.11).
- Code signing — deferred; the developer hand-installs, so SmartScreen is a one-time cost
  paid by the author (§12.11).
- `getOverview` loads every transaction in the range and reduces in JavaScript — fine at
  30 days, revisit before 365 (§12.23).
- Auto-updater — out of scope, flag off (§12.4).
- WhatsApp — optional module, off by default; nothing in the core loop depends on it (§8).

---

## G. Two rules that govern the run itself

- **Exercise every endpoint through the real client at least once.** A green vitest suite
  plus `curl` is not evidence: three of the four bugs found in the last two phases were
  invisible to every test that did not involve a real client (§12.20).
- **Re-check controls by trigger, not by reading.** If anything during integration changes
  what the service **serves**, what **roles** exist, or what a mitigation **assumes**, the
  controls that depended on the old shape are now suspect — the change that breaks a control
  does not touch it (§0 rule 9, §12.23).

---

### Bench note

On this development machine port 4000 is blocked; the `api-alt` launch configuration runs
the API on 4001. The field deployment is unchanged — port 4000, with the installer's
inbound rule (§12.11).
