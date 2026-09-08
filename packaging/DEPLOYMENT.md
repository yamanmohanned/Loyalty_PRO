# Deploying ولاء in a shop

For the person installing it. Every command and path here was executed as written
during verification; anything that was not is marked **NOT VERIFIED**.

The merchant's own one-page sheet is `اقرأني.md` — give him that, not this.

---

## 1. What goes where

Three machines, and only one of them is a server.

| Machine | Runs | Needs a fixed address |
|---|---|---|
| **Manager PC** (back office) | The Walaa service + the manager dashboard | **Yes** |
| **Tablet at the till** | A browser, pointed at the manager PC | No |
| **Cashier PC** (optional) | The Print Capture Agent, or a browser | No |

The manager PC is the whole system. The tablet and the cashier PC hold nothing: if
either dies, replace it and carry on. If the manager PC dies you restore from a backup —
which is why §6 below is not optional.

---

## 2. Give the manager PC a static address

Do this **before** installing, because the tablet is going to be told this address and
nobody wants to retype it on a Tuesday when the router hands out a different one.

Either reserve the address on the router by MAC (preferred — nothing to configure on the
PC), or set it on the PC:

```
Settings → Network & Internet → Ethernet → IP assignment → Edit → Manual
```

Write it down. Everything below calls it `<MANAGER-IP>`, e.g. `192.168.0.106`.

Confirm it survives a reboot before continuing.

---

## 3. Install

Run the installer **as Administrator**. It needs elevation once, to register the
Windows Service and add the firewall rule; nothing after that does.

The installer:

- copies the program and its runtime into `C:\Program Files\Walaa`
- creates `C:\ProgramData\Walaa` and locks it to SYSTEM and Administrators — the
  database in it holds every customer's phone number
- generates this installation's own secrets into `walaa.env` (no two shops share a
  signing key)
- **copies the pre-migrated database** and verifies it. A merchant's machine never runs
  a database migration
- registers `WalaaApi` with the Service Control Manager, set to start automatically
- opens **inbound TCP 4000 on private and domain networks only**

If the machine's network is classified **Public**, the firewall rule will not match and
the tablet cannot connect. Change it:

```
Settings → Network & Internet → Ethernet → Network profile type → Private
```

---

## 4. First launch

Open **ولاء** from the Start menu.

1. It shows «جارٍ تشغيل البرنامج» for a few seconds while SQLite opens. This is normal
   on a cold start and is not an error.
2. The login screen asks for a username and a password. **There is nothing else on it** —
   no address, no port, no server button. The manager PC finds its own service.
3. Sign in with the owner account.
4. The **key ceremony** appears and cannot be skipped. Write the key on paper, put it
   somewhere that is not this building, and type it back.

   This is the one irreversible step. Backups are encrypted with that key. Lose it and
   every archive the shop ever writes is unopenable — by you, by me, by anyone.

---

## 5. Point the till at the manager PC

On the tablet's browser:

```
http://<MANAGER-IP>:4000
```

Bookmark it and put the bookmark on the home screen. Sign in with the `station`
account.

The address is also shown in the dashboard under **الإعدادات → خادم هذا الجهاز**, so
nobody has to remember where it came from.

If it does not load, work through §9 in order — the answer is almost always the
firewall profile or the address.

---

## 6. Prove the backup before you leave

**An untested backup is not a backup.** Do this on the day, not later.

1. **الإعدادات → النسخ الاحتياطي** → «نسخ احتياطي الآن». It should report success and a
   size.
2. Press «اختبار الاستعادة». This takes a real archive, decrypts it, restores it to a
   scratch file and reports what it found — customers, invoices, vouchers. If those
   numbers look like the shop, the backup is real.
3. Copy the newest `.walaabk` from `C:\ProgramData\Walaa\backups` onto a USB stick and
   take it away with you. Along with the key from §4, that is a complete recovery.

Backups run daily at 23:30 and after every 500 transactions.

---

## 7. Power and shutdown

The service starts with Windows and needs no one to log in. Closing the dashboard window
does not stop it — the till keeps working with nobody at the back-office desk.

**A power cut is survivable and was tested by cutting power to the process mid-sale,
mid-redemption, mid-backup and mid-restore.** In every case the database opened cleanly
afterwards with no half-recorded sale. What is lost is at most the one sale in flight at
the instant the power went — the cashier reprints the receipt and scans it again.

A UPS on the manager PC alone is worth its price. It does not need to keep the shop
trading; it needs to let one write finish.

**Never** pull the manager PC's power to shut it down while the shop is trading. Use
Start → Shut down, which lets the service close its database properly.

---

## 8. First-day checklist

Work down it. Every line was performed during verification.

- [ ] Manager PC has a static address that survived a reboot
- [ ] Network profile is **Private**, not Public
- [ ] Installer run as Administrator, finished without an error dialog
- [ ] `services.msc` shows **WalaaApi** — Running, Automatic
- [ ] Dashboard opens and the login screen shows **only** a username and a password
- [ ] Owner can sign in
- [ ] Key ceremony completed, key written down and taken **off site**
- [ ] Tablet reaches `http://<MANAGER-IP>:4000` and the station account signs in
- [ ] Discount rules match what the merchant actually agreed to
- [ ] Smoke test below passes end to end
- [ ] Backup taken, restore test passed, one archive copied to a USB stick
- [ ] Manager PC rebooted; service came back on its own; dashboard and tablet both work
- [ ] Merchant has `اقرأني.md` and knows the two things he must never do

---

## 9. The smoke test — one real sale, whole chain

Do this with the merchant watching, using a real customer and a real receipt.

1. **Register a customer** on the tablet. Phone number, name. A card prints or is
   assigned.
2. **Ring up a real sale** on the shop's own register, over the discount threshold.
3. **Capture the invoice** — the agent picks it up, or enter it by hand.
4. **Scan the customer's card** on the tablet, then the invoice.
5. The slip prints with the discount. **Read the number on it aloud** and check it
   against what the rules say it should be.
6. **Redeem the slip** at the till. It must be accepted **once**; a second attempt must
   be refused with «تم استخدام هذه القسيمة مسبقاً». Try it twice on purpose.
7. On the dashboard, open that customer. The invoice must be in **فواتير هذا الزبون**
   with the right amounts and the slip marked «مستخدمة».
8. **نسخ احتياطي الآن**, then «اختبار الاستعادة». The counts must include the sale you
   just made.

If all eight hold, the chain works: capture → identify → link → discount → settle →
report → recover.

---

## 10. When something goes wrong

Keyed to the Arabic the merchant will actually read on screen. He sees a sentence; the
detail is in `C:\ProgramData\Walaa\logs\` (readable by whoever is logged in — you do not
need Administrator to read the logs).

| What he sees | What it means | What to do |
|---|---|---|
| «جارٍ تشغيل البرنامج» for more than a minute | The service is not coming up | `services.msc` → WalaaApi → Start. Then read `logs\api.log` |
| «لم يُعثر على خادم ولاء» | The dashboard found no service on this machine and none configured | If this is the manager PC: restart it. If it is a second PC: **الإعدادات → الاتصال بجهاز مدير آخر** |
| «تعذّر تشغيل الخدمة: … إعدادات البرنامج ناقصة» | `walaa.env` is missing or damaged | Reinstall from the full installer. The installer writes that file; do not hand-edit it |
| «بنية قاعدة البيانات … لا تطابق هذه النسخة» | The database is not from this build | **Do not delete anything.** Restore the newest backup, or call me |
| «نسخة البرنامج المثبّتة غير مكتملة» | A packaging fault, **not his data** | His database is untouched. Reinstall from the full installer. Never restore a backup for this |
| «تحديثات بنية قاعدة البيانات لم تكتمل» | The machine stopped during an upgrade | Restore the newest backup. Do not delete files |
| «تم استخدام هذه القسيمة مسبقاً» | Correct behaviour — the slip was already redeemed | Nothing. This is the protection working |
| «عدد كبير من المحاولات» | Too many login attempts | Wait a minute. If it repeats without cause, tell me — someone may be guessing passwords |
| «النسخ الاحتياطي متوقف: لم يتم تأكيد حفظ مفتاح التشفير» | The key ceremony was never completed | Finish it in **النسخ الاحتياطي**. No backup runs until it is done |
| «تعذّر الاتصال بالخادم» on the tablet | Network, not data | Check Wi-Fi, then the firewall profile is Private, then that the address matches §5 |
| Tablet shows nothing at all | Firewall or address | From the tablet's browser try `http://<MANAGER-IP>:4000/health`. It should answer JSON |

**What to send me when it is none of these:** the whole of
`C:\ProgramData\Walaa\logs\` — `api.log`, `service.log`, `status.json` and
`startup-error.json` if present — plus the version from the bottom of the dashboard's
navigation rail.

---

## 11. Updating a shop that already has data

1. Take a backup and copy it off the machine. Do not skip this.
2. Run the new installer over the top. It stops the service, replaces the program, and
   restarts it.
3. The service verifies the database against the new build at startup. If it refuses,
   the message says whether it is the data or the build — see §10.
4. Sign in and check the customer count against what it was before.

**NOT VERIFIED:** an in-place upgrade from a build older than 0.2.0 carrying real
merchant data. There is no such installation yet; the upgrade path was exercised with
0.2.0 data only.
