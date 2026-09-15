# Handover — ولاء 0.3.0

## 1 · The installer you carry

`E:\loyalty\apps\manager-desktop\src-tauri\target\release\bundle\nsis\ولاء_0.3.0_x64-setup.exe`

- **SHA-256 `68AE613ECC0C9A2CB677227F55769174359D6C5F3001F7C43C36A345D75EB12B`** · 33,877,004 bytes
- **Licensing:** your **production** key, fingerprint `FCA66207230B90CA` — not the development
  key (`49C862E0D57E50B7`). `verify-license-key.mjs` checked the staged module before packaging
  and would have refused the development key.
- **Update signature:** `…setup.exe.sig`, 420 bytes, SHA-256
  `8527AE1DCA2224C51CADA82C97B9E44ECB0F5E8DD4E9FFD5FC168F333D05B386`, key id
  `BE2E4C7B42C8D100` — your updater key, the one compiled into the app.
- **Not** Windows code-signed (Authenticode): SmartScreen will warn. Check the hash, then
  *More info → Run anyway*.
- Built from commit `84f20cc`; recorded in `RELEASING.md`.

Check on site: `Get-FileHash <file> -Algorithm SHA256`.

## 2 · Acceptance matrix — the final build

Run against the final build's own files (the staged runtime the installer packs, and the
release shell), **not installed** — installing needs an elevated prompt this session did not
have. Every line through the same endpoints the dashboard, the till and the capture agent use.

| Step | Result | Observed |
|---|---|---|
| Install | NOT RUN | needs UAC; see §6 |
| First launch | PASS | service 0.3.0 up, `demo:false`; setup required |
| Setup form | PASS (API) | owner created through `/auth/bootstrap` — the form's own call; the form was not typed into (§6) |
| Dashboard | PASS | owner signs in; till + capture accounts created |
| Licence | PASS | new install UNLICENSED, device `WL-34V4-WZNE`; refuses in Arabic; your production code activates at once |
| Customer | PASS | registered at the till, card issued |
| Invoice → discount | PASS | 60,000 IQD captured and scanned → 5% = 3,000 IQD |
| Voucher issued and redeemed | PASS | slip printed; redeemed; second redemption → 409 «تم استخدام هذه القسيمة مسبقاً» |
| Backup | PASS | key ceremony, backup taken, listed |
| Restore that backup | PASS | customer added after the backup gone; earlier data and redeemed voucher intact; owner signs in |
| Kill mid-operation | PASS | whole service tree killed during the 5th sale; file: integrity ok, 0 foreign-key problems, no half-recorded sale, no duplicate, all 5 acknowledged sales present |
| Reboot | PASS (simulated) | cold start after the power cut: service back, data there, next sale records. A real OS reboot was not done (§6) |
| Relaunch | PASS | release `walaa-manager.exe` opened, title «ولاء — إدارة المتجر», reached the service |

Two earlier kill attempts are in the log as FAIL: my script hit the login rate limit, then reused
invoice numbers, and stopped before the kill. The third attempt did the real kill.

**Held sales, done on the real till page against the final build:** refused sale → card «حُفظت
على جهاز المدير … الخصم الذي كانت هذه الفاتورة تستحقه: 2,500 د.ع — لن يُطبَّق», tablet queue 0;
till reloaded → still held; tablet already holding 2,000 queued items → the next refused sale
still held on the manager PC, queue unchanged at 2,000; browser data cleared → till signed out,
nothing lost; service tree killed and restarted → manager PC still reports 2 held, 4,500 IQD
forgone; activation → both credited at full price, no voucher, none left waiting.

## 3 · Every screen reachable

Per interactive element: brought into view, and the element under the pointer (not clipped,
not covered). Viewports are the packaged window's own, measured at each screen size with a
40-px taskbar.

| Screen size | Packaged window (sign-in screen) | All ten routes, logged in |
|---|---|---|
| 1920×1080 → 1904×1001 | 4/4 reachable, no overflow | 213 elements, 0 unreachable |
| 1600×900 → 1584×821 | 4/4 | 213, 0 |
| 1366×768 → 1350×689 | 4/4 | 213, 0 |
| 1280×720 → 1264×641 | 4/4 | 213, 0; setup form 8/8; key ceremony 3/3 |

The dashboard has no modals. Logged-in screens were checked in the same Chromium engine at those
viewports, because the packaged window cannot be signed into without typing a password.

## 4 · Strings

Fixed: the window and tab titles and the app name were "Customer loyalty"; every unexpected
failure answered the bare «حدث خطأ غير متوقع». Now Arabic, with where the fault is and what to do.
No file path or error code is rendered to the merchant. Left deliberately: Google's own field
names («Client ID», «Client secret»), "Google Drive", "Windows", "SMS", Latin example usernames
and branch codes (they must be Latin).

## 5 · Back up on install day — before anything else

| # | What | Where | If it is lost |
|---|---|---|---|
| 1 | **Licensing key + password** | `C:\Users\yaman\.walaa-issuer\` (`issuer-key.json`, `PASSWORD.txt`, `issued.db`) | No licence and no phone code can ever be issued again; every shop needs a new build, installed in person |
| 2 | **Update signing key + password** | `C:\Users\yaman\.walaa-signing\` (`walaa-updater.key`, `PASSWORD.txt`, `.pub`) | No installed shop can ever be updated again |
| 3 | The issuer program | `tools\license-issuer\target\release\license-issuer.exe` | Rebuildable from the repository — but you need it at the shop to switch it on |
| 4 | The shop's `walaa.env` | `C:\ProgramData\Walaa\walaa.env` (copy from an elevated prompt) | It holds that installation's sign-in and card secrets and the backup key; it is **not** inside the `.walaabk` backups. Lost with the data intact → every printed card must be re-issued |
| 5 | The backup key from the key ceremony | on paper, off the premises | Every backup that shop ever writes is unopenable |
| 6 | The owner password | the merchant's | No reset exists |
| 7 | The first `.walaabk` | your USB stick | — |
| 8 | This commit | the branch is committed locally, **not pushed** | Push it, or copy `E:\loyalty` |

Put 1 and 2 in the password manager (password + attached files) and on one offline USB stick,
then delete both `PASSWORD.txt` files from this PC.

## 6 · Known issues — found, deliberately not fixed

| Severity | Issue | Workaround |
|---|---|---|
| Medium | Installer not Authenticode-signed → SmartScreen / antivirus suspicion | Check the SHA-256; *More info → Run anyway*; exclusions for `C:\Program Files\Walaa`, `C:\ProgramData\Walaa` |
| Medium | Installing 0.3.0 over a PC that already holds 0.2.x shop data is unverified (two new migrations) | Install only on a PC without shop data; otherwise back up and call before installing |
| Medium | 0.3.0 must never go on the auto-update feed (migrations) | In-person installs only |
| Medium | The issuer's default key folder is `%APPDATA%\walaa-license-issuer` — empty | Always `--home C:\Users\yaman\.walaa-issuer` |
| Low | A held sale's discount is not credited later — v4 settles a discount at its own payment | Shown on the cashier's card and the dashboard; the cashier's sentence |
| Low | The tablet's *offline* queue (network down) lives in browser storage; clearing it loses those items. Licence-held sales are not affected | Don't clear the tablet's browser data while it shows «بانتظار الإرسال» |
| Low | Delete the licensing module *and* edit `last_status` to PERPETUAL → a working shop | None: deterrence bar |
| Low | Rolling back every time record at once replays a phone code inside its own window | None offline; costs every sale since the copy |
| Low | While the licensing module is missing, no code can be entered | Reinstall from the installer |
| Low | Sign-in is rate-limited per address | Wait a minute |
| Low | The dashboard does not keep a session across an app restart | Sign in again (by design) |
| Low | The raw release exe turns into a demo if `walaa-demo.db` lies beside it | Affects only running from the build folder, never the installer |
| Low | Installer's own language follows Windows (English on English Windows) | Operator-facing only |

## 7 · Not verified

1. Running the installer: service registration, firewall rule, ProgramData permissions,
   shortcuts, uninstall (no elevation). The NSIS hooks are unchanged from 0.2.3, which you
   installed on this machine yourself.
2. A real Windows reboot — simulated by a power-cut kill and a cold start. Run
   `verify-install.ps1` elevated after rebooting the shop PC.
3. Typing into the setup form: I do not type passwords into forms; the same API call was made,
   and every field and button was proven reachable.
4. Logged-in screens inside the packaged window itself (checked in the same engine at its
   measured viewports; the packaged window was checked on the sign-in screen).
5. A real tablet, receipt printer, the capture agent on a real register, the shop's network.
6. The tablet browser's storage limit.
7. Google Drive upload end to end; the updater's last mile.
8. A held sale whose invoice another customer claimed meanwhile (closed, not applied) — code
   present, not exercised.
9. The ten-minute periodic held-sales pass (start-up and activation paths were exercised).
10. The till's screens other than scan and its held cards, at tablet sizes.
