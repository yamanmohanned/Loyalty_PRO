# license-issuer — issuing ولاء licence codes

A command-line tool for the **provider** of ولاء, run on the provider's own machine. It
signs licence codes for merchants' devices. It is **never shipped** to a shop: nothing in
the installer, the staged runtime or the application contains it, its private key, or
anything that can sign.

The whole licensing design — code format, what the merchant sees, every scenario — is in
[`packaging/LICENSING.md`](../../packaging/LICENSING.md). This file is about running the
tool and keeping its key.

---

## ⚠ If you lose the private key or its password, you can never issue a licence again

Every copy of the application checks codes against **one public key compiled into it**.
Only the matching private key — the file `issuer-key.json`, opened with **your
password** — can sign a code that key accepts.

- Lose the file **or** forget the password, and no new code can be made for any shop:
  not a trial, not an extension, not a perpetual licence for a customer who has paid —
  and not an **emergency code** either, since those come from the same private key.
  The only way out is a new key pair, which means a new build of the application for
  **every** shop, installed in person, and new codes for all of them.
- Nobody can recover it for you. The file is encrypted (Argon2id, 64 MiB, 3 passes →
  XChaCha20-Poly1305); without the password it is random bytes, by design.
- Someone who gets **both** the file and the password can issue licences as you. Keep
  them apart.

**Back up before you issue your first code** — see [Backing up the key](#backing-up-the-key).

---

## Building it

Needs Rust (stable) on the provider's machine:

```bash
cd tools/license-issuer
cargo build --release
```

The program is `tools/license-issuer/target/release/license-issuer.exe`. The examples
below call it `license-issuer` for readability; it is not on `PATH`. **The exact commands to
type, verified in a fresh PowerShell window, are in [`packaging/ON-SITE-CARD.md`](../../packaging/ON-SITE-CARD.md)**
and `packaging/LICENSING.md` §5.

## Where it keeps things

One folder, called the **home**:

| File | What it is |
|---|---|
| `issuer-key.json` | The private key, encrypted with your password. **The irreplaceable file.** |
| `issued.db` | A log (SQLite) of every code issued: licence ID, device, type, dates, features, note, the code itself. |

Home: `--home <folder>`, else `LOYALTY_ISSUER_HOME`, else whichever of
`%USERPROFILE%\.loyalty-pro-issuer` and `%APPDATA%\loyalty-pro-license-issuer` holds `issuer-key.json`
(`keygen` with neither creates the first). When no key is found the error names both folders.

## The password

Asked for at a prompt by default. `--password-file <file>` reads it from a file and
`--password-stdin` from standard input. Every way in is normalised the same way, at `keygen`
and at every later use (`src/password.rs`): UTF-8 or UTF-16, a byte-order mark anywhere, and
whitespace, line endings and invisible direction marks at either end are removed; spaces inside
are kept. No wrapper is ever needed. A key sealed before 2026-09-15 behind an invisible U+FEFF
still opens with the plain password.

The one thing no program can repair: **Windows PowerShell 5.1 sends a pipe as ASCII**, so any
non-English character piped in arrives as `?`. Use `--password-file` or the prompt.

`license-issuer check` opens the key and says so — nothing issued, nothing written. Run it
before leaving for a shop.

## Generating the key pair — once

```bash
license-issuer keygen
```

It asks for a password (at least 12 characters) and asks again to confirm it. Then it:

1. writes `issuer-key.json` and `issued.db` into the home;
2. writes the **public** key into `crates/loyalty-pro-license/src/public_key.rs`, marked
   `KeyKind::Production` — the file the application compiles in — together with the
   public *tip* of the emergency-code chain (see [Emergency codes](#emergency-codes-read-over-the-phone));
3. prints the fingerprint, and a reminder to back up.

`keygen` refuses to run if the home already holds a key, and refuses to replace a
production public key already in `public_key.rs` with a different one: either would
make every code already issued unverifiable by the next build.

After `keygen`, commit `crates/loyalty-pro-license/src/public_key.rs` and build the application
(`pnpm package:build`, then `pnpm package:installer`). Until you do, builds embed the
development key and the installer step refuses to package them.

This is the output of a real run (with `--password-stdin` and `--public-key-out`
pointing into a scratch folder, so the repository was not touched — run it without them):

```text
Key pair generated (production).
  private key (encrypted)  …\issuer-demo2\issuer-key.json
  issue log                …\issuer-demo2\issued.db
  public key fingerprint   A5CCC964DCA87B9A
  emergency codes          until 2046-09-08 00:00 UTC
  wrote the public key into …\issuer-demo2/public_key.rs

Back up the folder …\issuer-demo2 and the password NOW, in two separate places.
Losing either one makes it impossible to issue any new licence — see README.md.
Then rebuild the application so it embeds this public key.
```

Running `keygen` a second time in the same home:

```text
error: …\issuer-key.json already exists. keygen runs once: a new key would make every code already issued unverifiable by the next build. Move the existing file away deliberately if you really mean to start again.
```

## Issuing a code

The merchant opens **الإعدادات ← الترخيص** and reads you the device number, which looks
like `WL-7K3M-9QXP`. Every `issue` asks for the key's password once.

| You want | Command |
|---|---|
| A new shop PC's first licence: a 14-day trial | `license-issuer issue --device WL-7K3M-9QXP --days 14 --note "سوبرماركت النور"` |
| A new shop PC that has already paid | `license-issuer issue --device WL-7K3M-9QXP --perpetual --note "سوبرماركت النور"` |
| 30 more days for a PC that already has a licence | `license-issuer renew --device WL-7K3M-9QXP --days 30` |
| The shop paid: make its licence permanent | `license-issuer renew --device WL-7K3M-9QXP --perpetual` |
| Only some features | add `--feat drive_backup` (comma-separated; default `drive_backup,multi_device`; `renew` keeps the previous licence's) |

- `issue` is a device's **first** licence: it refuses a device that already has one in your
  log, because `--days` counts from today and could end before the licence the shop holds.
- `renew --days N` adds N days to the **end** of the device's latest trial in your log, or to
  today if that has ended; note and features carry forward. It refuses a device with no licence
  in the log (that is `issue`) and one already perpetual.
- The merchant pastes a renewal exactly like the first code. Nothing is done to the old one: the
  program keeps every code and runs on the perpetual one, else the trial that ends last.
- `--days` is 1 to 3650. The trial length is entirely yours: the application has no built-in
  trial and no default length.

Real output (the password came from `--password-stdin`; you will see a prompt instead):

```text
$ license-issuer issue --device WL-7K3M-9QXP --days 14 --note "سوبرماركت النور"
Licence issued
  device    WL-7K3M-9QXP
  type      trial — until 2026-09-28 04:54 UTC
  features  drive_backup, multi_device
  note      سوبرماركت النور
  licence   5f3343d0-ee07-41e8-b7c0-d712cc2049b3

Send the merchant this code (the lines can be pasted as they are):

eyJ2IjoxLCJsaWQiOiI1ZjMzNDNkMC1lZTA3LTQxZTgtYjdjMC1kNzEyY2My
MDQ5YjMiLCJkaWQiOiJXTC03SzNNLTlRWFAiLCJ0eXBlIjoidHJpYWwiLCJp
YXQiOjE3ODkzNjE2NjQsImV4cCI6MTc5MDU3MTI2NCwiZmVhdCI6WyJkcml2
ZV9iYWNrdXAiLCJtdWx0aV9kZXZpY2UiXSwibm90ZSI6Itiz2YjYqNix2YXY
p9ix2YPYqiDYp9mE2YbZiNixIn0.O36rm0WdBqUYDyQkWyaOhGRZt-GLH2sk
PDBT8Cv65IQ40lkhZrCx3egled1r94Vdzj3l6HxzfQgwCDSwRz8WDQ

$ license-issuer renew --device WL-7K3M-9QXP --days 30
Licence renewed
  device    WL-7K3M-9QXP
  was       trial — until 2026-09-28 04:54 UTC (still running)
  now       trial — until 2026-10-28 04:54 UTC (the days were added to the end of the current licence)
  …

$ license-issuer renew --device WL-7K3M-9QXP --perpetual
Licence renewed
  device    WL-7K3M-9QXP
  was       trial — until 2026-10-28 04:54 UTC (still running)
  now       perpetual — never expires
  …
```

(The `renew` output above is from the 2026-09-17 run on the real key for a test device, with the
device number and dates of this example substituted.)

Send the whole block of code lines by WhatsApp, e-mail or SMS. The merchant pastes it
as it arrives; line breaks, spaces and the invisible direction marks some message apps
add are all ignored.

Refusals, from the same run:

```text
$ license-issuer issue … (wrong password)
error: wrong password, or the key file is damaged

$ license-issuer issue --device WL-ILO1-0000 --perpetual
error: "WL-ILO1-0000" is not a device ID — it looks like WL-XXXX-XXXX and uses only the symbols 2-9 and A-Z without I, L, O, U
```

Every code is checked against the key file's own public key before it is printed, and
recorded in `issued.db`.

**A Windows reinstall or a new PC** gives the shop a new device number only when its
backup is *not* restored (restoring brings the old number and licence back). Then:
an emergency code for the new number at once, and a perpetual licence for it when a
message can reach the shop — `--note "replaces WL-OLD"` keeps the link in your log.

## Emergency codes, read over the phone

For when the shop must trade *now* and no message can reach its PC: the licence was
destroyed, Windows was reinstalled, the clock record is wrong, something in the gate is
broken. The merchant reads you the device number; you run

```bash
license-issuer unlock --device WL-7K3M-9QXP             # 7 days (the default)
license-issuer unlock --device WL-7K3M-9QXP --days 30   # up to 30
```

and read back fifteen symbols. The merchant types them into «الإعدادات ← الترخيص ←
رمز الطوارئ», and full operation returns with that request — whatever else is wrong — until
the end of the UTC day `--days` days from now, followed by five days of grace. It asks for
the key's password, like `issue`.

Real output (password from `--password-stdin`):

```text
$ license-issuer unlock --device WL-7K3M-9QXP --note "licence file lost; message not reachable"
Emergency code issued
  device    WL-7K3M-9QXP
  works     until 2026-09-22 00:00 UTC (7 days)

Read this to the merchant — fifteen symbols in three groups:

    2MH6K-8SBHN-Q8JYC

The merchant types it into Settings > Licensing > emergency code. Full operation returns
at once, until the date above. It is not a licence: send a licence code when one can be received.

$ license-issuer unlock --device WL-7K3M-9QXP --days 31
error: --days must be between 1 and 30

$ license-issuer unlock --device WL-7K3M-9QXP      (a key file made before this version)
error: this key file was made before emergency codes existed — it cannot issue them
```

Why fifteen symbols can be trusted with no secret in the program: the codes are links of
a hash chain derived from your private key; the program holds only the chain's end and
hashes a typed code forward to it. The fifteenth symbol is a check symbol, so a misheard
symbol is refused as a typo rather than as a forgery. A code is mixed with the device
number, so one shop's code does not work in another. Full account:
[`packaging/LICENSING.md` §7](../../packaging/LICENSING.md#7-the-emergency-code-read-over-the-phone).

## Listing what you have issued

```bash
license-issuer list
license-issuer list --device WL-7K3M-9QXP
```

```text
Emergency codes
issued                device        works until           code               note
2026-09-14 22:21 UTC  WL-7K3M-9QXP  2026-09-22 00:00 UTC  2MH6K-8SBHN-Q8JYC  licence file lost; message not reachable
2026-09-14 22:21 UTC  WL-7K3M-9QXP  2026-10-15 00:00 UTC  2GZ4P-AB7T5-246C8

Licences
issued                device        type       expires               features                    licence                               note
2026-09-14 22:21 UTC  WL-7K3M-9QXP  perpetual  never                 drive_backup,multi_device   a4449648-9ed6-4b89-b45a-4d8fef8bcca4  replaces WL-2222-2222 after a Windows reinstall
```

`list` needs no password. A merchant who lost the message can be sent the same code
again — it is in the log.

## Backing up the key

Do this right after `keygen`, and again whenever you want the log (`issued.db`) backed up
too.

1. **Copy the whole home folder** (`%USERPROFILE%\.loyalty-pro-issuer`, or your `--home`) to
   **two** places that are not this computer — for example two USB sticks kept in
   different buildings, or one USB stick and an encrypted cloud folder. The key file is
   encrypted, so a copy on its own gives nobody the power to sign.
2. **Keep the password separately from both copies**: written on paper in a safe, or in
   a password manager — never in the same folder, e-mail or cloud account as the key file.
3. **Prove the backup works** on another computer: point the tool at the copy and issue
   a 1-day trial for a made-up device ID. If it asks for the password and prints a code,
   the backup and the password are both good.

   ```bash
   license-issuer --home E:\backup\loyalty-pro-license-issuer issue --device WL-2222-2222 --days 1 --note "backup test"
   ```

If only `issued.db` is lost, nothing is lost that matters for signing: you can still
issue every kind of code. `list` starts empty, so a device that already had a licence gets its
next one with `issue` (counted from today) — `renew` needs the log.

## The development key (not for shops)

`tools/license-issuer/dev-key/` holds a **development** key pair whose password is
written in its README. It exists so the repository can build, test and verify
licensing end to end before the production key exists. Builds that embed it are
refused by `pnpm package:installer`. See [`dev-key/README.md`](dev-key/README.md).

## Tests

```bash
cd tools/license-issuer && cargo test
```

Covers key sealing (a wrong password fails, a damaged file fails, the stored public key
must match, a key sealed behind a BOM opens), the password normaliser (every shape a shell
delivers), building payloads (renewal of a running and an ended trial, perpetual, day limits,
unknown features refused, `issue` and `renew` refusing each other's case), the log, and — in
`tests/cli.rs` — the built program with the password delivered by file and by pipe.
