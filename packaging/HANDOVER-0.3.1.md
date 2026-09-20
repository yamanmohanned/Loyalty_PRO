# Handover — ولاء 0.3.1 (install day, 2026-09-17)

Supersedes `HANDOVER-0.3.0.md`. **Carry 0.3.1, not 0.3.0.** The commands for the day are in
[`ON-SITE-CARD.md`](ON-SITE-CARD.md) — every one was run as written on the build PC.

## 1 · The installer you carry

`E:\loyalty\apps\manager-desktop\src-tauri\target\release\bundle\nsis\ولاء_0.3.1_x64-setup.exe`

- **SHA-256 `7EB47888D3264748C6463E877697B8F2269DAF65E0E5B9BB0A5DC115549B5967`** · 33,881,377 bytes
- Check on site, in the folder that holds it: `Get-FileHash .\ولاء_0.3.1_x64-setup.exe -Algorithm SHA256`
- **Licensing:** your **production** key, fingerprint `FCA66207230B90CA` (`verify-license-key.mjs`).
- **Update signature:** `….setup.exe.sig`, 420 bytes, SHA-256 `92518563EDCB263F77E94FB2F5C36DDEA55E949FCC84F9D3654EFDA116479099`, by key `BE2E4C7B42C8D100`.
- **Not** Windows code-signed: SmartScreen will warn. Check the hash, then *More info → Run anyway*.
- Installs to `C:\Program Files\ولاء\` (the product name), data in `C:\ProgramData\LoyaltyPro\`.
- Built from commit `aa3b5b1` by running `RELEASING.md` §1–§6 as written. No migration since 0.3.0. The walks in §3 ran on an earlier build of the same source (`52C3E397…`), identical code.

## 2 · What changed since 0.3.0

| Area | Before | Now |
|---|---|---|
| «ربط حساب Google» | `window.open` — returns `null` in the packaged window, nothing opened; each press opened another loopback listener; the 11th press in an hour: «عدد كبير من المحاولات» | The shell's opener (`shell::open`) launches the default browser at Google's page; the service's listener on `127.0.0.1` receives the redirect; the card polls. Pressing again reopens the **same** attempt. If the browser cannot open, the card says why and shows the link to copy |
| Rate limits (every route) | Counted at `onRequest`: malformed bodies, «no key yet», «backup already running» all spent the budget | Counted after auth, roles, validation and each route's preconditions. A wrong password still counts. The 429 sentence names the wait in minutes |
| Drive card | Red refusal, green notice and rate-limit error stacked | Exactly one status (not configured · not linked · linked with the account · error with reason) and one action outcome; pending label on every button |
| Other screens | Silent failures: Modules switch, paper width, key generate/reveal, customer export, restore cancel, staff enable/disable with the form closed. Success + error could stack on Staff, Cards, Backup | Each failure is said; one outcome slot per card (`FormOutcome`), cleared when the next action starts |
| Licence password | Failed twice: a BOM from a shell, then a wrapper adding one | Normalised on every way in, same at keygen; `--password-file`; a key sealed behind U+FEFF still opens |
| Renewal | `issue --days N` (counted from today — could end before the licence the shop holds) or `--extend` | `renew --days N` / `renew --perpetual`; `issue` refuses an already-licensed PC; `check` proves the key before you leave |
| Issuer key folder | Default `%APPDATA%\loyalty-pro-license-issuer` (empty) — every command needed `--home` | Finds `%USERPROFILE%\.loyalty-pro-issuer` too |

## 3 · The full flow, run on this PC — pass/fail with what was observed

The 0.3.1 runtime was run **from its staged files** (`packaging/dist/runtime`, what the installer
packs) as scratch services on ports 4711/4721/4731 — **not installed**: installing needs UAC and
this session was not elevated. Your installed 0.3.0 at `F:\loyyyyyyyy\ولاء` was not touched.

| # | Step | Result | Observed |
|---|---|---|---|
| 1 | Licence renewal while still licensed | **PASS** | Production-mode 0.3.1 shop on this PC's number `WL-34V4-WZNE`, activated with your real 365-day code → TRIAL to 2027-09-16. Card command **2** in a fresh PowerShell printed «was … until 2027-09-16 (still running) / now … until 2027-10-16»; pasted → TRIAL to **2027-10-16** at once, not read-only; the old 365-day code pasted again → still 2027-10-16 |
| 2 | Licence renewal after expiry into read-only | **PASS** | Same shop type, service clock run 401 days ahead: **EXPIRED**, read-only; registering a customer → 423 «لم تُسجَّل العملية: انتهت الفترة التجريبية ومهلتها…»; a scan → refused and **held** on the manager PC. Card command **2** → pasted → **TRIAL, 24 days left, not read-only**, at once; the held sale was credited (that card: 2 sales); the next sale recorded 60,000 → 1,800 discount |
| 3 | Drive connect: click → browser opens | **PASS, without the click** | Release `loyalty-pro-manager.exe` 0.3.1 against the scratch shop holding your saved OAuth client. From inside that window, the exact call the button now makes (`plugin:opener\|open_url` with the service's real auth URL, `accounts.google.com/o/oauth2/v2/auth`) returned `opened`, and your Chrome's window title became **«Sign in - Google accounts - Google Chrome»**. In the same window `window.open(…)` returned `null` and nothing opened — the old defect, measured. A second connect call returned the same attempt. The button itself was not clicked in the packaged window: that needs signing in, which means typing a password — see §6 |
| 4 | Google login → approve | **NOT DONE — needs your Google account** | Stopped at Google's sign-in page, as you asked. The tab may still be open in Chrome; that attempt expired after 10 minutes |
| 5 | Callback received → account shown as connected | **PASS against a local stand-in for Google** | The Drive card (real component, dev page) against 0.3.1 in test mode with `helpers/fake-google`: «ربط حساب Google» → consent URL → redirect to the `127.0.0.1` listener → page «تم الربط بنجاح» → service `CONNECTED` → card chip «مربوط», one status «مربوط بحساب Google: shop.owner@example.test». **Not Google** |
| 6 | Backup to Drive | **PASS (stand-in)** | «ارفع نسخة الآن» → «جارٍ أخذ نسخة ورفعها…» (button disabled) → «أُخذت نسخة جديدة ورُفعت إلى Google Drive.»; «النسخ الموجودة في Drive: 1 من أصل 14» |
| 7 | List it in Drive | **PASS (stand-in)** | Backup screen → «استعادة نسخة» lists «Google Drive · 0.01 MB» |
| 8 | Restore from Drive | **PASS (stand-in)** | Chose it → fetched, decrypted, checked: «فيها 0 زبون و0 فاتورة؛ وفي البرنامج الآن 1 زبون و1 فاتورة» → «تأكيد الاستعادة وإعادة التشغيل» → applied at the next start: customers 1 → 0, owner signs in, last restore recorded from «Google Drive», safety backup taken first |
| 9 | A real sale end to end | **PASS (through the API the till and agent use)** | Customer registered at the till → invoice delivered by the capture account → card scanned → invoice scanned: **QUALIFIED, 60,000 → 3% → 1,800 IQD**, voucher `4EV4-25VE` issued → redeemed (200) → again **409 «تم استخدام هذه القسيمة مسبقاً»** |
| 10 | Settings: one state at a time | **PASS (dev page)** | Not linked: one notice. Linked: one. Google unreachable: chip «خطأ» + one notice with reason and remedy; «ارفع نسخة الآن» while broken: still one notice. «فصل الحساب» → «جارٍ الفصل…» → the error cleared, one status «غير مربوط». Waiting panel: title, instruction, link, reopen/copy/cancel; cancel → the connect button back. The desktop-only refusal branch: the opener's real refusal text «Not allowed to open url …» is classified `blocked` |
| 11 | Build checks | **PASS** | `package:verify` 55 checks; `drill:kill 3` 8/8; `matrix.mjs 4971` 12/12; API tests 610/610 (36 files); issuer 21 tests incl. the built binary with a BOM file, a UTF-16 file and pipe, a BOM pipe |
| 12 | Password from every shell, real key | **PASS** | `check` opened `FCA66207230B90CA` from: PowerShell 5.1 `--password-file`, `Get-Content -Raw \|`, `.TrimEnd() \|`, UTF-8-BOM output encoding, UTF-16 output encoding; cmd `type \|`; Git Bash `cat \|` and a BOM pipe; the Node BOM wrapper. A wrong password is still refused. PowerShell 5.1 piping an explicit U+FEFF fails — it arrives as `?` (the ASCII pipe); documented, with a hint in the error |

## 4 · The commands, confirmed

All in `ON-SITE-CARD.md` §“The licence commands”, run on 2026-09-17 in fresh PowerShell processes:
`check` (key opens) · `issue` for a new number (WL-2222-2222) · `issue` for a licensed number →
refused, pointing to `renew` · `renew --days 30` · `renew --perpetual` · `unlock` · `list` ·
`Get-FileHash` in the installer folder · `Get-NetConnectionProfile` · `Get-NetTCPConnection`.
RELEASING.md §1–§6 were run as written to build this installer. LICENSING.md §5 is the same set.

## 5 · Back up on install day — before anything else

| # | What | Where | If it is lost |
|---|---|---|---|
| 1 | **Licensing key + password** | `C:\Users\yaman\.loyalty-pro-issuer\` (`issuer-key.json`, `PASSWORD.txt`, `issued.db`) | No licence and no phone code can ever be issued again |
| 2 | **Update signing key + password** | `C:\Users\yaman\.loyalty-pro-signing\` | No installed shop can ever be updated again |
| 3 | The issuer program | `tools\license-issuer\target\release\license-issuer.exe` (0.3.1) | Rebuildable — but you need it at the shop |
| 4 | The shop's `loyalty-pro.env` | `C:\ProgramData\LoyaltyPro\loyalty-pro.env` (elevated copy) | Every printed card must be re-issued |
| 5 | The backup key from the ceremony | on paper, off the premises | Every backup of that shop is unopenable |
| 6 | The owner password | the merchant's | No reset exists |
| 7 | The first `.walaabk` | your USB stick | — |
| 8 | Commits `aa3b5b1` and the release commit | local branch, **not pushed** | Push it, or copy `E:\loyalty` |

The licensing key's password is exactly the 28 characters in its `PASSWORD.txt`. The folder
before the 2026-09-15 re-seal, `E:\walaa-issuer-backup-2026-09-15-pre-reseal`, now opens with the
same plain password too (the issuer tries the old U+FEFF form itself); delete it once the live
folder is backed up. **If you delete `PASSWORD.txt`**, remove `--password-file "…"` from the card's
commands and type the password when asked.

## 6 · Known issues — found, deliberately not fixed

| Severity | Issue | Workaround |
|---|---|---|
| Medium | Installer not Authenticode-signed → SmartScreen / antivirus suspicion | Check the SHA-256; *More info → Run anyway*; exclude `C:\Program Files\ولاء` and `C:\ProgramData\LoyaltyPro` |
| Medium | Installing over a PC that already holds 0.2.x shop data is unverified (0.3.0's two migrations) | Install only on a PC without shop data; otherwise back up and call first |
| Medium | A Google OAuth client in **Testing** mode expires its refresh token after 7 days (Google's rule): Drive then shows «خطأ» with the reason | Publish the OAuth consent screen (GOOGLE-DRIVE-SETUP.md), or reconnect weekly |
| Medium | Changing ولاء's port needs `loyalty-pro.env` edited and the service re-registered, elevated — never run | Call me; `install --port` alone does not change an installed shop |
| Low | Windows PowerShell 5.1 turns non-ASCII in a pipe into `?` — a password piped that way cannot open the key | Use `--password-file` or the prompt (the card does) |
| Low | `renew` counts from the latest expiry in **this** log; a licence issued from another copy of the key folder is invisible to it | Use that copy's `--home` |
| Low | `drill:contention` and `drill:recover` need a 0.3.x production dataset that does not exist yet | Not run for 0.3.1 (RELEASING.md §4) |
| Low | `apps/api/prisma/loyalty-pro-template.json` gets a new `installationId` and hash on every `db:template`, so each build leaves a small diff | Commit it with the release |
| Low | A held sale's discount is not credited later — v4 settles a discount at its own payment | Shown on the cashier's card and the dashboard |
| Low | The tablet's *offline* queue lives in browser storage | Don't clear the tablet's browser data while it shows «بانتظار الإرسال» |
| Low | Sign-in is rate-limited per address; the dashboard does not keep a session across restarts | Wait a minute / sign in again |

## 7 · Not verified

1. **Installing 0.3.1** (service registration, firewall rule, ProgramData permissions, shortcuts,
   uninstall) — needs UAC. The NSIS hooks are unchanged since 0.2.3.
2. **The real Google flow past the sign-in page** — login, approve, callback from Google, upload
   to and restore from your real Drive. Everything after the sign-in page was run against a local
   stand-in that speaks Google's protocol; nothing proves Google answers the same way.
3. **The packaged window signed in**: the Drive card, Backup and Licence screens were exercised as
   the same React components in the dev page against the same 0.3.1 runtime; in the packaged window
   only the sign-in screen and the opener call were exercised. The desktop-only “browser could not
   open” panel was not rendered (its classification was checked against the real refusal text).
4. The renewal after expiry used a service clock moved forward 401 days, not days actually passing;
   the issuer ran at the real date, so its “was … still running” line reflects the real date.
5. A real Windows reboot; a real tablet, printer, capture agent and shop network.
6. `drill:contention`, `drill:recover`.
7. Pasting codes from WhatsApp on a phone into the dashboard (the paste cleanup is unit-tested).
