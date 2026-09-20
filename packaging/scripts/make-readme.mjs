#!/usr/bin/env node
/**
 * Generates the merchant readme from values a build actually verified.
 *
 * ── Why the readme is generated and not written ──────────────────────────────
 *
 * `اقرأني.md` told a merchant to log in with `owner` / `walaa2026`. Both strings were
 * correct, but nobody had executed that login, and when it failed he had no way to know
 * whether the instruction or the software was wrong. He spent an evening on it.
 *
 * The credentials block, the version and the installer filename now come from
 * `apps/api/prisma/demo-credentials.json`, which is written by `assert-demo-login.ts`
 * only after it has performed a real `login()` for every account. A credential that
 * the build could not use cannot appear in the instructions, because the build stops
 * before this script runs.
 *
 * Everything a reader is told to DO is either generated from a verified value or has
 * been executed as written. Prose that cannot be verified — what the screens are for,
 * what to expect — stays in the template below.
 *
 *   node packaging/scripts/make-readme.mjs
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

const CREDENTIALS = join(REPO, 'apps', 'api', 'prisma', 'demo-credentials.json');
const OUT_DIR = join(REPO, 'dist-demo');
const OUT = join(OUT_DIR, 'اقرأني.md');

if (!existsSync(CREDENTIALS)) {
  console.error('');
  console.error('  ERROR: demo-credentials.json does not exist.');
  console.error('         The readme is generated from credentials a build has verified.');
  console.error('         Run `pnpm --filter @loyalty-pro/api db:assert:login` first.');
  console.error('');
  process.exit(1);
}

const verified = JSON.parse(readFileSync(CREDENTIALS, 'utf8'));
const version = JSON.parse(
  readFileSync(join(REPO, 'apps', 'manager-desktop', 'package.json'), 'utf8'),
).version;

const published = verified.accounts.filter((a) => a.publish);
if (published.length === 0) {
  console.error('  ERROR: no publishable account in demo-credentials.json');
  process.exit(1);
}

const primary = published[0];
const installer = `ولاء_${version}_x64-setup.exe`;

const credentialRows = published
  .map((a) => `| \`${a.username}\` | \`${a.password}\` | ${a.description} |`)
  .join('\n');

const body = `# برنامج ولاء — النسخة التجريبية

مرحباً أبو أحمد،

هذا هو **برنامج الولاء الخاص بمتجرك** في نسخته التجريبية. حمّله وشغّله وتصفّحه على راحتك.

---

## كيف تثبّته

1. انقر نقرتين على الملف: **\`${installer}\`**

2. ستظهر لك شاشة زرقاء مكتوب عليها **«Windows protected your PC»**:

   > هذه الرسالة تظهر لأي برنامج جديد لم يشترِ بعد شهادة توقيع من مايكروسوفت، ولا علاقة لها بوجود خطأ أو فيروس.
   >
   > اضغط **\`More info\`** ثم **\`Run anyway\`**، وسيكمل التثبيت عادياً.

3. اتبع خطوات التثبيت.
   **لن يطلب منك البرنامج صلاحيات المدير** — يُثبَّت لحسابك أنت فقط.

4. ستجد أيقونة **ولاء** في قائمة ابدأ وعلى سطح المكتب. انقر نقرتين لتشغيله.

---

## كيف تدخل

| اسم المستخدم | كلمة المرور | الحساب |
|---|---|---|
${credentialRows}

اكتبهما بالحروف **الإنجليزية**. إذا كانت لوحة المفاتيح على العربية فبدّلها بـ \`Alt\`+\`Shift\`
قبل الكتابة — وإلّا فما تكتبه ليس ما تظنّه، وحقل كلمة المرور يعرض نقاطاً فلا تلاحظ ذلك.

الحروف الكبيرة والصغيرة **لا تهمّ** في اسم المستخدم.

---

## أول مرة تفتح البرنامج

**أعطه بضع ثوانٍ.** في أول تشغيل يجهّز البرنامج قاعدة بياناته، وقد تبقى النافذة تقول
«جارٍ تشغيل البرنامج» لوهلة. هذا طبيعي. وإذا تعذّر التشغيل لأي سبب، فسيقول لك **السبب
والحل** على الشاشة نفسها.

بعد الدخول ستمرّ **مرّة واحدة فقط** بخطوة **مفتاح تشفير النسخ الاحتياطي**: يعرض لك
البرنامج مفتاحاً، تكتبه على ورقة، ثم تعيد كتابته للتأكيد.

> في النسخة التجريبية هذه الخطوة للتجربة فقط — البيانات وهمية ولا يضرّك فقدان المفتاح.
> لكن في متجرك الحقيقي **هذا المفتاح هو الشيء الوحيد الذي يفتح نسخك الاحتياطية**، ولا
> يمكن لأحد استخراجه لك إذا ضاع. لذلك جرّب الخطوة الآن لتعرفها.

---

## ما الذي تراه

كل الأرقام والأسماء في هذا البرنامج **بيانات تجريبية** — متجر افتراضي بستة أشهر من
المبيعات، لتشاهد شكل البرنامج وهو يعمل. ليست بيانات متجرك، والبرنامج **لا يتصل
بالإنترنت ولا بأي جهاز آخر**؛ كل شيء يعمل داخل جهازك.

ستجد في القائمة على اليمين:

- **نظرة عامة** — ملخّص المبيعات والزبائن ونسبة الارتباط بالبرنامج
- **الزبائن** — قائمة الزبائن المسجّلين وسجل مشتريات كل واحد
- **قواعد الخصم** — هنا تحدّد أنت: كم يجب أن تبلغ الفاتورة، وكم يكون الخصم عليها
- **التقارير** — أداء البرنامج، وتسوية القسائم في نهاية اليوم
- **التقاط الفواتير** — كيف يقرأ النظام فواتير الصندوق (يحتاج التركيب في المتجر)
- **بطاقات الولاء** — دفعات البطاقات المطبوعة وما تبقّى منها
- **النسخ الاحتياطي** — حفظ نسخة من بياناتك
- **الوحدات** — تشغيل أو إيقاف الأجزاء الاختيارية

---

## جرّب كل شيء بلا خوف

**لا يمكنك أن تُتلف شيئاً.** غيّر قواعد الخصم، احذف، عدّل، اضغط كل زر.

وإذا أردت أن تعود البيانات كما كانت في البداية:
**النسخ الاحتياطي ← إعادة تعيين البيانات التجريبية** (تستغرق نصف دقيقة).

---

## أشياء لا تعمل في هذه النسخة — وهذا طبيعي

هذه الأجزاء تحتاج أجهزة في المتجر (جهاز الصندوق، الطابعة، قارئ الباركود)، ولن تعمل
على جهاز اللابتوب. سترى مكانها رسالة هادئة تقول «غير متاح في النسخة التجريبية»:

- التقاط الفواتير من الصندوق تلقائياً
- طباعة قسائم الخصم
- مسح بطاقات الزبائن

كلها تعمل تلقائياً بعد التركيب في المتجر.

---

## إذا بدا أن البرنامج لا يفتح

أغلق النافذة وافتحها من جديد. إذا تكرّر الأمر، فالشاشة نفسها ستعرض سبب التوقّف
مكتوباً بالعربية — **صوّرها بهاتفك وأرسلها لي**، فهي تكفيني لأعرف المشكلة.

---

## التحديثات

البرنامج يتحقّق من وجود تحديث عند تشغيله، وينزّله في الخلفية. عندما يجهز سيظهر لك
سطر صغير يقول إن هناك تحديثاً جاهزاً — أعد تشغيل البرنامج ليُطبَّق.

---

## إذا واجهتك مشكلة

رقم هذا الإصدار: **\`${version}\`**. أخبرني به عند الاتصال.

<!--
  مولَّد آلياً — لا تُحرّره بيدك.
  Generated by packaging/scripts/make-readme.mjs from credentials that
  assert-demo-login.ts verified by performing a real login.
    verified at : ${verified.verifiedAt}
    seed id     : ${verified.seedId}
    accounts    : ${verified.accounts.map((a) => a.username).join(', ')}
-->
`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, body, 'utf8');

console.log(`  merchant readme: ${OUT}`);
console.log(`    version    ${version}`);
console.log(`    installer  ${installer}`);
console.log(`    published  ${published.map((a) => a.username).join(', ')}`);
console.log(`    verified   ${verified.verifiedAt}`);
console.log(`    primary    ${primary.username} / ${primary.password}`);
