# Licensing — ولاء 0.3.0

ولاء is sold to merchants for a **one-time payment**, with a **trial whose length the
provider chooses** per shop. Licensing is **entirely offline**: no server, no account, no
call home. A merchant reads a device number to the provider; the provider sends back a
signed code; the merchant pastes it.

**The rule above every other: a shop that has paid is never stopped.** A corrupted licence,
a lost clock record, a Windows reinstall, a bug in the gate — each has a way back that
needs neither a visit nor the internet ([§9](#9-never-locking-out-a-paying-shop)). The
protection against unpaid copies is deliberately set at deterrence against casual copying
([§18](#18-what-this-does-not-protect-against)).

Contents

1. [Who does what](#1-who-does-what)
2. [How it is built](#2-how-it-is-built)
3. [The device ID — and what changes it](#3-the-device-id--and-what-changes-it)
4. [The licence code](#4-the-licence-code)
5. [Issuing (provider)](#5-issuing-provider)
6. [Activating (merchant)](#6-activating-merchant)
7. [The emergency code, read over the phone](#7-the-emergency-code-read-over-the-phone)
8. [Statuses, warnings and what each does](#8-statuses-warnings-and-what-each-does)
9. [Never locking out a paying shop](#9-never-locking-out-a-paying-shop)
10. [At the till](#10-at-the-till)
11. [The offline queue](#11-the-offline-queue)
12. [The clock, and the permanent record of it](#12-the-clock-and-the-permanent-record-of-it)
13. [Features](#13-features)
14. [Protecting the private key](#14-protecting-the-private-key)
15. [The development key, and the installer gate](#15-the-development-key-and-the-installer-gate)
16. [Upgrading an existing shop to 0.3.0](#16-upgrading-an-existing-shop-to-030)
17. [Tests and drills](#17-tests-and-drills)
18. [What this does not protect against](#18-what-this-does-not-protect-against)

---

## 1. Who does what

| Who | Does | With |
|---|---|---|
| **Provider** | Generates the key pair once; issues trial, extension and perpetual codes; reads emergency codes over the phone | `tools/license-issuer` — never shipped |
| **Merchant** | Reads the device number out; pastes a licence code or types an emergency code | «الإعدادات ← الترخيص» in the manager dashboard |
| **Service** | Computes the device ID, verifies codes, decides the status, refuses what read-only refuses | `crates/walaa-license` (Rust), loaded by the API |

## 2. How it is built

```
crates/walaa-license        the rules, in Rust: device ID, code format, Ed25519
                            verification, emergency-code chain, status evaluation,
                            clock anchors. The provider's PUBLIC key and the public
                            tip of the emergency-code chain are constants in
                            src/public_key.rs — compiled in, not configuration.
packages/license-native     that crate as a Node native module (napi-rs), loaded by
                            the API. Two builds:
                              walaa-license.node       — ships; trusts the provider key
                              walaa-license.test.node  — tests only; trusts the
                                                         published test key and can sign.
                                                         Never staged, never shipped.
apps/api/src/services/license.service.ts
                            stores codes and times, asks the module, applies the answer.
tools/license-issuer        the provider's signing tool (README.md there).
```

Every decision — is this code genuine, is it for this machine, which licence governs,
what is the status now — is made in Rust. The service asks on **every** request that
records a sale, registers a customer or redeems a voucher. The dashboard and the till
read the verdict from `GET /api/v1/license`; they decide nothing.

## 3. The device ID — and what changes it

`WL-XXXX-XXXX`, computed in Rust on the manager PC from exactly two sources:

- the Windows **MachineGuid** (`HKLM\SOFTWARE\Microsoft\Cryptography`, 64-bit view) —
  a random value Windows writes when it is installed;
- the **volume serial** of the system drive (`%SystemDrive%\`) — written when the drive
  is formatted.

`SHA-256("walaa-device-v1|<guid, lower-case>|<serial as 8 upper-case hex digits>")`,
then the first eight symbols in base 30 over `23456789ABCDEFGHJKMNPQRSTVWXYZ`.

> **Why base 30 and not Base32.** The brief asked for Base32 without `I L O U 0 1`. The
> 26 letters and 10 digits are 36 symbols; without those six they are **30** — and 30
> symbols cannot be Base32, which needs 32. So the ID uses base 30 over exactly the
> symbols the brief allows.

**It is computed once, on the first start of 0.3.0, and stored in the database.** From
then on the stored ID *is* the device ID; licences are checked against it. If a source
changes later, the service keeps the stored ID, writes `license.device_sources_changed`
to the audit trail naming which source changed, and **does not invalidate the licence**.
The database holds only SHA-256 digests of the two sources.

| Change | Computed ID | Licence |
|---|---|---|
| New network adapter, RAM, CPU, GPU, extra disks | unchanged — not a source | unaffected |
| Motherboard replaced, same Windows | unchanged — MachineGuid lives in Windows, not the board | unaffected |
| Windows updates, including feature upgrades; renaming the PC; new IP; joining a domain | unchanged | unaffected |
| System drive cloned sector-by-sector to a new disk | usually unchanged (the serial is copied) | unaffected |
| System drive replaced and Windows reinstalled, **database restored from backup** | changes | **unaffected** — the restored database carries the stored ID and the codes; audit warning |
| Windows reinstalled in place, data folder kept | changes | **unaffected** — stored ID kept; audit warning |
| Fresh Windows, fresh install of ولاء, **no backup restored** | changes | a new installation: `UNLICENSED` until re-bound |

**Re-binding without a visit** (the last row — the only one that needs the provider):

1. The merchant reads the new `WL-` number from «الإعدادات ← الترخيص» over the phone.
2. The provider reads back an **emergency code** for the new number
   (`license-issuer unlock --device WL-NEW --days 30`). Full operation returns at once
   ([§7](#7-the-emergency-code-read-over-the-phone)).
3. When the merchant can receive a message, the provider sends a perpetual licence for
   the new number (`license-issuer issue --device WL-NEW --perpetual --note "replaces WL-OLD"`),
   which the merchant pastes. The log keeps both.

Or, simpler still: restore the shop's backup onto the new machine — the licence comes
with the data, and the provider is not involved at all.

**Cost: one phone call and one message. No visit, in any case.**

## 4. The licence code

The payload is compact JSON, fields in this order:

```json
{"v":1,"lid":"<uuid>","did":"WL-XXXX-XXXX","type":"trial|perpetual","iat":<unix>,"exp":<unix|null>,"feat":["drive_backup","multi_device"],"note":"<store name, optional>"}
```

The code is `base64url(payload) + "." + base64url(signature)`, no padding, where the
signature is **Ed25519 over the exact payload bytes**, checked with `verify_strict` before
the JSON is even parsed. The issuer prints it in **60-character lines**. On paste, all
whitespace and the invisible direction marks some message apps insert are removed first.

| Check | Refusal | What the merchant reads |
|---|---|---|
| Two base64url parts, sane size | `MALFORMED` | هذا ليس رمز تفعيل كاملاً — تأكّد أنك نسخت رسالة المزوّد كاملة… |
| Signature matches the embedded key | `BAD_SIGNATURE` | هذا الرمز لا يطابق توقيع مزوّد البرنامج… |
| `v` is 1 | `UNSUPPORTED_VERSION` | هذا الرمز صادر بصيغة أحدث مما يقرؤه هذا الإصدار… |
| `did` is this installation's ID | `DEVICE_MISMATCH` | هذا الرمز صادر لجهاز آخر (WL-…)، ورقم هذا الجهاز WL-…… |
| a trial not already over | `EXPIRED_CODE` | انتهت مدة هذا الرمز في …… |
| clock not before the issue time | `CLOCK_BEHIND` | تاريخ هذا الجهاز أقدم من تاريخ إصدار الرمز… |
| no trial over a perpetual licence | `PERPETUAL_ACTIVE` | هذا الجهاز مفعّل بترخيص دائم… |

## 5. Issuing (provider)

Full instructions and real output: [`tools/license-issuer/README.md`](../tools/license-issuer/README.md).

```bash
license-issuer keygen                                        # once, ever
license-issuer issue  --device WL-7K3M-9QXP --days 14        # a 14-day trial
license-issuer issue  --device WL-7K3M-9QXP --days 5 --extend
license-issuer issue  --device WL-7K3M-9QXP --perpetual      # paid: never expires
license-issuer unlock --device WL-7K3M-9QXP --days 7         # emergency code, by phone
license-issuer list
```

**The trial length is yours alone.** The application has no built-in trial: a new
installation is `UNLICENSED` until given a code, and a trial lasts exactly the `--days`
you issue.

## 6. Activating (merchant)

In the manager dashboard: **الإعدادات ← الترخيص** (the banners and the top-bar chip all
open it).

1. **رقم هذا الجهاز** — large, with «نسخ الرقم», under «أرسل هذا الرقم إلى المزوّد للحصول
   على رمز التفعيل».
2. The licence code goes into «رمز التفعيل», pasted as it arrived, then «تفعيل».
3. The status changes **at once** — no restart. The till can sell on its next scan.
4. **سجل التفعيل** and **سجل أحداث الترخيص** list every activation, phone code and clock
   event, with who and when.

Every attempt — accepted or refused, with its reason — is recorded
(`license.activated` / `license.activation_failed`).

## 7. The emergency code, read over the phone

For the moment no message can reach the shop PC — the licence file is destroyed, Windows
was reinstalled, the clock record is wrong, something in the gate is broken — and the
shop must trade *now*.

**What the merchant does:** «الإعدادات ← الترخيص» → reads «رقم هذا الجهاز» to the
provider → types the fifteen symbols the provider reads back into «رمز الطوارئ» →
«تشغيل فوري». Full operation returns with that request.

**What the provider does:** `license-issuer unlock --device WL-XXXX-XXXX [--days N]`
(1–30, default 7), and reads out `XXXXX-XXXXX-XXXXX`.

**How it is checked without a secret in the program.** A signature is 64 bytes — far
too long to read aloud. So the codes come from a **hash chain**: at `keygen` the issuer
derives a secret from the private key and hashes it forward 7,300 times (twenty years of
days); only the last value, the *tip*, is compiled into the program. The code for day
`d` is the value `d` links before the tip. The program hashes a typed code forward: if it
reaches the tip after `k` steps, the code is genuine and was issued for day `k`.
Producing a later day's code means inverting the hash — only the key's holder can avoid
that. **Nothing in the build, and nothing on the build machine, can make a code.**

- Fifteen symbols in the device-ID alphabet: 14 carry a 64-bit value, the fifteenth is
  a Luhn mod-30 **check symbol** that catches every single misheard symbol and most
  swapped pairs — a typo is refused as a typo, not as a forgery.
- **Mixed with the device ID**: the code read to one shop does not work typed into another.
- Case, spaces, dashes and Arabic-Indic digits do not matter.
- Runs **through the end of the UTC day N days after it was issued**, judged against the
  later of the system clock and the latest time this installation has recorded — so
  winding the clock back does not stretch it.
- **Overrides every stop**: unlicensed, expired, clock problems, a stored licence that
  fails its signature. It never hides a better licence: a perpetual or a longer trial
  still shows as such.
- Followed, like a trial, by **five days of grace**.
- Stored, mirrored beside the clock file (a restore does not lose it), and recorded
  (`license.unlock_entered` / `license.unlock_failed`).

| Refusal | What the merchant reads |
|---|---|
| `TYPO` | في الرمز حرف مكتوب خطأً — اطلب من المزوّد أن يعيد قراءته، وقارن المجموعات الثلاث حرفاً حرفاً. |
| `NOT_VALID` | هذا الرمز ليس لهذا الجهاز — تأكّد أن المزوّد أصدره لرقم الجهاز WL-…، ثم اطلب منه إعادة قراءته. |
| `EXPIRED` | انتهت مدة هذا الرمز في … — اطلب من المزوّد رمزاً جديداً. |
| `MALFORMED` | رمز الطوارئ خمسة عشر حرفاً ورقماً في ثلاث مجموعات من خمسة… |

### Hearing one code gives nothing later — proven

Anyone who hears a code can take the shop's mixing off (it is a public function) and hash
the link forward. **Forward is earlier:** the link for end day `d` hashes to the link for
`d − 1`. So every code computable from a heard one **stops working on or before the day
the heard one does**, and the next day's code is a preimage of today's — work only the
key's holder avoids. The tests in `crates/walaa-license/src/unlock.rs`:

| Test | What it shows |
|---|---|
| `everything_derivable_from_a_heard_code_stops_working_when_it_does` | A 30-day code hashed forward through every link to the tip: each result is a genuine code for an *earlier* day, refused as `EXPIRED` the moment the heard code ends; past the tip nothing is a code at all. |
| `tomorrows_code_cannot_be_computed_from_todays` | `step(tomorrow) = today`, `step(today) ≠ tomorrow`, and 7,400 steps forward from today's code never meet tomorrow's. |
| `a_later_end_day_is_always_further_from_the_tip` | Over sixty consecutive end days each code is the preimage of the one before, whatever the issue date and length. Reversing the chain's direction fails this test. |

### A used code cannot be replayed

A code's window is **fixed when it is issued** — through the end of a calendar day — and is
not started by typing it. Entering it again changes nothing: there is nothing to consume
or restart. Once its end and the five grace days are past it is refused as `EXPIRED`,
judged against the latest time recorded in any of the three places (§12).
`apps/api/src/__tests__/license-resilience.test.ts`, «a phone code whose window has passed»:

| After the window has passed | Result |
|---|---|
| Typed again | refused `EXPIRED`; sales refused |
| Program reinstalled with a new database — the uninstaller removes only the service and its firewall rule; `%PROGRAMDATA%\Walaa` and the registry value stay (`packaging/service-host/src/main.rs`, `uninstall`) | refused; the mirror file does not put the code back |
| A backup taken while the code ran is restored, and the clock set back to match | refused — the registry and the data folder remember the later time |
| The database moved to another PC, whose clock is set back | refused — the moved database carries the later time itself |
| **Every** record rolled back together: a copy made during the window, on a PC with no registry value and no data folder, its clock set back into the window | **accepted** — until the code's own end plus grace *by that wrong clock*; then it cannot be wound back again |

The last row is the one no offline check can refuse: with every record of time replaced by
an earlier copy, the program is in exactly the state it was in when the code was typed.
The test pins it so it cannot widen. Its cost to whoever does it: a manager PC whose date
is wrong on every receipt and report, and — for each further window — restoring the same
old copy again, discarding every sale and customer recorded since.

### Capacity: a calendar of end days, not a stock of codes

- The chain has **7,301 end days** (chain days 0–7,300), shared by every shop. Issuing
  consumes nothing.
- A code is fixed by **(shop, end day)**: a shop can have at most one distinct code per end
  day — 7,301 over the chain's life — and every shop has its own.
- **Several codes for one shop in one week** are several end days: each works on the day it
  is read, the latest end governs, and the same end day twice is the same code
  (`issuing_uses_nothing_up_one_code_per_shop_per_end_day`).
- The chain's last end day is **7,299 days after `keygen`** — just under twenty years. For
  the development key: made 2026-09-14, last end day 2046-09-08; a one-day code can be
  issued until 2046-09-06, a thirty-day code until 2046-08-08.
- **At the end** the issuer refuses — `that date is outside this key's unlock chain` — and
  nothing changes at any shop: licence codes are signed and do not depend on the chain.
  Only the phone path ends (`the_chain_runs_out_at_the_provider_not_at_the_shop`). From a
  year before, `license-issuer unlock` prints the date it ends.
- **Renewing** means a new tip compiled into a new build. The new chain must come from a
  **new secret label** (`walaa-unlock-secret-v2|…`), never the same secret under a later
  epoch: the same links under a later epoch would move every code ever read onto later
  dates.

## 8. Statuses, warnings and what each does

| Status | Meaning | Recording |
|---|---|---|
| `UNLICENSED` | No valid code (the default) | **read-only** |
| `TRIAL` | A trial, before its end | full |
| `EMERGENCY` | An emergency code is carrying the shop | full |
| `GRACE` | A trial or an emergency window ended less than **5 days** ago | **full** |
| `EXPIRED` | A trial and its grace are over | **read-only** |
| `PERPETUAL` | Paid; never expires; the clock is not consulted | full |
| `TAMPERED` | Clock behind the recorded time by more than 2 h, or the stored code fails its signature | **read-only** |

**Warnings escalate from two weeks out, not hours.** The service grades every state:

| Grade | When | Where it shows |
|---|---|---|
| `notice` | a trial 8–14 days from its end | the bell |
| `warning` | a trial 4–7 days from its end; any emergency window | a countdown chip in the top bar of every screen |
| `urgent` | a trial's last 3 days; an emergency window's last 2; every grace day; every read-only state | a red banner on every screen, undismissible, and on every launch |

**Read-only refuses exactly three things**, each with HTTP 423 `LICENSE_READ_ONLY`:
recording a sale (`scanCard`), registering a customer (`createCustomer`) and redeeming a
voucher (`redeemVoucher`). **Everything else keeps working** — reports, the customer
list, card history and card batches, invoice capture from the register, exports,
backups (local and Drive), the restore test, restoring. The merchant's data is never
withheld.

## 9. Never locking out a paying shop

| What goes wrong | What happens | The way back — no visit, no internet |
|---|---|---|
| Licence rows deleted or corrupted | the mirror file puts the codes back on start | automatic |
| Licence rows **and** mirror destroyed | `UNLICENSED` / `TAMPERED` | paste the original message again, or an **emergency code** by phone |
| Database restored from before activation | the mirror puts the codes back | automatic |
| A clock record lost | the other two outvote it; a disagreement is recorded | automatic |
| The clock wrong (dead battery, mistake) | a perpetual licence ignores it; a trial is `TAMPERED` until corrected | fix the clock — it clears by itself — or an emergency code |
| Windows reinstalled / system disk replaced | stored ID kept if the database survives or is restored | automatic; otherwise emergency code, then a new licence ([§3](#3-the-device-id--and-what-changes-it)) |
| **The licensing module missing or corrupt, or a bug in the check** | the gate applies **the last status the module recorded**, bounded as below, with a red banner on every screen naming the day recording stops; recorded as `license.check_failed` | reinstall from the full installer — a phone code cannot be entered until then, because the module checks it |
| A trial or emergency window ends | five days of `GRACE`, full operation, red banner | a licence or another emergency code |
| A sale queued offline arrives after the licence lapsed | accepted — it happened while licensed ([§11](#11-the-offline-queue)) | automatic |

### What the last recorded status may authorise, and for how long

Falling back buys time and says so loudly. It never grants more than the module would.

| Last recorded by the module | While the module is out | For how long |
|---|---|---|
| `PERPETUAL` | recording | until the module is back. The clock is ignored, as the module ignores it for a perpetual licence: there is no end to stretch, and PERPETUAL is only ever recorded after the module verified a perpetual licence here |
| `TRIAL`, `EMERGENCY`, `GRACE` | recording | until the **earlier** of its own recorded end (grace included) and **7 days after the module last confirmed it** (`last_status_at`, refreshed every ten minutes while the module works) |
| `UNLICENSED`, `EXPIRED`, `TAMPERED`; a time-limited status with no recorded end; nothing | nothing | — |

Time is judged as the module judges it: against the later of the clock and the latest
recorded time (the database and the data-folder file — the registry value is the
module's). A clock more than two hours behind that record refuses outright (shown as
`TAMPERED`), and the fallback keeps moving the record forward, so time spent without the
module still counts. It never writes the status it falls back on, so it cannot ratchet
itself up. Removing the module adds no day to anything; for a long trial it takes days
away.

**Tested as an attacker would** — «the fallback, attacked» in `license-resilience.test.ts`.
All seven failed against the previous fallback, which judged time by the system clock
alone, so a deleted module plus a wound-back clock ran a trial indefinitely:

| Attack | Result |
|---|---|
| Module deleted mid-trial, clock wound back to put off the end | refused, `TAMPERED` |
| Module deleted, the trial runs out, clock wound back | refused |
| Module deleted, an older database restored, the service restarted, clock wound back | refused — the data-folder record outvotes the database |
| Module deleted with 60 trial days left | trades for 7 days, the banner naming the day; the module back → the trial, its days intact |
| The recorded end removed from the database | refused |
| Many sales while the module is out | the recorded status unchanged; the recorded time moved on |
| Perpetual, module deleted, clock wound back 30 days | trades; red banner; no end date |

The service **starts** without the module.

## 10. At the till

When the manager PC's licence is read-only and the cashier scans a customer's card and
invoice:

- **What the cashier sees:** one amber card — «لم تُحتسب هذه الفاتورة للزبون الآن», then
  «حُفظت على هذه المحطة، وتُضاف إلى سجل الزبون تلقائياً عند تفعيل البرنامج على جهاز
  المدير. لا خصم على هذه الفاتورة، لا الآن ولا بعد التفعيل — تابع خدمة الزبون كالمعتاد.»,
  then, set apart under «قل للزبون:», the sentence to say to him (below) — with the usual
  full-width «مسح للزبون التالي» bar (Escape works; it clears itself after 90 seconds).
  Nothing is stuck and nothing needs retrying.
- **What the customer experiences:** he pays full price for this basket and **does not get
  its discount — not now, and not after activation.** The discount is worked out from each
  invoice at the moment of sale and applied on the register by the cashier; a link that
  waits is credited later with `issueDiscount: false` (`scan.service.ts`, `ScanOptions`),
  because a voucher issued after he has paid and left is a discount the drawer cannot
  account for. What he keeps is the purchase on his card's history — lifetime totals are
  for reporting (CLAUDE_UPDATE_4.md), not an input to any discount. What the cashier says:

  > **«عذراً، نظام الخصومات متوقف اليوم، فلا خصم على هذه الفاتورة — لكنها محفوظة على بطاقتك.»**

  True whatever happens next; it promises no discount later, because there will be none.
- **What happens to the invoice:** it was already captured from the register — capture is
  never refused. What waits is its link to the customer, kept on the till **pinned to that
  exact invoice number** and sent on every flush. On activation (or an emergency code) it
  is credited at the price paid, with no discount and no voucher — tested: «held for the
  licence, are counted on the manager screens until credited — in full, with no discount».
- **The header** says «N محفوظة بانتظار التفعيل» — the whole queue, once the manager PC has
  refused any of it for the licence — and a strip under it explains the read-only state
  before the first scan.

### Held sales have an end

| Question | Answer |
|---|---|
| Do they accumulate without limit? | No. A till holds at most **2,000** (`HELD_CAP`, `apps/station/src/lib/queue.ts`) — about a week at a few hundred linked sales a day, and about 430,000 characters of browser storage. |
| What happens at the cap? | A further refused link is **not** kept. The cashier gets a red card — «لم تُحتسب هذه الفاتورة ولم تُحفظ … أبلغ المدير الآن ليفعّل البرنامج أو يتصل بالمزوّد لرمز طوارئ» — and a sentence for the customer: «عذراً، نظام الخصومات متوقف اليوم، فلا خصم على هذه الفاتورة، ولن تُسجَّل على بطاقتك.» The invoice itself stays captured. A browser that refuses the write gets the same honesty instead of a stuck screen. |
| Are they visible? | At the till, the header count. On the manager PC, the red read-only banner on every screen adds «الفواتير المحفوظة على المحطات بانتظار التفعيل: N، أقدمها من …», and «الإعدادات ← الترخيص» shows «فواتير محفوظة على المحطات: N على محطة واحدة، أقدمها من …». Each till reports with every flush — every 30 seconds while it holds any — so after a service restart the figure is back within a minute; a till switched off keeps its last report. |
| Can they expire past the 30-day window? | No. The 30 days decide only what can be credited **before** activation, judged by when it happened. After activation every held sale is credited whatever its age (tested: «is not judged by its own date when older than thirty days — it waits for activation instead»). Nothing on the till expires. |
| Can they be lost? | Only with the till's storage: its browser data cleared, or the tablet reset or replaced, before activation. The manager screens will have shown the count, so such a loss is visible rather than silent. |
| After activation | Held links go after everything else in each batch — they never block a sale that can be credited — and drain back to back rather than a hundred every thirty seconds. |
- **Registering a new customer** is refused with «لا يمكن تسجيل زبون جديد الآن: … لم
  يُسجَّل شيء — أكمل البيع كالمعتاد، واحتفظ بالبطاقة لتسجيله لاحقاً.» The form stays
  filled. It is not queued: a registration binds a card and checks the phone number now.
- **Voucher redemption** is not done at the till in this build; on the dashboard it is
  refused with a sentence, and the voucher stays valid.

## 11. The offline queue

A queued sale, registration or redemption is accepted if **either**

- recording was allowed **when it happened** — judged by the till's own timestamp for
  it, capped at the present and honoured up to **30 days** back, against every licence
  and emergency code ever stored (a trial counts through its grace); **or**
- recording is allowed **now**.

Otherwise it is answered `FAILED`, which the till never discards: it stays queued and is
sent again on every flush, and applies as soon as the shop is activated. **Nothing is
ever dropped by a licensing rule.** Each item accepted because of when it happened while
the shop is now read-only is recorded (`license.accepted_by_occurrence`).

## 12. The clock, and the permanent record of it

The latest time the installation has seen is kept in three places, written together and
read together, the latest winning:

| Where | What |
|---|---|
| The database | `installation_state.last_seen_at` |
| The registry | `HKCU\Software\Walaa\LastSeenAt`. The service runs as LocalSystem, so this is `HKEY_USERS\S-1-5-18\Software\Walaa`. |
| A hidden file | `.license-clock` in the data folder (`C:\ProgramData\Walaa`) |

A clock more than 2 hours behind it makes a trial `TAMPERED` until corrected — then it
clears by itself. **Every such event is recorded permanently**, and so is its end:

`license.clock_rollback` carries the evidence to tell a merchant who wound the clock
back from one whose CMOS battery died:

| Field | Meaning |
|---|---|
| `cause` | `FIRMWARE_RESET` — the clock read a date before this program's key existed (or before 2020): nobody picks that on purpose; typical of a dead motherboard battery or a BIOS reset. `CHANGED_WHILE_RUNNING` — wall-clock time jumped back while monotonic time ran forward: somebody changed the date with the program open. `SET_BACK_WHILE_OFF` — the machine started with a plausible but earlier date. |
| `behindMinutes`, `systemTime`, `latestSeen` | how far, what the clock said, the last time known to be real |
| `phase` | `startup` or `running` |
| `windowsUptimeMinutes` | a clock years in the past a minute after boot is what a battery failure looks like |
| `previousRollbacks` | once, or a pattern |
| `stoppedSales` | whether it stopped the shop (a perpetual licence ignores the clock; the event is recorded anyway) |

`license.clock_restored` closes it: `durationMinutes` and `refusedDuring` (sales refused
while it lasted).

**Permanent:** licence events are written to the audit trail **and** appended to
`license-events.log` in the data folder. Restoring an older database does not erase
them — on the next start the file's events are put back (`restoredFromFile`). Events are
filed at the best-known real time, so a log recorded while the clock read 2001 still
reads in order. The provider reads them in «سجل أحداث الترخيص», with the count of
clock set-backs ever recorded at the top.

## 13. Features

`feat[]` lists paid features. **`drive_backup`** gates *uploading* backups to Google
Drive; connecting, listing and restoring from Drive are never gated. An emergency window
over a destroyed licence keeps every feature, so the shop's Drive backups do not stop
because its licence file did. `multi_device` is reserved; nothing checks it yet.

## 14. Protecting the private key

The whole scheme rests on `issuer-key.json` and its password — the emergency-code chain
is derived from the same private key. See the
[issuer README](../tools/license-issuer/README.md#backing-up-the-key):

- **Lose the file or the password and no licence and no emergency code can ever be issued
  again** — recovery means a new key, a new build for every shop, installed in person.
- Two copies of the home folder, off the computer, in two places; the password kept
  separately; one test issue from a copy to prove it.
- Only the public half — the public key and the chain tip — belongs in the repository.

## 15. The development key, and the installer gate

Until the provider runs `keygen`, `crates/walaa-license/src/public_key.rs` holds a
**development** key (fingerprint `49C862E0D57E50B7`) whose private half and password are
committed in `tools/license-issuer/dev-key/`. It lets the tests and `pnpm package:verify`
exercise activation and emergency codes end to end — and must never reach a shop:

- `pnpm package:installer` first runs `packaging/scripts/verify-license-key.mjs`, which
  loads the **staged** module and refuses unless it embeds a production key.
- `stage.mjs` copies the module by allowlist and fails if the test build reaches the
  staged runtime.

`pnpm package:verify` uses `WALAA_VERIFY_LICENSE_CODE` / `WALAA_VERIFY_UNLOCK_CODE` if set
(required once the production key is embedded — issued for the build machine), otherwise
the development issuer.

## 16. Upgrading an existing shop to 0.3.0

Two database migrations (`20260914090000_offline_licensing`,
`20260915090000_licensing_resilience`), so an **in-person upgrade**: take a backup and
copy it off the machine; install 0.3.0; the shop starts **`UNLICENSED` — read-only** until
given a code. Have it ready: read the device number on the spot, issue, paste — or read
an emergency code if the message cannot arrive in time.

## 17. Tests and drills

| Where | Run | Covers |
|---|---|---|
| `crates/walaa-license` | `cargo test` | signatures, devices, versions, pasting; every status and warning grade; grace; clock rollback and recovery; conflicting anchors; emergency codes — round trip, every single misheard symbol caught, another shop's code refused, another key's refused, expired, a wound-back clock not reviving one, grace after the window, never hiding a better licence; queued sales judged by when they happened; the chain's direction — nothing derivable from a heard code outlives it, tomorrow's is not computable from today's; capacity and the chain's end |
| `tools/license-issuer` | `cargo test` | key sealing, payload rules, the log of licences and emergency codes |
| `apps/api` — `license.test.ts`, `license-resilience.test.ts` | `pnpm --filter @walaa/api test` | through HTTP with the real Rust verifier: every refusal; read-only's three refusals and everything it keeps open; emergency codes over a destroyed licence, a corrupted one and a clock problem; grace after them; a failing check with a licensed shop, an unlicensed copy and a running trial; queued sales synced after the licence lapsed, made while unlicensed, older than 30 days, dated in the future; clock events with their causes, their end, surviving a restore; a used phone code after a reinstall, a restore and a move; the fallback attacked — clock wound back, an older database, a long trial, a missing end; held sales counted and credited in full |
| `packaging` | `pnpm package:verify` | a clean production-mode install: unlicensed → refused in Arabic → activated → trades; then **the recovery drill**: licence destroyed (rows deleted, mirror overwritten) → read-only → emergency code typed as heard → trades with no restart → licensing module deleted → service starts and still trades |

## 18. What this does not protect against

Stated plainly, so nobody overestimates it — the bar is deterrence against casual copying:

- **The gate runs in the API's JavaScript bundle.** An administrator who edits
  `walaa-api.cjs` bypasses licensing.
- **The fallback trusts database columns.** Someone who deletes the licensing module *and*
  edits `last_status` to `PERPETUAL` gets a working shop; a time-limited status buys at
  most the week `last_status_at` allows, which is a column too. The fallback does not
  re-check signatures.
- **Emergency codes are 64-bit.** Forging one means inverting a 64-bit hash, ~2⁶⁴ work —
  beyond casual, not beyond a determined attacker. The device mixing is a public
  function: someone technical who hears one shop's code could derive another shop's code
  for the same window. It stops a code being passed on as-is, nothing more.
- **The licence follows the database.** Restoring a shop's backup onto another PC carries
  its device ID and codes along — deliberately; the audit trail records the change.
- **Deleting all three clock records and the events file at once** forgets the recorded
  time and its history. Each alone is recorded and outvoted.
- **A clock record in the future plus a destroyed licence.** If the clock once ran far
  ahead, the recorded time sits in the future and an emergency code — judged against it —
  can read as already expired. A freshly issued *licence* code resets such a record on
  activation; an emergency code cannot. In that one combination the way back is the long
  code by message.
- **The till's queue lives in the tablet's browser storage.** Clearing the browser's data
  on the till loses links it was holding — offline or for activation. The manager screens
  show how many each till held, so the loss is visible.
