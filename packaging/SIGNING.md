# The update signing key

Read this before you lose it.

---

## Where it is

```
C:\Users\yaman\.walaa-signing\
    walaa-updater.key        the private key   ← THE SECRET
    walaa-updater.key.pub    the public key    ← safe, already in the app
    PASSWORD.txt             the key's password ← THE OTHER SECRET
```

Key id **`BE2E4C7B42C8D100`**. The directory has inheritance stripped and is granted to
`DESKTOP-TSC2UKD\yaman`, SYSTEM and Administrators only.

It is **outside the repository on purpose**, and `.gitignore` plus
`apps/api/src/__tests__/signing-key.test.ts` both refuse to let a copy back in — the
test greps every tracked file for the minisign private-key header, so a copy added
under any filename fails the build.

---

## What it does

The public half is compiled into every installed copy of ولاء. The installed updater
downloads an update, checks its signature against that public key, and installs it if
the signature is valid.

Which means the private key is not "a release credential". **It is the authority to run
any code you like on every machine this software is ever installed on** — including a
back-office PC holding a shop's entire customer list. Treat it the way you would treat
the keys to the shop.

---

## Back this up tonight — exactly these three things

**Everything needed to sign a future release, and nothing else:**

| What | Where | Why it is needed |
|---|---|---|
| `walaa-updater.key` | `C:\Users\yaman\.walaa-signing\` | the private key. Signs the update. **Irreplaceable.** |
| the password | `PASSWORD.txt`, same folder | decrypts the key. Useless alone, and the key is useless without it. |
| `walaa-updater.key.pub` | same folder | convenience only — it is also in `tauri.conf.json`, so it is recoverable. Back it up anyway; it costs nothing. |

Nothing else is required. Not the repository, not the installer, not this machine: with
those three you can sign a release from anywhere that can build the app.

**Do this:**

1. Password manager → new entry **"ولاء — updater signing key"**. Put the password in
   it and **attach the `.key` and `.pub` files to the same entry** (1Password, Bitwarden
   and KeePass all take attachments). One entry, everything.
2. Copy the same three files to **one offline place** — a USB stick in a drawer at home.
3. Delete `PASSWORD.txt` from this machine once it is in the manager.

Step 2 is the point of the password: an unprotected signing key is a file you can never
safely copy anywhere, which is exactly how a key ends up existing in one place and then
in none.

### Confirmed not to leak

- **Not in git.** `.gitignore` covers `*.key`, `.walaa-signing/` and `walaa-updater.key*`,
  and `signing-key.test.ts` greps every *tracked* file for the key's content — both the
  decoded header and the base64 form Tauri actually writes. Verified by planting a real
  copy of this key in the tree: the test named the file and failed.
- **Not in any artefact.** 521 files scanned — the staged runtime, both signed installers,
  the web bundle and every build log — for the key's unique material and for the
  password. Zero hits.
- **Not on a command line.** `verify-signing.mjs` passes both secrets through the
  environment, never as arguments, because command lines are readable by other processes.

---

## What happens if you lose it

**Every installation that already exists can never be updated again.** Not "updates are
harder" — impossible. The public key baked into those copies has exactly one private
half, and updates signed with anything else are rejected by design, which is the whole
point of signing them.

The recovery is: generate a new keypair, rebuild the app with the new public key, and
**visit every machine to install that build by hand**. From then on it can self-update
again. You do not lose any data — the database is untouched by all of this — you lose
the ability to fix anything remotely until you have physically been to each shop.

With one shop that is one trip. It stops being funny at five.

**If you think it has leaked**, treat it as the same job plus urgency: rotate, rebuild,
reinstall everywhere, and assume anything signed with the old key is untrustworthy.

---

## Building a signed release

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = "C:\Users\yaman\.walaa-signing\walaa-updater.key"
# -Raw plus PowerShell's utf8 writer is a trap: it adds a BOM, the BOM travels into
# the password, and the first signed build failed with "Wrong password for that key".
# ReadAllText decodes the BOM away.
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [IO.File]::ReadAllText("C:\Users\yaman\.walaa-signing\PASSWORD.txt").Trim()
pnpm package:build
pnpm package:installer
```

Output, beside the installer in `apps/manager-desktop/src-tauri/target/release/bundle/nsis/`:

| File | What it is |
|---|---|
| `ولاء_<version>_x64-setup.exe` | the installer you hand over |
| `ولاء_<version>_x64-setup.exe.sig` | its signature — the updater checks this |

Once `PASSWORD.txt` is deleted, take the password from your password manager instead of
reading the file.

---

## Publishing an update

The app checks this endpoint, from `tauri.conf.json`:

```
https://github.com/yamanmo/walaa/releases/latest/download/latest.json
```

To release 0.2.1 to every installed copy:

1. Build it signed, as above.
2. Create a GitHub release on `yamanmo/walaa` tagged `v0.2.1`.
3. Attach **both** the `.exe` and the `.exe.sig`.
4. Attach a `latest.json`:

```json
{
  "version": "0.2.1",
  "notes": "وصف قصير بالعربية لما تغيّر",
  "pub_date": "2026-09-20T10:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<the entire contents of the .sig file>",
      "url": "https://github.com/yamanmo/walaa/releases/download/v0.2.1/ولاء_0.2.1_x64-setup.exe"
    }
  }
}
```

`packaging/scripts/make-update-feed.mjs` generates that file from a built release rather
than having you assemble it by hand.

The installed app checks on launch, and `UpdateNotice` asks the merchant in Arabic
before doing anything — `dialog: false` in the config is deliberate, because the
plugin's own prompt is English and unstyled and would appear over a merchant's dashboard
without warning.

### What has been proven, and what has not

**Proven** — `pnpm --filter @walaa/api drill:update` and `drill:upgrade`:

- a genuine 0.2.1 signed by this key **verifies** against the public key the app ships
- an update signed by a **different** key is refused, by key id, before any maths runs
- an update with **one bit flipped** after signing is refused by the ed25519 check itself
- 0.2.0 creates a shop; 0.2.1 opens that same database and the identity, integrity and
  migration-set checks all pass on it
- **no migration runs** on the upgrade — the newer binary opens the file rather than
  altering it
- every customer, invoice, voucher and user survives with an identical content hash, the
  branch code and merchant settings survive, the owner created on 0.2.0 still signs in on
  0.2.1, and the version the service reports genuinely changes

**NOT VERIFIED:** the last mile — an *installed* copy detecting the feed, downloading,
and relaunching itself. That needs an elevated install, and the installer has not been
run (UAC could not be approved unattended). What is unproven is Tauri's plumbing around
a check that is proven; the cryptography and the data survival either side of it are not
in doubt.

Do the first real update deliberately, on a machine you can reach, before relying on it
for a shop you cannot.

---

## Why sign at all, when the alternative is a car journey

The one paragraph you asked for, for the record.

Manual updates are genuinely defensible for a single back-office PC: the update path is
the largest remote attack surface this product has, an unsigned or badly-secured one is
a way for somebody else to install anything on the machine holding a shop's customer
list, and running an installer by hand is a step a person can see happening. **But that
argument only holds while there is one shop and you are willing to drive to it.** The
cost of a manual update is a trip; the cost of *not being able to update* is that a
security fix or a data-corrupting bug sits in the field until you have time to travel.
Signing does not force auto-update on you — the merchant is still asked in Arabic before
anything installs — it only preserves the option. And the option cannot be added later:
the public key is compiled into the copy the merchant installs tomorrow, so a build that
ships without one can never self-update, ever. That asymmetry is the whole decision:
signing costs an afternoon now and nothing afterwards, and not signing costs a car
journey for every fix, forever, starting with the first one.
