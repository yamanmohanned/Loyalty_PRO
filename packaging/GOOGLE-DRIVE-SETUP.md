# Google Drive — setting up the off-machine copy

The shop's backups are encrypted on the manager PC before anything else sees them. Google
Drive is a second place to keep those same encrypted files, so that a dead disk, a theft or
ransomware on that PC does not take every copy with it. Drive never receives readable shop
data, and the local backup runs the same whether Drive is connected, broken or absent.

This page has two halves: what you do once in **Google Cloud** (in a browser), and what you do
in **ولاء** (Settings). Then: restoring from Drive, what happens when Google's permission
stops working, and every message the app can show about Drive.

> **How the Google Cloud steps below were written.** They are taken from Google's own pages,
> fetched on 2026-09-13 (each page said *Last updated 2026-09-03*), and linked at each step.
> I did **not** click through them: that needs a Google account, and creating projects or
> signing in on your behalf is yours to do. Google moves console menus; if a label differs,
> the linked page is the authority. Everything in the ولاء half was executed as written —
> against the packaged build, talking to a local stand-in for Google (see the last section).

---

## Part 1 — In Google Cloud (once)

Use the Google account that should **own the project** — it can be the same account that
will hold the backups, or yours as the person setting it up.

### 1. Create a project

*Source: [Create a Google Cloud project](https://developers.google.com/workspace/guides/create-project)*

1. In the Google Cloud console: **Menu → IAM & Admin → Create a Project**.
2. **Project Name**: anything descriptive, e.g. `Walaa Backups – <shop name>`.
3. (Optional) **Edit** the **Project ID** — it cannot be changed later.
4. **Location** → **Browse** → **Select**.
5. **Create**. The project is ready within a few minutes.

### 2. Turn on the Google Drive API

*Source: [Enable Google Workspace APIs](https://developers.google.com/workspace/guides/enable-apis)*

1. **Menu → APIs & Services → Library → Google Workspace**.
2. Click **Google Drive API** → **Enable**.

(Equivalent command, if you use the Cloud CLI: `gcloud services enable drive.googleapis.com`.)

### 3. Configure the consent screen

*Source: [Configure the OAuth consent screen](https://developers.google.com/workspace/guides/configure-oauth-consent)*

1. **Menu → Google Auth platform → Branding** (direct link:
   <https://console.developers.google.com/auth/branding>).
2. **App name** — what the owner will see when granting access, e.g. `ولاء — النسخ الاحتياطي`.
   **User support email** — your address.
3. **Audience** — choose the user type. With an ordinary Google account this is
   **External**. (**Internal** exists for Google Workspace organisations and limits access to
   that organisation's members.)
4. **Contact Information** — an email for project notifications.
5. **Finish** — accept the *Google API Services User Data Policy* — **Create**.

### 4. Ask for exactly one permission: `drive.file`

1. **Data Access → Add or Remove Scopes**.
2. Add **`https://www.googleapis.com/auth/drive.file`** — and nothing else.

`drive.file` lets ولاء see and change **only files ولاء itself created**. It cannot list, open
or delete anything else in the account. Google classifies it as **non-sensitive**
([Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)).
The app asks for this scope and no other; the Settings panel shows the scope it requests.

### 5. Add the test user (while the app is in Testing)

**Audience → Test users → Add users** → add the Google account that will **hold the
backups**. A new app starts in **Testing**; only listed test users (up to 100) can grant it
access.

### 6. Create the client — and copy the secret *now*

*Sources: [Create access credentials](https://developers.google.com/workspace/guides/create-credentials),
[Manage OAuth clients](https://support.google.com/cloud/answer/15549257)*

1. **Google Auth platform → Clients → Create Client**.
2. **Application type → Desktop app**. (Not "Web application". ولاء receives Google's reply on
   `http://127.0.0.1:<port>` on the manager PC, which is the pattern Google recommends for
   Windows desktop apps —
   [OAuth for installed apps](https://developers.google.com/identity/protocols/oauth2/native-app).)
3. **Name** — seen only in the console, e.g. `Walaa manager PC`.
4. **Create**.
5. Copy **both** values from the dialog that appears:
   - **Client ID** — ends in `.apps.googleusercontent.com`.
   - **Client secret**.

**The secret is shown only once.** Google: client secrets are *"only visible and downloadable
from the Google Cloud Console at the time of their creation"* (for clients created after June
2025, and for existing clients from November 2025). Store it somewhere safe. If it is lost,
open the client's page and press **Add Secret**, then enter the new one in ولاء; the old one
can be **Disable**d and then deleted there.

### 7. Testing, or In production — and whether Google must verify the app

*Sources: [Manage app audience](https://support.google.com/cloud/answer/15549945),
[OAuth app verification](https://support.google.com/cloud/answer/13463073),
[Unverified apps](https://support.google.com/cloud/answer/7454865),
[Refresh token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)*

| | **Testing** | **In production** |
|---|---|---|
| Who can connect | Only the listed test users, **up to 100** | Any Google account |
| How long the permission lasts | An External app in Testing gets refresh tokens that **expire after 7 days** | Until one of the reasons in Part 4 applies |
| What the shop sees | Drive stops every seventh day with «انتهت صلاحية إذن Google Drive.» until reconnected | Uploads continue |

**For a shop, publish the app:** **Audience → Publish app** moves it to **In production**.
Staying in Testing means reconnecting every week.

**Verification.** Google: *"If your app utilizes only non-sensitive scopes, it is not
mandatory for your app to complete the app verification process."* `drive.file` is
non-sensitive, so a one-shop setup does not need Google's verification. Google's
*unverified app* warning is shown for sensitive or restricted scopes, not for `drive.file`.
Only if you want your **app name and logo** shown on the consent screen do you need the
lighter **brand verification**. (Google's consent-screen page lists non-sensitive scopes as
"Basic app verification required"; its help-centre page above says that verification is not
mandatory for them. What the consent screen looks like for this app, unbranded, is one of
the things only the first real connection will show — see the last section.)

---

## Part 2 — In ولاء (on the manager PC, as the owner)

**الإعدادات → النسخ الاحتياطي إلى Google Drive.** Only the owner's account can save the
client, connect or disconnect.

### 1. «إعدادات الربط مع Google»

- **«معرّف العميل (Client ID)»** — the Client ID from step 6.
- **«سرّ العميل (Client secret)»** — the secret from step 6.
- Press **«حفظ إعدادات الربط»**.

A malformed id is refused under the field («معرّف العميل غير صحيح — ينتهي بـ
‎.apps.googleusercontent.com…»). Once saved, the panel shows the Client ID and
«السرّ محفوظ مشفّراً على هذا الجهاز منذ …» — never the secret itself.

### 2. «حساب Google»

Press **«ربط حساب Google»**. Your browser opens Google's consent page; sign in with the
account that will **hold the backups** (a test user, if the app is still in Testing) and
allow access. Return to ولاء: the panel shows **«الحساب المربوط:»** with that account's email.
Check it is the shop's account.

### 3. Is it working

- **«اختبار الاتصال»** — proves the whole chain, step by step: «الإذن من Google», «رفع ملف
  اختبار صغير», «قراءة الملف والتأكّد أنه مطابق», «حذف ملف الاختبار». A failed step shows
  the reason and what to do; later steps show «لم تُجرَ». The test file is deleted even
  if reading it back fails.
- **«ارفع نسخة الآن»** — takes a backup now and uploads it.
- **«آخر نسخة ناجحة:»** — the last upload that actually landed in Drive.
- **«الرفع المجدول القادم:»** — daily at 23:30 shop time and after every 500 transactions
  (the same schedule as the local copy).
- **«النسخ الموجودة في Drive:»** and **«عدد النسخ المحفوظة في Drive»** — how many copies
  Drive keeps; older ones are deleted automatically.

**«فصل الحساب»** revokes the permission at Google and forgets it on this PC. The client id
and secret stay, so reconnecting needs no retyping. To delete them, or replace them with a
different client, disconnect first.

### Where the credentials are kept — and where they are not

In the service's data folder (`C:\ProgramData\Walaa\drive\` on a shop PC, locked to SYSTEM and
Administrators):

- `drive-client.json` — the Client ID in the clear (Google treats it as public; it appears in
  every consent link) and the **secret encrypted** (AES-256-GCM).
- `drive-connection.json` — the refresh token **encrypted**, the linked account, the upload
  record.
- `drive.key` — the key for both.

Not in `walaa.env`: on a shop PC a client or refresh token placed there is **ignored**. Not in
any log: the request log redacts the secret field and nothing else writes it. Not in any
response: the API returns the Client ID only. Not in the audit trail: the row records the
Client ID and that a secret was stored. Checked on the packaged build by searching every file
under an installation's data folder — database, WAL, logs and Drive state — for the secret:
none contained it.

What this does **not** protect against: someone who can already read the whole data folder as
an administrator can read `drive.key` too.

---

## Part 3 — Restoring from Drive

**النسخ الاحتياطي → «استعادة نسخة»** lists copies from every place they are kept, Google Drive
included (labelled «Google Drive»). Choose one → **«استعادة هذه النسخة»**: it is downloaded,
decrypted and checked beside the live data, and you are shown its date, what it holds against
what the program holds now, and what will no longer exist. Nothing changes until you press
**«تأكيد الاستعادة وإعادة التشغيل»**; a backup of the present state is taken first and appears
in the same list.

**On a replacement PC** (the old one is gone):

1. Install ولاء and complete the first owner and the encryption-key ceremony as usual.
2. In Settings, enter the **same Client ID and secret** (from the same Google Cloud project —
   `drive.file` only sees files created by this app; a different project is a different app).
3. **«ربط حساب Google»** with the **same Google account** that held the backups.
4. **النسخ الاحتياطي → «استعادة نسخة»** → choose a Drive copy. Because the new PC has its own
   new key, ولاء says the copy is «مشفّرة بمفتاح غير مفتاح هذا الجهاز» and shows the
   fingerprint it needs; type the **old key from the paper** into «مفتاح التشفير لهذه النسخة»
   and press «فتح النسخة بهذا المفتاح».

---

## Part 4 — When Google's permission stops working

*Source: [Refresh token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)*

ولاء holds a *refresh token* — Google's standing permission. Google says it stops working when:

- the owner **revoked** access (Google Account → Security → third-party access);
- it has **not been used for six months**;
- the app is **External and in Testing**: it expires after **7 days**;
- the account has more than **100 live refresh tokens for this client** — each connection mints
  a new one, and beyond 100 the oldest stop working;
- an administrator restricted the Drive service, or granted time-based access that ran out
  (Google Workspace accounts).

What the shop sees, and what to do:

| Situation | ولاء shows | Do this |
|---|---|---|
| Access revoked at Google | «تم إلغاء إذن الوصول إلى Google Drive من حساب Google.» | «ربط حساب Google» again, same account |
| Expired (6 months unused, or 7-day Testing) | «انتهت صلاحية إذن Google Drive.» | «ربط حساب Google» again; if it recurs weekly, **Publish app** (Part 1, step 7) |
| Client deleted or secret changed in Google Cloud | «إعدادات الربط مع Google غير صحيحة على هذا الجهاز.» | Enter the correct Client ID/secret; disconnect and reconnect |

Reconnecting always asks Google for a fresh refresh token (ولاء requests offline access with a
forced consent prompt). Backups already in Drive are not affected. Local backups never stop.

---

## Part 5 — Every Drive message, and what it means

Shown on the Settings panel, in «اختبار الاتصال» results, and in the Backup screen when an
upload fails. Each has a sentence (what happened) and a remedy (what to do).

| Code | ولاء shows | Remedy shown |
|---|---|---|
| `NOT_CONFIGURED` | النسخ الاحتياطي إلى Google Drive غير مُعدّ على هذا الجهاز. | أدخل «معرّف العميل» و«سرّ العميل» من مشروعك في Google Cloud في «إعدادات الربط مع Google» أعلاه، ثم اضغط «ربط حساب Google». حتى ذلك الحين تُحفظ النسخ الاحتياطية على هذا الجهاز فقط — وعطل في القرص أو سرقة يُفقد كل شيء. |
| `NOT_CONNECTED` | لم يُربط أي حساب Google بعد، أو تم فصل الحساب. | اضغط «ربط حساب Google» وسجّل الدخول بالحساب الذي تريد حفظ النسخ فيه. |
| `NETWORK` | تعذّر الوصول إلى Google Drive — لا يوجد اتصال بالإنترنت. | تحقّق من اتصال الإنترنت في المتجر. النسخة المحلية أُخذت بنجاح، وسيُعاد الرفع تلقائياً عند عودة الاتصال. |
| `REVOKED` | تم إلغاء إذن الوصول إلى Google Drive من حساب Google. | أعد الربط: اضغط «ربط حساب Google» وسجّل الدخول بالحساب نفسه. لا تُلغِ الإذن من صفحة أمان Google بعد ذلك. |
| `EXPIRED` | انتهت صلاحية إذن Google Drive. | أعد الربط بالضغط على «ربط حساب Google». لن تتأثّر النسخ المرفوعة سابقاً. إن تكرّر هذا كل سبعة أيام فمشروع Google Cloud ما زال في وضع الاختبار (Testing) — انقله إلى الإنتاج (In production) من صفحة Audience. |
| `AUTH_CLIENT` | إعدادات الربط مع Google غير صحيحة على هذا الجهاز. | تحقّق من «معرّف العميل» و«سرّ العميل» في «إعدادات الربط مع Google» — قد يكون العميل حُذف من Google Cloud أو تغيّر سرّه. أدخل القيم الصحيحة، ثم افصل الحساب وأعد ربطه. |
| `QUOTA` | مساحة Google Drive ممتلئة، فلم تُرفع النسخة الاحتياطية. | أفرغ مساحة في حساب Google أو اشترِ مساحة إضافية، أو قلّل عدد النسخ المحفوظة في الأسفل. |
| `PERMISSION` | لا يملك البرنامج صلاحية الوصول إلى هذا الملف في Google Drive. | أعد الربط بالضغط على «ربط حساب Google». البرنامج لا يرى إلا الملفات التي أنشأها بنفسه، فإن حُذف مجلدها يدوياً وجب إعادة الربط. |
| `UNKNOWN` | لم تُرفع النسخة الاحتياطية إلى Google Drive. | النسخة المحلية أُخذت بنجاح. أعد المحاولة، وإن تكرّر الأمر أرسل سجلّ البرنامج إلى مزوّد البرنامج. |

How Google's replies map to these (from `apps/api/src/services/backup/drive-errors.ts`):
`invalid_client` / HTTP 401 at the token endpoint → `AUTH_CLIENT`; `invalid_grant` → `REVOKED` or
`EXPIRED` by the word in Google's description (both, or neither → `REVOKED`); Drive 403 with
`storageQuotaExceeded`/`quotaExceeded`/rate-limit reasons, or 429 → `QUOTA`; other 403 and 404 →
`PERMISSION`; 5xx and lost connections → `NETWORK`; anything else → `UNKNOWN`.

---

## What has been proven, and what has not

**Proven** — on the packaged build (`walaa-api.cjs`), a fresh installation, talking over TCP to
a local stand-in that speaks Google's token, consent and Drive endpoints
(`apps/api/src/__tests__/helpers/fake-google.ts`, which checks PKCE and withholds the refresh
token unless offline access with a consent prompt was requested, as Google does):

- saving the client through Settings; the secret absent from the response and from every file
  under the installation's data folder; a malformed Client ID refused under its field;
- consent requesting `drive.file` only; connection; the linked account shown;
- «اختبار الاتصال» passing all four steps and leaving no file behind; stopping at the failing
  step with the right code when Drive is full or refuses the write;
- «ارفع نسخة الآن» landing a copy; the local copy still landing with Drive failing;
- a Drive copy listed on the Backup screen, downloaded, decrypted and staged for restore;
- disconnect revoking the token at the stand-in and keeping the client.

**Not proven until the first real connection** — the stand-in is ours, not Google:

- that Google accepts the loopback redirect on the port the service picks for a **Desktop app**
  client, and that the consent page loads and returns to it;
- what the consent screen shows for this unbranded app, in Testing and In production;
- Google's real token and error bodies — in particular whether a revoked and an expired grant
  can be told apart by the description (Google may send "expired or revoked", which ولاء files
  as `REVOKED`; the remedy is the same);
- `about.get` returning the account's email under `drive.file` (Google's reference lists
  `drive.file` as sufficient);
- a real resumable upload, download and delete; the "Walaa Backups" folder being created;
- the 7-day Testing expiry arriving as `EXPIRED`, and a full Drive arriving as `QUOTA`;
- that a replacement PC, using the same project's client and the same account, sees the old
  copies.

**To prove them:** enter the Client ID and secret in Settings yourself and press «ربط حساب
Google» — signing in to Google is yours to do. From there each item above is a check on this
page: «اختبار الاتصال», «ارفع نسخة الآن», restoring a Drive copy (stage only), «فصل الحساب».
