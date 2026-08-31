# `agent/` — the Print Capture Agent

A Windows Service on the cashier PC. It sits wherever Al-Bayan prints, copies each
receipt, reads the invoice number and total off it, and sends them to the Manager
machine (CLAUDE_v3.md §4).

**It copies. It never blocks, alters, or delays a receipt.**

---

## The rule that governs everything here

A store losing the ability to print because a loyalty agent failed is an unacceptable
operational failure. §4.6 turns that into three concrete requirements, and every design
decision in this project traces back to one of them:

1. **`SPOOL_WATCH` is preferred.** It is the only mode that is genuinely *out* of the
   print path — it reads files the spooler has already written, and it can die without
   the printer noticing. Auto-detection tries it first and takes it whenever it yields
   data, even if an in-path mode would capture more.
2. **In-path modes are forward-first.** Bytes reach the real printer or port *before*
   any capture, parsing, queueing, or network work. See `Capture/PrintRelay.cs` — the
   write is the first thing in the loop and nothing may be inserted above it.
3. **The residual risk is stated, not hidden.** For the three in-path modes there is a
   window between process death and watchdog restart in which a print job can be
   **lost**, not merely delayed. `SPOOL_WATCH` has no such window. That is the whole
   reason for its preference.

---

## The first install on a real till

`RUNBOOK-first-install.md` is the order of operations for that day: what to establish
before installing anything, which log line tells you which mode won, the decision tree
when nothing captures, and the exact artefacts to bring back if it does not work. Read
it before going, not in the shop.

## Building and testing

C: on the build machine is full, so packages restore to `E:` (see `NuGet.config`, and
§12.1 for the same relocation applied to TEMP and Cargo):

```bash
cd agent && dotnet test
```

If a restore fails on disk space, the HTTP cache is the part `NuGet.config` cannot
move:

```bash
dotnet restore --no-http-cache
```

---

## The four modes (§4.2)

| Mode | Applies when | In the print path? |
|---|---|---|
| `SpoolWatch` | the POS prints through Windows | **No** — prefer this |
| `VirtualPrinter` | same, but the job is addressed to the agent | Yes |
| `SerialBridge` | the POS writes to a COM port | Yes |
| `NetworkProxy` | the printer is network-attached | Yes |

Raw USB is **not** supported and must not be attempted (§4.4): intercepting it needs a
kernel-mode filter driver, a signing certificate and Microsoft attestation. The
workaround is in the setup guide — move the printer onto the agent machine and share
it, or map `LPT1:` to the shared printer with `net use`.

---

## Setting it up in a store

1. Install the service (the installer does this; see `packaging/`).
2. Write `%PROGRAMDATA%\Walaa\agent\agent-settings.json`:

   ```json
   {
     "managerUrl": "http://192.168.0.106:4000",
     "username": "agent", "password": "…",
     "branchCode": "BAG-01",
     "agentId": "till-1",
     "mode": null
   }
   ```

   **The account must have the `AGENT` role**, and nothing else on this system should
   use it. Its password is sitting in cleartext in that file, on the machine a shop's
   staff use all day — so whatever the account can do, an attacker who reaches this PC
   can do. An `AGENT` can post a capture and read nothing: not the customer list, not a
   card number, not a voucher. Configuring a Station login here instead would hand that
   file all three, which is why `/api/v1/ingest/invoice` refuses `STATION` outright.

   `"mode": null` runs auto-detection at startup. **Print a test receipt while it
   runs** — detection cannot manufacture a print job, and a mode that sees nothing has
   not been proven unusable, only unexercised.

3. Read the detection result from the log, then pin it by setting `mode` explicitly.

### ONE-STEP MANUAL REVERT (§4.6 rule 5)

If the agent misbehaves and the store cannot print, **the merchant must be able to
restore printing without the developer**. One step, by mode:

| Mode | The one step |
|---|---|
| `SpoolWatch` | nothing to do — the agent was never in the path |
| `VirtualPrinter` | point Al-Bayan back at the real printer |
| `SerialBridge` | point Al-Bayan back at the real COM port (e.g. `COM1`) |
| `NetworkProxy` | point Al-Bayan back at the printer's own IP |

Write the original setting down during installation and leave it beside the till.
Stopping the service is *not* a revert for the in-path modes — it removes the code that
forwards.

---

## Parsing (§4.5)

Rules live in `pos-template.json` and **never** in the binary. Supporting a new
merchant's POS is a new template, not a new build; the calibration flow (§4.7) writes
one from two clicks on a captured receipt.

Three things about Arabic receipts that the tests exist to pin down:

- **CP864 stores presentation forms, not base letters.** A CP864 receipt decodes to
  U+FExx, so a template written in ordinary Arabic matches nothing until the text is
  NFKC-folded. This was found by testing, and it would have looked in the field like
  "the agent captures but never parses, at this one store".
- **Codepage detection scores the result, not the printer's claim.** `ESC t n` means
  different things on different hardware. Detection decodes with each candidate and
  measures which output looks like an Arabic receipt.
- **Arabic-Indic digits (٠١٢٣٤) are normal, not exotic.** A total found but not parsed
  is still a failure.

The governing rule when anything is ambiguous: **a doubtful amount is worse than no
amount.** A wrong total silently corrupts a customer's balance and the day's
reconciliation; a missing one shows up on the calibration screen where a human looks.

---

## Delivery and idempotency (§4.8)

Captures are written to disk *before* any delivery attempt, because the times the
manager machine is unreachable are exactly the times a cashier PC gets rebooted.

Idempotency is a three-part arrangement and all three parts must hold:

1. the capture carries an `idempotency_key` generated **once** and reused on every retry;
2. the server enforces `UNIQUE (merchant_id, branch_id, invoice_id)`;
3. a duplicate response counts as **success** here — otherwise the agent retries forever
   against a server correctly telling it the work is done.

A capture the server *rejects* (400) is moved to `queue/rejected/`, never deleted. An
integration run proved why: a schema mismatch made the server reject everything, and an
earlier version treated rejection as settled and destroyed two real sales.

---

## Verified end to end

Against a live API, with three receipts dropped into a watched spool directory:

```
captured 485 bytes from 00010.SPL   queued INV-9824 (85000 IQD)   [CP864, western digits]
captured 485 bytes from 00011.SPL   queued INV-9827 (7500 IQD)    [Windows-1256, Arabic-Indic]
captured  61 bytes from 00012.SPL   not parsed: لم يُعثر على المبلغ الإجمالي
delivered INV-9824
delivered INV-9827
delivered INV-9824 (already recorded)   ← same invoice re-captured; still ONE transaction
```

The fixtures used are in `fixtures/`, emitted by the test suite. When the real Al-Bayan
bytes arrive (§12.6), put them beside these and compare.
