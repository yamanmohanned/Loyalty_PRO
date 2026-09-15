# On-site card — install day, ولاء 0.3.0

One page. Ordered by **how likely it is**, not how bad it is. Work down the list.

**Before you leave home:** the laptop you carry holds `license-issuer.exe`
(`tools\license-issuer\target\release\`) **and** the key folder
`C:\Users\yaman\.walaa-issuer` (key + password). Without both you cannot switch the shop on.
**Every** issuer command needs `--home C:\Users\yaman\.walaa-issuer` — without it the tool
looks in `%APPDATA%\walaa-license-issuer`, finds no key, and refuses.

**First look, always:** `services.msc` → **WalaaApi** Running? Logs: `C:\ProgramData\Walaa\logs\`.

---

### 1 · Everything installed, and the shop is read-only — «البرنامج غير مفعّل»
*Certain to happen. A new installation starts unlicensed on purpose.*

| | |
|---|---|
| **Symptom** | Red banner on every screen; the till says «لم تُحتسب هذه الفاتورة للزبون الآن»; registering a customer is refused. |
| **Check** | **الإعدادات ← الترخيص** → read «رقم هذا الجهاز» (`WL-XXXX-XXXX`). |
| **Fix** | On your laptop: `license-issuer --home C:\Users\yaman\.walaa-issuer issue --device WL-XXXX-XXXX --perpetual --note "<shop name>"` (or `--days N` for a trial). Paste the whole code into «رمز التفعيل» → «تفعيل». It takes effect at once, and any sale held meanwhile is credited automatically. If the code cannot reach the PC: `license-issuer --home C:\Users\yaman\.walaa-issuer unlock --device WL-XXXX-XXXX --days 7` and type the 15 symbols into «رمز الطوارئ». |

### 2 · Windows blocks the installer — "Windows protected your PC", or the antivirus eats it
*Very likely: the installer carries your update signature, not a Windows code-signing certificate.*

| | |
|---|---|
| **Symptom** | A blue SmartScreen box, or the file vanishes from the USB stick / Downloads. |
| **Check** | Blue box → it is SmartScreen. File gone or the service dies at once → Windows Security → Protection history, and the shop's third-party antivirus. |
| **Fix** | SmartScreen: **More info → Run anyway**. First confirm the file is yours: `Get-FileHash <file> -Algorithm SHA256` must equal the hash in the handover report. Antivirus: exclude `C:\Program Files\Walaa` and `C:\ProgramData\Walaa`, then reinstall. Never disable the antivirus outright. |

### 3 · The till tablet cannot reach the manager PC
*The usual network problem. Nothing is broken; the network is.*

| | |
|---|---|
| **Symptom** | Tablet: "can't reach this page" or «تعذّر الاتصال بالخادم». The dashboard on the PC works. |
| **Check** | On the tablet open `http://<PC-IP>:4000/health`. On the PC: `Get-NetConnectionProfile` → `NetworkCategory` must be **Private**. |
| **Fix** | Settings → Network → Ethernet/Wi-Fi → **Private**. Same Wi-Fi/LAN for both. Reserve the PC's IP on the router so it never moves. |

### 4 · The installer ran without Administrator — the app waits for ever
*Looks like success.*

| | |
|---|---|
| **Symptom** | «جارٍ تشغيل البرنامج» never goes away. |
| **Check** | `services.msc` → is **WalaaApi** listed at all? |
| **Fix** | Right-click the installer → **Run as administrator** → accept UAC. Or, from an elevated PowerShell: `& "C:\Program Files\Walaa\runtime\walaa-service.exe" install` then `... start`. |

### 5 · The PC's date, time or time zone is wrong
*Common on shop PCs with a flat CMOS battery.*

| | |
|---|---|
| **Symptom** | Activation refused with «تاريخ هذا الجهاز أقدم من تاريخ إصدار الرمز», or the banner «تاريخ جهاز المدير ووقته متأخران…». |
| **Check** | Windows clock vs your phone. Time zone must be **(UTC+03:00) Baghdad**. |
| **Fix** | Settings → Time & language → set automatically + Baghdad, or set it by hand. Recording resumes by itself once the clock is right. A perpetual licence ignores the clock entirely. |

### 6 · Port 4000 is taken by other software
| | |
|---|---|
| **Symptom** | WalaaApi Running, dashboard still «جارٍ تشغيل البرنامج»; `logs\api.log` ends with `EADDRINUSE`. |
| **Check** | Elevated: `Get-NetTCPConnection -LocalPort 4000 -State Listen \| Select OwningProcess` → `Get-Process -Id <pid>`. |
| **Fix** | Stop the other program, or elevated: `& "C:\Program Files\Walaa\runtime\walaa-service.exe" install --port 4010`, restart the service, and use `:4010` on the tablet. |

---

**Expected, not failures:** «إعداد المتجر لأول مرة» appears once — let the merchant type his own
owner password (min. 10 characters, **no reset exists**). Then the key ceremony — the key goes on
paper and leaves the building with you. Then **الإعدادات ← حسابات الدخول**: a **محطة** account for
the tablet and a **برنامج الالتقاط** account for the cashier PC.

**Do not install over a PC that already holds ولاء with customers on it.** Upgrading 0.2.x data to
0.3.0 was not verified. Take its backup and call me first.

**If none of these:** stop. Copy `C:\ProgramData\Walaa\logs\` to USB, photograph the Arabic message,
note the version at the bottom of the navigation rail. The till and register keep selling without us.

**Before you leave — the two-minute proof:** activate; enter the discount rules; register a
customer; ring a sale over the threshold and capture it; scan card + invoice → a slip with a
discount; redeem it, then redeem it **again** → «تم استخدام هذه القسيمة مسبقاً»; النسخ الاحتياطي →
«نسخ احتياطي الآن» → «اختبار الاستعادة»; copy one `.walaabk` and the key to your USB stick; after a
reboot run `C:\Program Files\Walaa\runtime\verify-install.ps1` (elevated).
