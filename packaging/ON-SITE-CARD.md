# On-site failure card — install day

One page. Ordered by **how likely it is**, not how bad it is. The merchant is watching;
work down the list.

**Before anything else:** `services.msc` → is **WalaaApi** Running? And the logs are at
`C:\ProgramData\Walaa\logs\` — you can open them as yourself, no elevation needed.

---

### 1 · The tablet at the till cannot reach the manager PC
*By far the most likely. Nothing is broken; the network is.*

| | |
|---|---|
| **Symptom** | Tablet browser: "can't reach this page", or a spinner forever. The dashboard on the manager PC works perfectly. |
| **Check** | On the tablet, open `http://<MANAGER-IP>:4000/health`. Then on the manager PC: `Get-NetConnectionProfile` — is `NetworkCategory` **Private**? |
| **Fix** | Almost always the network profile. Settings → Network → Ethernet → **Private**. The firewall rule the installer added only matches Private and Domain, on purpose — opening a port on an unknown network is not something to do silently. If it is already Private: confirm both devices are on the same Wi-Fi/LAN, then re-check the IP has not changed (§2 of the runbook — reserve it on the router). |

---

### 2 · The installer needs Administrator and did not get it
*Second most likely, and it looks like success.*

| | |
|---|---|
| **Symptom** | Installer finishes with no error. The app opens and sits on «جارٍ تشغيل البرنامج» forever. |
| **Check** | `services.msc` → is **WalaaApi** listed at all? If it is missing, the service was never registered. |
| **Fix** | Right-click the installer → **Run as administrator**, and accept the UAC prompt. If you cannot re-run it, open an **elevated** PowerShell and register it by hand: `& "C:\Program Files\Walaa\runtime\walaa-service.exe" install` then `& "C:\Program Files\Walaa\runtime\walaa-service.exe" start` |

---

### 3 · Port 4000 is already taken by something else on that PC
*Common on a PC that has had other software on it.*

| | |
|---|---|
| **Symptom** | Service shows Running, but the dashboard still says «جارٍ تشغيل البرنامج». `logs\api.log` ends with a bind or `EADDRINUSE` error. |
| **Check** | Elevated PowerShell: `Get-NetTCPConnection -LocalPort 4000 -State Listen \| Select OwningProcess` then `Get-Process -Id <that>`. |
| **Fix** | Either stop the other program, or move ولاء: elevated, `& "C:\Program Files\Walaa\runtime\walaa-service.exe" install --port 4010`, restart the service, and **use `:4010` in the tablet's address**. The port is published to the dashboard automatically — it finds its own service — so only the tablet's bookmark needs changing. |

---

### 4 · First launch shows a setup screen and the merchant expects a login
*Not a fault. Know it is coming so you are not surprised in front of him.*

| | |
|---|---|
| **Symptom** | «إعداد المتجر لأول مرة» — a form asking for the shop name, branch, owner name and a password. |
| **Check** | Nothing. This is correct: nothing ships with a password, so the shop creates its own owner. It appears exactly once. |
| **Fix** | Fill it in **with the merchant**, and let him choose and type the password himself. Minimum 10 characters. Write it down with him — **there is no password reset for the owner**. Then the key ceremony, also mandatory and also once: write that key on paper and take a copy away. **Then — before the tablet can do anything — الإعدادات ← حسابات الدخول:** create a **محطة** account for the tablet and a **برنامج الالتقاط** account for the cashier PC. Nothing ships with either; the tablet cannot sign in until you do. If the form refuses a value it marks the field and says the rule — the branch code and usernames are English letters and digits only. |

---

### 5 · Antivirus quarantines the service or the installer
*Unsigned binaries on a shop PC with an aggressive AV.*

| | |
|---|---|
| **Symptom** | Install fails part-way, or the service starts and dies repeatedly. `logs\service.log` shows the child exiting immediately. Or the installer vanishes from the Downloads folder. |
| **Check** | Windows Security → Protection history. Also check whatever third-party AV the shop runs — that is usually the culprit, not Defender. |
| **Fix** | Add exclusions for `C:\Program Files\Walaa` and `C:\ProgramData\Walaa`, then reinstall. Do not disable the AV outright on a shop's PC. |

---

### 6 · The service will not start and names the database or the settings file
*Least likely on a fresh install — but the one where doing the wrong thing is expensive.*

| | |
|---|---|
| **Symptom** | A screen with a specific Arabic sentence about قاعدة البيانات or ملف الإعدادات. On the manager PC there is **no address box** on any of these screens — if you see one, you are on a second PC. |
| **Check** | **Read which sentence it is.** They need opposite things:<br>· «ملفات البرنامج المثبّتة ناقصة» / «غير متطابقة» / «غير مكتملة» → **the build**, not his data<br>· «قاعدة البيانات الموجودة على هذا الجهاز أنشأها إصدار مختلف» → his data, from another build<br>· «ملف إعدادات البرنامج غير موجود» / «مفقودة» / «لا يمكن قراءته» → `walaa.env`<br>· «ملف قاعدة البيانات تالف» / «تحديث لبنية قاعدة البيانات بدأ ولم يكتمل» → damaged or interrupted |
| **Fix** | **First:** reinstall from the full installer — it replaces Program Files and never touches data. Do not restore a backup for this. **Second and third:** do **not** reinstall — it changes nothing, and for the settings file the installer refuses on purpose, because new secrets would invalidate every printed card. Copy `C:\ProgramData\Walaa\logs\` and call me. **Fourth:** bring the newest `.walaabk`; restoring is done with `walaa-restore.cjs` from the runtime folder, not from the dashboard, which cannot restore while the service is down. **Never delete a file from `C:\ProgramData\Walaa`.** |

An **empty** database left by an earlier install is no longer a refusal: it is renamed beside
itself as `walaa.db.superseded-<time>` and the setup screen appears. That is expected.

---

## If none of these is it

Stop. Do not improvise on a live shop.

1. Copy the whole of `C:\ProgramData\Walaa\logs\` to a USB stick.
2. Photograph the screen showing the Arabic message.
3. Note the version from the bottom of the navigation rail.
4. Leave the shop working the way it worked yesterday — the till and register are
   independent of this software. Nothing about a failed install stops them selling.

---

## The two-minute proof it actually works

Before you leave, with the merchant watching:

0. The till and capture-agent accounts exist (§4), and the discount rules he agreed to are
   entered in **قواعد الخصم**. A new shop has **no** rules, so nothing is discounted until
   you enter them — the sale still records.
1. Register a customer on the tablet.
2. Ring a real sale over the discount threshold; capture the invoice.
3. Scan the card, then the invoice → the slip prints with a discount.
4. Redeem the slip. **Try to redeem it a second time** — it must be refused with
   «تم استخدام هذه القسيمة مسبقاً». Show him that; it is the thing protecting his money.
5. **الإعدادات → النسخ الاحتياطي** → «نسخ احتياطي الآن», then «اختبار الاستعادة».
6. Copy one `.walaabk` from `C:\ProgramData\Walaa\backups` to your USB stick and take
   it with you, along with the encryption key.
