# Runbook — the first install on the real Al-Bayan machine

## IF PRINTING STOPS — REVERT NOW, DIAGNOSE AFTERWARDS

Not "after one more try". Put printing back first. **A till that cannot print is a shop
that cannot sell**, and nothing else in this file is worth a minute of that.

**The revert is one step, and which step depends only on the mode the agent is running:**

| Mode | The one step that restores printing |
|---|---|
| `SpoolWatch` | nothing to do — the agent was never in the print path |
| `VirtualPrinter` | point Al-Bayan back at the real printer |
| `SerialBridge` | point Al-Bayan back at the real COM port (e.g. `COM1`) |
| `NetworkProxy` | point Al-Bayan back at the printer's own IP |

**Stopping the service is not a revert** for the three in-path modes. It removes the code
that forwards, so printing stays dead until Al-Bayan is pointed back itself.

The setting you are restoring is Al-Bayan's original printer configuration — **write it
down before you change anything** (§1) and keep it on paper, in your hand. Leave that
paper with the manager before you go, so they can do this without you.

Every finding below keeps until tomorrow. The shop's morning does not.

---

> **What this is.** A written order of operations for the single largest unknown left in
> the project: the day the Print Capture Agent meets a real Al-Bayan till for the first
> time. Everything the agent does has been proven against synthetic fixtures (§12.14);
> nothing has been proven against that machine.
>
> **Read `agent/README.md` first.** This does not repeat how the modes work — it is the
> sequence, what output means, and what to do when nothing captures.
>
> **The point of writing it down** is to arrive prepared rather than debug live in a
> working shop.

---

## 1. Before you leave

**Timing.** Go **outside trading hours** if there is any choice at all — before opening
is better than after closing, because if something is wrong you want the shop's own
staff arriving while you are still there. If it must be during trading, do it at the
quietest hour and tell the manager you may need to stop the till for two minutes.

**On the laptop:**
- [ ] The built agent, and the Manager machine reachable from the cashier PC (`curl` its
      `/health` from that PC before anything else — if the LAN is not right, none of the
      rest is diagnosable).
- [ ] `agent/fixtures/*.bin` — the synthetic receipts the parser was proven against. You
      will compare real bytes to these.
- [ ] This file.

**On paper, in your hand:**
- [ ] The current printer configuration in Al-Bayan, **written down before you change
      it** — printer name, port, IP if network. This is the revert.
- [ ] The manager's phone number.

**Ask the manager, before touching anything:**
- [ ] Printer make and model, and how it is connected — USB, LAN, or serial.
- [ ] Whether Al-Bayan prints through a Windows printer driver or "straight to the
      port". They may not know; the answer will come out of step 2 anyway.
- [ ] Whether anything else on that PC prints to the same device.

---

## 2. Establish the ground truth before installing anything

**Do not install the agent yet.** First find out how Al-Bayan prints, using nothing but
Windows.

1. **Print one receipt** from Al-Bayan, normally, while you watch
   `C:\Windows\System32\spool\PRINTERS`.
   - **A `.SPL` file appears and disappears** → the POS goes through the Windows print
     system. `SPOOL_WATCH` is available, which is the best possible outcome: it is the
     only mode that is out of the print path entirely and cannot stop the shop printing.
   - **Nothing appears** → the POS is writing to a port directly. You are looking at
     `SERIAL_BRIDGE`, `NETWORK_PROXY`, or the raw-USB case in §5.
2. **Look at Control Panel → Devices and Printers.** Is the thermal printer there as a
   Windows printer? On what port — `USB00n`, `COMn`, a TCP/IP port, `LPT1`?
3. **Write down what you found.** It decides everything below, and it is the first thing
   to send me if the day goes wrong.

---

## 3. Install, and let detection choose

**Its account first.** In the manager dashboard, **الإعدادات → حسابات الدخول** → create an
account of type **برنامج الالتقاط**, bound to this branch. Put that username and password in
`username` / `password` of `%PROGRAMDATA%\Walaa\agent\agent-settings.json`, and `managerUrl`
to the manager PC's address. **Never the owner's account** — the owner's password cannot
be reset and reaches everything; the agent's can capture invoices and nothing else, and
can be switched off from that screen in one click if this PC is lost. The manager
dashboard's **التقاط الفواتير** screen shows «وصلت … فاتورة من الصندوق» once captures are
arriving — that is the confirmation, not the absence of an error.

Install the agent with `Mode` left **null** in
`%PROGRAMDATA%\Walaa\agent\agent-settings.json`. Null means "run detection at startup";
once detection picks a winner it is written there and not re-run.

**Detection cannot manufacture a print job.** It opens each candidate for a window and
watches. **You have to print test receipts during that window** — three or four, spread
across it. A mode that saw nothing has not been shown to be unusable, only *unexercised*,
and the report says which.

Watch the log while it runs — Event Viewer, source **`Walaa Print Capture`**, or the
console if running it by hand.

### Reading the output

| Log line | What it means | What to do |
|---|---|---|
| `probe SpoolWatch: available=True — …` | The spool directory exists and is readable. Says nothing yet about whether Al-Bayan uses it. | Keep printing. |
| `spool watching produced data; stopping detection here` | **The best outcome.** Real bytes arrived out-of-path. Detection stops immediately and never even starts an in-path mode. | Stop. You are done choosing. Go to §4. |
| `probe {Mode}: available=False — …` | That mode cannot start here — no such COM port, port 9100 already in use, no printer of that name. The `Detail` says which. | Normal for modes that do not apply. Only worrying if it is the mode you expected. |
| `mode {Mode} failed to start` (warning) | It was available and threw on start. | Read the exception. Do **not** retry an in-path mode blindly while the shop is trading. |
| `تم اختيار «…» لأنه الوضع الوحيد الذي التقط بيانات فعلية` | An in-path mode won because it was the only one that saw data. | Go to §4, and read §4.1 — you have accepted the residual risk. |
| `لم يلتقط أي وضع بيانات — تأكد من طباعة فاتورة تجريبية أثناء الفحص` | Nothing captured anything. | **Did you actually print during the window?** If yes, go to §5. |

### 3.1 If an in-path mode wins

`VIRTUAL_PRINTER`, `SERIAL_BRIDGE` and `NETWORK_PROXY` all sit **in** the print path. If
the agent is not running, there is no code to forward with. The shop is now carrying a
real risk it did not carry before, bounded by the watchdog restart:

- [ ] Confirm the service's SCM failure actions are set to restart immediately.
- [ ] Print ten receipts in a row and confirm every one arrives on paper, in order.
- [ ] **Kill the agent process mid-print and confirm printing recovers.** Do this
      deliberately, with the manager watching, before you leave. If you will not do it
      today, you will find out the first time it crashes on a Thursday afternoon.
- [ ] Leave the revert instructions with the manager, physically.

---

## 4. Prove the capture, then prove the parse

These are two separate failures and they look identical from the manager's dashboard.

1. **Capture.** Print a receipt. A file should appear in the agent's queue directory.
   Bytes arriving is capture working.
2. **Parse.** Check the manager's Print Capture screen. An invoice number and a total
   should appear.

**The failure to expect here is capture-without-parse**, and §12.14 predicted exactly
how it presents: *the agent captures perfectly and never parses*, at one merchant and
not another, with no error anywhere. The cause is almost always the codepage.

- CP864 stores Arabic **presentation forms** (U+FE70–U+FEFF), not base letters. A
  template whose label reads «الإجمالي» in ordinary letters matches nothing. Labels are
  NFKC-folded before matching, which handles it — but if the real receipt uses a label
  the template does not list, it will not parse.
- Totals may be in **Arabic-Indic digits** (٠١٢٣٤). A total captured but not parsed is
  still a failure.
- **Parsing rules live only in `pos-template.json`.** Supporting this receipt is a file
  edit, never a code change. If you find yourself wanting to change C#, stop — you are
  solving it in the wrong place.

To tune the template you need the decoded text, which means turning on
`RetainReceiptText` in the settings. It is **off by default deliberately** — receipt
content is retained only when the merchant enables diagnostics (§4.5). **Turn it back
off before you leave.**

---

## 5. If nothing captures at all

Work down this list. Stop at the first one that explains what you saw in §2.

1. **Nothing was printed during the detection window.** The most common cause and the
   least interesting. Re-run detection and print during it.
2. **A `.SPL` appeared but `SPOOL_WATCH` saw nothing.** Permissions — the service
   account cannot read the spool directory. Check the account, not the code.
3. **Al-Bayan prints to `LPT1`.** Map the port to a network printer with
   `net use LPT1: \\<host>\<share> /persistent:yes` and re-detect. This is in §4.4 and
   the setup guide.
4. **Al-Bayan writes raw bytes to a USB printer.** This is the hard case §4.4 names, and
   the answer is **not** software interception. **Do not attempt a kernel-mode USB filter
   driver** — it needs a signing certificate and Microsoft attestation, and it is ruled
   out. The workaround is physical: **relocate the printer so the agent's machine owns
   it and shares it over the network**, then point Al-Bayan at the share. That turns the
   raw-USB case into an ordinary Windows printer, and `SPOOL_WATCH` becomes available.
5. **Do not attempt UI Automation on Al-Bayan.** Its UI is custom-drawn and UIA reads
   nothing inside its window. This was settled by field testing (§2.2) and re-testing it
   costs an afternoon to reach the same answer.

---

## 6. What to send me if none of it works

This is the part that matters most, because §12.6 has been waiting for exactly one of
these since the beginning. **The raw bytes are worth more than any description of them.**

- [ ] **The raw captured bytes as a file**, if anything was captured at all — the `.SPL`
      from the spool directory, or whatever landed in the queue. Not a screenshot of
      them, not retyped: **the file**. Copy it before it is cleaned up.
- [ ] **A photo of one printed receipt**, the whole thing, flat and in focus. Every
      label on it is a candidate for the template.
- [ ] **The Event Log excerpt** for source `Walaa Print Capture` covering the detection
      window — all of it, including the `probe …` lines for the modes that failed. The
      failures narrow it as much as the successes.
- [ ] **`agent-settings.json`** with the password removed.
- [ ] **What §2 found**: `.SPL` yes/no, printer name, port type, make and model.
- [ ] **A photo of Al-Bayan's printer configuration screen**, whatever it looks like.

With the raw bytes I can tell you the codepage, whether the digits are Arabic-Indic, and
what the template needs, without being in the shop. Without them, every answer is a
guess. The likely outcome is that the shipped parsers already match and this is a
template edit; if not, it is one more parser and no other change (§13.6).

---

## 7. Before you leave the shop

- [ ] Printing works. Print five receipts and watch all five come out.
- [ ] `RetainReceiptText` is back **off** if you turned it on.
- [ ] The capture mode in `agent-settings.json` is the one you intended, not a leftover
      from a test.
- [ ] The manager has the revert instructions **on paper** and knows they can use them
      without you.
- [ ] The service starts on boot — reboot the cashier PC once and confirm.
- [ ] You have the raw bytes of at least one real receipt, whether or not it all worked.
      Even a fully successful day should not end without them: they become the fixture
      that stops this being unknown territory next time.

---

## What this day cannot tell you

Capture working here says nothing about the **Loyalty Station** on its tablet, the card
scanner, or the discount reaching a customer. Those are separate checklist items
(`docs/legacy/PRE-INTEGRATION-CHECKLIST.md` §A). Do not let a good capture day turn into an
unplanned end-to-end attempt in a shop that is about to open.
