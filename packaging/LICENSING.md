# Licensing — ولاء 0.3.0

ولاء is sold to merchants for a **one-time payment**, with a **trial whose length the
provider chooses** per shop. Licensing is **entirely offline**: no server, no account, no
call home. A merchant reads a device number to the provider; the provider sends back a
signed code; the merchant pastes it.

Contents

1. [Who does what](#1-who-does-what)
2. [How it is built](#2-how-it-is-built)
3. [The device ID](#3-the-device-id)
4. [The licence code](#4-the-licence-code)
5. [Issuing a code (provider)](#5-issuing-a-code-provider)
6. [Activating a code (merchant)](#6-activating-a-code-merchant)
7. [Statuses and what each one does](#7-statuses-and-what-each-one-does)
8. [Every scenario](#8-every-scenario)
9. [The clock](#9-the-clock)
10. [Features](#10-features)
11. [Protecting the private key](#11-protecting-the-private-key)
12. [The development key, and the installer gate](#12-the-development-key-and-the-installer-gate)
13. [Upgrading an existing shop to 0.3.0](#13-upgrading-an-existing-shop-to-030)
14. [Tests](#14-tests)
15. [What this does not protect against](#15-what-this-does-not-protect-against)

---

## 1. Who does what

| Who | Does | With |
|---|---|---|
| **Provider** | Generates the key pair once; issues trial, extension and perpetual codes | `tools/license-issuer` — never shipped |
| **Merchant** | Reads the device number out; pastes the code | «الإعدادات ← الترخيص» in the manager dashboard |
| **Service** | Computes the device ID, verifies codes, decides the status, refuses what read-only refuses | `crates/walaa-license` (Rust), loaded by the API |

## 2. How it is built

```
crates/walaa-license        the rules, in Rust: device ID, code format, Ed25519
                            verification, status evaluation, clock anchors.
                            The provider's PUBLIC key is a const array in
                            src/public_key.rs — compiled in, not configuration.
packages/license-native     that crate as a Node native module (napi-rs), loaded by
                            the API like the argon2 addon. Two builds:
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
records a sale, registers a customer or redeems a voucher, and on every card batch and
invoice capture (which are allowed regardless, and only logged). The dashboard and the
till read the verdict from `GET /api/v1/license`; they decide nothing.

## 3. The device ID

`WL-XXXX-XXXX`, computed in Rust on the manager PC from two sources:

- the Windows **MachineGuid** (`HKLM\SOFTWARE\Microsoft\Cryptography`, read from the
  64-bit view), and
- the **volume serial** of the system drive (`%SystemDrive%\`).

`SHA-256("walaa-device-v1|<guid, lower-case>|<serial as 8 upper-case hex digits>")`,
then the first eight symbols in **base 30** over `23456789ABCDEFGHJKMNPQRSTVWXYZ`.

> **Why base 30 and not Base32.** The brief asked for Base32 without `I L O U 0 1`. The
> 26 letters and 10 digits are 36 symbols; without those six they are **30** — and 30
> symbols cannot be Base32, which needs 32. So the ID uses base 30 over exactly the
> symbols the brief allows. The number is what a merchant reads aloud over the phone,
> which is why the easily misread symbols are gone.

It is computed **once**, on the first start of 0.3.0, and stored in the
`installation_state` table. From then on the stored ID is the device ID. If a source
changes later — a replaced system drive, a reinstalled Windows — the service keeps
running under the stored ID, writes `license.device_sources_changed` to the audit trail
naming which source changed, and **does not invalidate the licence**. The database holds
only SHA-256 digests of the two sources, never the GUID or the serial themselves.

## 4. The licence code

The payload is compact JSON, fields in this order:

```json
{"v":1,"lid":"<uuid>","did":"WL-XXXX-XXXX","type":"trial|perpetual","iat":<unix>,"exp":<unix|null>,"feat":["drive_backup","multi_device"],"note":"<store name, optional>"}
```

- `v` — format version; this build reads `1`.
- `lid` — the licence's own ID; a code pasted twice is the same licence.
- `type: "perpetual"` always has `"exp": null`; a trial always has `exp > iat`.
- `feat` — see [§10](#10-features). `note` — up to 120 characters; shown in Settings.

The code is `base64url(payload) + "." + base64url(signature)`, no padding, where the
signature is **Ed25519 over the exact payload bytes**, checked with `verify_strict`. The
issuer prints it in **60-character lines**. On paste, all whitespace and the invisible
direction/zero-width marks some message apps insert (U+200B–U+200F, U+202A–U+202E,
U+2060–U+2069, U+FEFF) are removed first, so a code arrives intact however it was sent.

A code is checked in this order, and each failure is its own refusal:

| Check | Refusal | What the merchant reads |
|---|---|---|
| Two base64url parts, sane size | `MALFORMED` | هذا ليس رمز تفعيل كاملاً — تأكّد أنك نسخت رسالة المزوّد كاملة… |
| Signature matches the embedded key | `BAD_SIGNATURE` | هذا الرمز لا يطابق توقيع مزوّد البرنامج — إمّا تغيّر فيه حرف أثناء النسخ، أو لم يصدر من المزوّد… |
| `v` is 1 | `UNSUPPORTED_VERSION` | هذا الرمز صادر بصيغة أحدث مما يقرؤه هذا الإصدار — حدّث البرنامج… |
| Fields well-formed and consistent | `MALFORMED` | (as above) |
| `did` is this installation's ID | `DEVICE_MISMATCH` | هذا الرمز صادر لجهاز آخر (WL-…)، ورقم هذا الجهاز WL-…. أرسل رقم هذا الجهاز إلى المزوّد… |

The signature is checked **before** the JSON is parsed, so nothing unsigned is ever
interpreted.

## 5. Issuing a code (provider)

Full instructions, with real output: [`tools/license-issuer/README.md`](../tools/license-issuer/README.md).

```bash
license-issuer keygen                                        # once, ever
license-issuer issue --device WL-7K3M-9QXP --days 14         # a 14-day trial
license-issuer issue --device WL-7K3M-9QXP --days 5 --extend # 5 days after the latest trial
license-issuer issue --device WL-7K3M-9QXP --perpetual       # paid: never expires
license-issuer list                                          # everything issued
```

The private key is encrypted with a password asked for at every `issue`. Every code is
recorded in the issuer's local SQLite log (`issued.db`).

**The trial length is yours alone.** The application has no built-in trial: a new
installation is `UNLICENSED` until given a code, and a trial lasts exactly the `--days`
you issue.

## 6. Activating a code (merchant)

In the manager dashboard: **الإعدادات ← الترخيص** (the red read-only banner and the
top-bar countdown both open it).

1. **رقم هذا الجهاز** is shown in large type with a «نسخ الرقم» button, under the
   instruction «أرسل هذا الرقم إلى المزوّد للحصول على رمز التفعيل».
2. The code from the provider goes into the large «رمز التفعيل» field — pasted as it
   arrived, lines and all — then «تفعيل».
3. On success the screen says what was activated — «تم التفعيل: ترخيص دائم…» or «تم
   التفعيل: فترة تجريبية مدتها 14 يوماً، تنتهي في …» — and the status changes **at once**:
   no restart, because the service re-evaluates on every request. The till can sell on
   its very next scan.
4. **سجل التفعيل** lists every code ever activated on this installation: when, which
   kind, until when, and by whom.

Activation is open to the OWNER and MANAGER accounts; the till's account can read the
status but not activate. Every attempt — accepted or refused, with its reason — is
written to the audit trail (`license.activated` / `license.activation_failed`).

Besides the code checks in [§4](#4-the-licence-code), activation refuses:

| Refusal | When | Message |
|---|---|---|
| `EXPIRED_CODE` | a trial code whose `exp` has already passed | انتهت مدة هذا الرمز في …، فلا يضيف شيئاً — اطلب من المزوّد رمزاً جديداً. |
| `CLOCK_BEHIND` | this PC's clock is more than 2 h before the code's issue time | تاريخ هذا الجهاز أقدم من تاريخ إصدار الرمز — صحّح التاريخ والوقت في Windows، ثم أعد التفعيل. |
| `PERPETUAL_ACTIVE` | a trial code on a device that already holds a perpetual licence | هذا الجهاز مفعّل بترخيص دائم، فلا حاجة لهذا الرمز التجريبي — لم يتغيّر شيء. |

Pasting a code that is already active is not an error: «هذا الرمز مفعّل على هذا الجهاز
مسبقاً — لم يتغيّر شيء.»

## 7. Statuses and what each one does

| Status | Meaning | Recording | What is shown |
|---|---|---|---|
| `UNLICENSED` | No valid code (the default) | **read-only** | Red banner «البرنامج غير مفعّل — يعمل للقراءة فقط» |
| `TRIAL` | A trial, before its expiry | full | In its **last 7 days**: a top-bar chip «تنتهي الفترة التجريبية خلال X» |
| `TRIAL_GRACE` | Trial expired less than **5 days** ago | **full** | A red banner on every launch: «انتهت الفترة التجريبية — هذه مهلة أخيرة» with the date it ends |
| `EXPIRED` | Trial and grace both over | **read-only** | Red banner «انتهت الفترة التجريبية — البرنامج يعمل للقراءة فقط» |
| `PERPETUAL` | Paid; `exp` is null | full | Nothing |
| `TAMPERED` | Clock set back more than 2 h, or the stored code fails its signature | **read-only** | Red banner «توقّف تسجيل العمليات الجديدة», saying which of the two and what to do |

**Read-only refuses exactly three things**, each with HTTP 423 `LICENSE_READ_ONLY` and an
Arabic sentence the till shows as it is:

1. **recording a sale** — linking an invoice to a customer (`scanCard`);
2. **registering a new customer** (`createCustomer`);
3. **redeeming a voucher** — the product's nearest thing to taking a payment
   (`redeemVoucher`).

**Everything else keeps working**, because the merchant's data is never withheld: every
report, the customer list and customer details, card history and card batches, invoice
capture from the register (an invoice printed at the till is the shop's record, whatever
the licence says), exports, backups — local and Google Drive —, the restore test, and
restoring. Card batches and captures still evaluate the licence and note a read-only
status in the log.

**The offline queue.** A sale, registration or redemption the Station queued while it
could not reach the manager PC, and which is refused on replay for the licence, is
reported `FAILED` — the one result the Station does not settle. It stays in the queue and
is sent again after activation. Nothing is lost.

Where more than one code is stored, a perpetual licence governs; otherwise the trial with
the latest expiry. An older or shorter code can never shorten a longer one.

## 8. Every scenario

| Scenario | What happens |
|---|---|
| **New installation** | `UNLICENSED`, read-only. The merchant sends the device number; the provider sends a trial or perpetual code. |
| **Trial running** | Full use. From 7 days before expiry the top bar counts down. |
| **Trial expires** | 5 days of `TRIAL_GRACE`: full use, red banner every launch with the date grace ends. Then `EXPIRED`, read-only. |
| **Provider extends a trial** | `issue --days N --extend` → new code; pasted, the later expiry governs at once. Works in `TRIAL`, `TRIAL_GRACE` and `EXPIRED`. |
| **Merchant pays** | `issue --perpetual` → pasted → `PERPETUAL` at once, forever. |
| **Same code pasted twice** | «مفعّل مسبقاً — لم يتغيّر شيء». One row in the history. |
| **Code for another device** | Refused `DEVICE_MISMATCH`; the message names both device numbers so the right one can be read back. |
| **Code damaged in transit** | Refused `BAD_SIGNATURE` or `MALFORMED`; nothing stored. |
| **Clock set back > 2 h** | `TAMPERED`, read-only, the banner says by roughly how much. Correcting the clock clears it on the next request — no code, no restart. The detection stays in the audit trail (`license.clock_rollback`). |
| **Clock within 2 h** | Ordinary drift; nothing happens. |
| **Clock was once far in the future** (so the recorded time is ahead of reality) | `TAMPERED` until that date — unless the merchant activates a **freshly issued** code: a signature from the provider's clock proves the recorded time was never real, and it is reset (`license.clock_anchor_reset`). |
| **The three clock records disagree** | The latest wins and the disagreement is audited (`license.clock_anchor_conflict`). |
| **Stored code edited in the database** | It fails its signature on the next request → `TAMPERED` (`license.stored_code_invalid`). Pasting a genuine code again fixes it. |
| **Database restored from an older backup** | The activated codes are mirrored to `license-codes.json` beside the clock file; missing ones are verified and put back on the next start (`license.restored_from_mirror`). A restore never costs the licence. |
| **System drive replaced / Windows reinstalled, database kept** | Stored device ID kept, licence kept, audit warning (`license.device_sources_changed`). |
| **New PC, fresh install, no restore** | A new device ID → `UNLICENSED`; the provider issues a code for the new number. |
| **New PC, backup restored onto it** | The restored database carries the stored device ID and the codes, so the licence moves with the shop's data — the case of a PC that died. The audit trail records that the sources changed. |
| **Licensing module missing from the installation** | The service does not start, with «تعذّر تشغيل الخدمة: وحدة الترخيص مفقودة من ملفات البرنامج المثبّتة…». |

## 9. The clock

A trial is a date, and a date can be defeated by winding the clock back. So the service
keeps the **latest time it has ever observed** in three places, written together:

| Where | What |
|---|---|
| The database | `installation_state.last_seen_at` |
| The registry | `HKCU\Software\Walaa`, value `LastSeenAt` (QWORD). The service runs as LocalSystem, so this is `HKEY_USERS\S-1-5-18\Software\Walaa`. |
| A hidden file | `.license-clock` in the data folder (`C:\ProgramData\Walaa`), `walaa-clock-v1 <seconds>` |

At start the three are read and the **latest** wins; any disagreement is audited. The time
moves forward on use and every 10 minutes, never backward. A write that fails is logged
and does not stop the other two — losing one location loses nothing. If the system clock
is **more than 2 hours** behind the latest recorded time, the status is `TAMPERED` until
it is not.

A **perpetual** licence ignores the clock: it has no expiry to stretch, and a shop that
paid is never stopped by a wrong date.

## 10. Features

`feat[]` in a code lists paid features. The service checks it before:

- **`drive_backup`** — uploading backups to Google Drive. Without it the nightly backup
  still runs **locally**, and the Drive panel says «الرفع إلى Google Drive غير مشمول في
  ترخيص هذا الجهاز…». **Connecting a Google account, listing the copies in Drive, and
  restoring from Drive are never gated**: a merchant replacing a dead PC must be able to
  get his data back whatever licence the new machine has.
- **`multi_device`** — reserved; issued by default, nothing checks it yet.

Any future paid feature is a new name in `KNOWN_FEATURES` (`crates/walaa-license/src/lib.rs`)
and a `licensedFeature('…')` check where it is used. The issuer refuses feature names the
crate does not know.

## 11. Protecting the private key

The whole scheme rests on one file, `issuer-key.json`, and its password. See
[the issuer README](../tools/license-issuer/README.md#backing-up-the-key). In short:

- **Lose the file or the password and no licence can ever be issued again** — not for a
  new shop, not for a customer who has paid. Recovery means a new key, a new build for
  every shop, installed in person.
- Two copies of the home folder, off this computer, in two places; the password kept
  separately from both; one test issue from a copy to prove it.
- Never put the key file in this repository, a shared drive, or an e-mail. Only the
  **public** half belongs in the repository (`public_key.rs`).
- The key is encrypted at rest (Argon2id → XChaCha20-Poly1305, bound to its own public
  key). A stolen file without the password is useless; both together are a licence
  press.

## 12. The development key, and the installer gate

Until the provider runs `keygen`, `crates/walaa-license/src/public_key.rs` holds a
**development** key (`KeyKind::Development`, fingerprint `7411F6B7B28F4C15`) whose private
half and password are committed in `tools/license-issuer/dev-key/`. Anyone with the
repository can sign codes for it. That is what makes the tests and `pnpm package:verify`
able to exercise activation end to end — and why it must never reach a shop:

- `pnpm package:installer` first runs `packaging/scripts/verify-license-key.mjs`, which
  loads the **staged** licensing module and refuses unless it embeds a production key.
- `packaging/scripts/stage.mjs` copies the module by allowlist and fails if the test
  build (`walaa-license.test.node`) reaches the staged runtime.
- The service logs the key kind and fingerprint at every start (`licence … key`).

`pnpm package:verify` activates a code on the clean-room install: it uses
`WALAA_VERIFY_LICENSE_CODE` if set (required once the production key is embedded — the
provider issues one for the build machine), otherwise it issues one with the development
issuer, which only a development build accepts.

## 13. Upgrading an existing shop to 0.3.0

0.3.0 adds a database migration (`license_activation`, `installation_state`). A shop
machine never migrates itself, so this is an **in-person upgrade**, like every schema
change:

1. Take a backup (Backup screen → «نسخ احتياطي الآن») and copy it off the machine.
2. Install 0.3.0.
3. The shop starts **`UNLICENSED` — read-only** until given a code. Its data is all there
   and readable; the till refuses sales until activation. Have the code ready: read the
   device number from «الإعدادات ← الترخيص» on the spot, issue, paste.

## 14. Tests

| Where | Run | Covers |
|---|---|---|
| `crates/walaa-license` | `cargo test` | valid and invalid signatures, another key, wrong device, corrupted and wrong-version codes, pasting with spaces/CRLF/RTL marks, trial countdown and warning, grace then expiry, perpetual ignoring the clock, clock rollback and its 2 h tolerance and recovery, a clock before the issue time, extension governing, conflicting anchors, the device ID alphabet, the Windows sources and registry anchor |
| `tools/license-issuer` | `cargo test` | key sealing, wrong password, damaged file, payload rules, the log |
| `apps/api` — `license.test.ts` | `pnpm --filter @walaa/api test` | every refusal through HTTP with distinct Arabic messages and audit rows; the three refused operations and everything read-only keeps open (capture, batches, reports, backup, restore test); the offline queue keeping refused items; trial, grace, expiry; clock rollback → `TAMPERED` → recovery; conflicting anchors; anchor reset by a fresh code; tampered stored code; restore from the mirror; device source change; Drive upload needing `drive_backup` while listing does not |
| `packaging` | `pnpm package:verify` | a clean install starts `UNLICENSED`, refuses a customer in Arabic, activates, then trades |

The API suite runs against the **real Rust verifier** (the test build of the module) with
codes signed by the published test key; its clock anchors go to a per-run registry key and
folder, never `Software\Walaa`.

## 15. What this does not protect against

Stated plainly, so nobody overestimates it:

- **The gate runs in the API's JavaScript bundle.** An administrator on the shop PC who
  edits `walaa-api.cjs` to skip the check bypasses licensing. The signature, device and
  clock checks make casual cheating fail loudly; they do not make a determined one
  impossible. Nothing offline can.
- **The licence follows the database.** Restoring a shop's backup onto another PC carries
  its device ID and codes along (deliberately — a dead PC must not strand a paying shop).
  The audit trail records the changed machine; nothing blocks it.
- **Deleting all three clock records at once** (database row, registry value, hidden
  file) forgets the recorded time. Each alone is audited and outvoted by the others.
