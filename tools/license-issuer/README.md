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
below call it `license-issuer`.

## Where it keeps things

One folder, called the **home**:

| File | What it is |
|---|---|
| `issuer-key.json` | The private key, encrypted with your password. **The irreplaceable file.** |
| `issued.db` | A log (SQLite) of every code issued: licence ID, device, type, dates, features, note, the code itself. |

Default home: `%APPDATA%\walaa-license-issuer`. Override with `--home <folder>` or the
`WALAA_ISSUER_HOME` environment variable.

## Generating the key pair — once

```bash
license-issuer keygen
```

It asks for a password (at least 12 characters) and asks again to confirm it. Then it:

1. writes `issuer-key.json` and `issued.db` into the home;
2. writes the **public** key into `crates/walaa-license/src/public_key.rs`, marked
   `KeyKind::Production` — the file the application compiles in — together with the
   public *tip* of the emergency-code chain (see [Emergency codes](#emergency-codes-read-over-the-phone));
3. prints the fingerprint, and a reminder to back up.

`keygen` refuses to run if the home already holds a key, and refuses to replace a
production public key already in `public_key.rs` with a different one: either would
make every code already issued unverifiable by the next build.

After `keygen`, commit `crates/walaa-license/src/public_key.rs` and build the application
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
| A 14-day trial | `license-issuer issue --device WL-7K3M-9QXP --days 14` |
| 5 more days on top of the device's latest trial | `license-issuer issue --device WL-7K3M-9QXP --days 5 --extend` |
| A permanent licence (one-time payment received) | `license-issuer issue --device WL-7K3M-9QXP --perpetual` |
| Only some features | add `--feat drive_backup` (comma-separated; default `drive_backup,multi_device`) |
| The store's name inside the code | add `--note "سوبرماركت النور"` (up to 120 characters) |

- `--days` is 1 to 3650. Without `--extend` a trial runs from **now**; with it, from the
  device's latest trial expiry in your log (or now, if that has already passed).
- The trial length is entirely yours: the application has no built-in trial and no
  default length. A new installation is unlicensed until it is given a code.
- A perpetual code makes any trial irrelevant. The application refuses a trial code on
  a device that already holds a perpetual licence.

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

$ license-issuer issue --device WL-7K3M-9QXP --days 5 --extend
Licence issued
  device    WL-7K3M-9QXP
  type      trial (extension) — until 2026-10-03 04:54 UTC
  …

$ license-issuer issue --device WL-7K3M-9QXP --perpetual --note "سوبرماركت النور"
Licence issued
  device    WL-7K3M-9QXP
  type      perpetual — never expires
  …
```

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

1. **Copy the whole home folder** (`%APPDATA%\walaa-license-issuer`, or your `--home`) to
   **two** places that are not this computer — for example two USB sticks kept in
   different buildings, or one USB stick and an encrypted cloud folder. The key file is
   encrypted, so a copy on its own gives nobody the power to sign.
2. **Keep the password separately from both copies**: written on paper in a safe, or in
   a password manager — never in the same folder, e-mail or cloud account as the key file.
3. **Prove the backup works** on another computer: point the tool at the copy and issue
   a 1-day trial for a made-up device ID. If it asks for the password and prints a code,
   the backup and the password are both good.

   ```bash
   license-issuer --home E:\backup\walaa-license-issuer issue --device WL-2222-2222 --days 1 --note "backup test"
   ```

If only `issued.db` is lost, nothing is lost that matters for signing: you can still
issue every kind of code. `--extend` then counts from today for that device, and `list`
starts empty.

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
must match), building payloads (`--extend`, day limits, unknown features refused) and the
log.
