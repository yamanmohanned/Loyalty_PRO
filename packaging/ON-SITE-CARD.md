# On-site card — install day, ولاء 0.3.1

One page. Ordered by **how likely it is**. Every command below was run as written on the build
PC on 2026-09-17, in a fresh Windows PowerShell 5.1 window — the only change allowed is the
`WL-` number and the shop name. If your laptop keeps the program or the key folder somewhere
else, change those two paths and nothing else.

**Installer:** `ولاء_0.3.1_x64-setup.exe` · 33,881,377 bytes ·
SHA-256 `7EB47888D3264748C6463E877697B8F2269DAF65E0E5B9BB0A5DC115549B5967`
Check it in the folder that holds it: `Get-FileHash .\ولاء_0.3.1_x64-setup.exe -Algorithm SHA256`

**Before you leave home:** the laptop holds `license-issuer.exe` **and** the key folder
`C:\Users\yaman\.walaa-issuer`. Run **0** — it opens the key, issues nothing, writes nothing.

## The licence commands

```powershell
# 0 · Before leaving: prove the key and its password open (issues nothing)
& "E:\loyalty\tools\license-issuer\target\release\license-issuer.exe" --home "C:\Users\yaman\.walaa-issuer" --password-file "C:\Users\yaman\.walaa-issuer\PASSWORD.txt" check

# 1 · FIRST licence for a shop PC — 14-day trial (paid shop: replace --days 14 with --perpetual)
& "E:\loyalty\tools\license-issuer\target\release\license-issuer.exe" --home "C:\Users\yaman\.walaa-issuer" --password-file "C:\Users\yaman\.walaa-issuer\PASSWORD.txt" issue --device WL-XXXX-XXXX --days 14 --note "shop name"

# 2 · RENEW a PC that already has a licence — 30 more days (licensed or already read-only)
& "E:\loyalty\tools\license-issuer\target\release\license-issuer.exe" --home "C:\Users\yaman\.walaa-issuer" --password-file "C:\Users\yaman\.walaa-issuer\PASSWORD.txt" renew --device WL-XXXX-XXXX --days 30

# 3 · The shop paid: make its licence permanent
& "E:\loyalty\tools\license-issuer\target\release\license-issuer.exe" --home "C:\Users\yaman\.walaa-issuer" --password-file "C:\Users\yaman\.walaa-issuer\PASSWORD.txt" renew --device WL-XXXX-XXXX --perpetual

# 4 · Phone code — 15 symbols to read out when no message can reach the shop PC
& "E:\loyalty\tools\license-issuer\target\release\license-issuer.exe" --home "C:\Users\yaman\.walaa-issuer" --password-file "C:\Users\yaman\.walaa-issuer\PASSWORD.txt" unlock --device WL-XXXX-XXXX --days 7

# 5 · What has this PC been issued? (no password)
& "E:\loyalty\tools\license-issuer\target\release\license-issuer.exe" --home "C:\Users\yaman\.walaa-issuer" list --device WL-XXXX-XXXX
```

- **No `PASSWORD.txt` on the laptop?** Delete `--password-file "…"` from the line and type the
  password when asked. Spaces, a byte-order mark or a line ending around the password no longer
  matter, whichever shell or file it comes from. **Never pipe it** (`… | &`): Windows PowerShell
  turns any non-English character in a pipe into `?`.
- **`issue` refuses a PC that already has a licence** and tells you to use `renew`. That is on
  purpose: `issue --days 30` from today could end *before* the licence the shop holds and change
  nothing.
- **Renewal, in full.** `renew --days 30` adds 30 days to the **end** of that PC's latest
  licence in your log (or to today, if it has already ended), keeps its note and features, and
  prints the new code. The merchant pastes it into **الإعدادات ← الترخيص ← رمز التفعيل ← تفعيل**
  exactly like the first one. It takes effect at once, no restart. **The old licence needs
  nothing done to it:** the program keeps every code and runs on the one that lasts longest, so
  pasting an old code again can never shorten anything. Tested both ways on 2026-09-17: a PC
  still on its trial went from 2027-09-16 to 2027-10-16; a PC already **EXPIRED and read-only**
  went back to TRIAL the moment the code was pasted, and the sale it had refused was credited.

---

### 1 · Everything installed, and the shop is read-only — «البرنامج غير مفعّل»
*Certain. A new installation starts unlicensed on purpose.*
**Check:** الإعدادات ← الترخيص → read «رقم هذا الجهاز» (`WL-XXXX-XXXX`).
**Fix:** command **1** with that number → paste the whole code into «رمز التفعيل» → «تفعيل». At
once; any sale held meanwhile is credited. Message can't reach the PC → command **4**, type the
15 symbols into «رمز الطوارئ».

### 2 · Windows blocks the installer — "Windows protected your PC", or the antivirus eats it
*Very likely: the installer is not Windows code-signed.*
**Check:** the SHA-256 above. Blue box = SmartScreen. File gone / service dies = Windows
Security → Protection history, and the shop's own antivirus.
**Fix:** SmartScreen → **More info → Run anyway**. Antivirus: exclude `C:\Program Files\ولاء`
and `C:\ProgramData\Walaa`, then reinstall. Never switch the antivirus off.

### 3 · The till tablet cannot reach the manager PC
**Check:** on the tablet open `http://<PC-IP>:4000/health` (must show `"status":"ok"`). On the PC:

```powershell
Get-NetConnectionProfile
```
`NetworkCategory` must be **Private**.
**Fix:** Settings → Network → Ethernet/Wi-Fi → **Private**. Same Wi-Fi/LAN for both. Reserve the
PC's IP on the router.

### 4 · The installer ran without Administrator — «جارٍ تشغيل البرنامج» never goes away
**Check:** `services.msc` → is **WalaaApi** listed?
**Fix:** right-click the installer → **Run as administrator** → accept UAC. *(The manual
`walaa-service.exe install` route needs an elevated prompt and was not run on the build PC.)*

### 5 · «ربط حساب Google» — what you should see now
Pressing it opens Google's sign-in page **in the PC's own browser** within a second, and the card
shows «بانتظار موافقتك في صفحة Google» with the link to copy. Pressing again reopens the same page
— it no longer counts attempts or says «عدد كبير من المحاولات». If the browser cannot be opened,
the card says why in red and shows the link: copy it into Chrome/Edge on that PC. After you
approve, the card turns «مربوط» with the account's e-mail.

### 6 · The PC's date, time or time zone is wrong
**Symptom:** activation refused «تاريخ هذا الجهاز أقدم من تاريخ إصدار الرمز», or the clock banner.
**Fix:** Settings → Time & language → set automatically + **(UTC+03:00) Baghdad**. Recording
resumes by itself. A perpetual licence ignores the clock.

### 7 · Port 4000 is taken by other software
**Check** (this one works without Administrator):

```powershell
Get-NetTCPConnection -LocalPort 4000 -State Listen | Select-Object OwningProcess
```
then `Get-Process -Id <that number>`.
**Fix:** stop the other program. Changing ولاء's port means editing `API_PORT` in
`C:\ProgramData\Walaa\walaa.env` from an elevated Notepad, then elevated
`walaa-service.exe uninstall` and `install` (the install re-reads the port for the firewall rule)
— **not run on the build PC; call me first.** `install --port` alone does *not* change an
existing installation.

---

**Expected, not failures:** «إعداد المتجر لأول مرة» appears once — the merchant types his own
owner password (min. 10 characters, **no reset exists**). Then the key ceremony — the key goes on
paper and leaves with you. Then **الإعدادات ← حسابات الدخول**: a **محطة** account for the tablet
and a **برنامج الالتقاط** account for the cashier PC.

**Do not install over a PC that already holds ولاء with customers on it.** Take its backup and
call me first.

**If none of these:** stop. Copy `C:\ProgramData\Walaa\logs\` to USB, photograph the Arabic
message, note the version at the bottom of the navigation rail. The till keeps selling without us.

**Before you leave — the two-minute proof:** activate; enter the discount rules; register a
customer; ring a sale over the threshold and capture it; scan card + invoice → a slip with a
discount; redeem it, then **again** → «تم استخدام هذه القسيمة مسبقاً»; النسخ الاحتياطي → «أخذ نسخة
الآن» → «اختبار الاستعادة الآن»; copy one `.walaabk` and the key paper to your USB stick.
