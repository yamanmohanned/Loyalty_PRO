import { z } from 'zod';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  EVERY REJECTION, IN ARABIC, BY CONSTRUCTION — AND NAMING ITS FIELD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── The failure this closes ──────────────────────────────────────────────────
 *
 * A merchant filled in «إعداد المتجر لأول مرة», pressed the button, and was told
 * «البيانات المرسلة غير صحيحة». Not which field. Not what was wrong with it. Not what
 * to type instead. He was standing at a counter with the shop owner watching.
 *
 * Reproduced against the shipped service, every case answered the same sentence:
 *
 *   | what he typed                    | what the API knew                         |
 *   |----------------------------------|-------------------------------------------|
 *   | a branch code in Arabic          | «رمز الفرع: أحرف إنجليزية وأرقام وشرطة فقط» |
 *   | a branch code with a space       | the same                                   |
 *   | a username in Arabic             | «اسم المستخدم: أحرف إنجليزية وأرقام فقط»   |
 *   | an eight-character password      | «كلمة المرور: 10 أحرف على الأقل»           |
 *   | an empty owner name              | «اسم المالك مطلوب»                          |
 *
 * The precise sentence existed every time, in the `fields` array of the error
 * envelope, and every screen in the product rendered `message` and dropped `fields`.
 *
 * ── The second half of the same defect ───────────────────────────────────────
 *
 * Not every rule *has* an Arabic sentence. A schema author writes one for the rules
 * they are thinking about — `min(2, 'اسم الفرع مطلوب')` — and Zod supplies the rest
 * from its own English defaults. Swept across every schema in this package with the
 * values a person actually produces (nothing, an empty string, the wrong alphabet,
 * the wrong type), that came to **136 distinct English messages**, of which
 * «Required» alone covered 312 field positions.
 *
 * Fixing them one at a time fixes them until somebody adds the 137th. An error map is
 * the structural version: Zod resolves it at PARSE time, so it answers for every rule
 * in every schema — including ones not written yet — while any explicit message on a
 * rule still wins. `installArabicErrorMap()` runs on import of this package, so the
 * API, the dashboard and the Station all get it without opting in.
 *
 * `messages.test.ts` fails the build if any schema in this package can still produce a
 * Latin message. That is the guard: the rule is no longer "remember to write Arabic",
 * it is "you cannot ship English".
 */

/* ── What a field is CALLED, to a shop owner ────────────────────────────────── */

/**
 * The Arabic name of every field a merchant can be told about, keyed by the path Zod
 * and the API report.
 *
 * Necessary because the path is what crosses the wire. «branchCode مطلوب» is not an
 * Arabic sentence, and a red outline with no words beside it is only marginally
 * better than the generic message it replaced.
 *
 * Keyed on the LAST path segment as well as the full path, so `tiers.0.threshold`
 * resolves without an entry per index.
 */
export const FIELD_LABELS: Readonly<Record<string, string>> = Object.freeze({
  /* first run */
  merchantName: 'اسم المتجر',
  branchName: 'اسم الفرع',
  branchCode: 'رمز الفرع',
  ownerName: 'اسم المالك',
  username: 'اسم الدخول',
  password: 'كلمة المرور',
  passwordConfirm: 'تأكيد كلمة المرور',

  /* stations */
  type: 'نوع المحطة',
  deviceLabel: 'اسم الجهاز',
  // `code` is already declared under cards as «الرمز», which reads correctly for a
  // pairing code too. A second entry here would shadow or be shadowed depending on
  // order, which is a worse outcome than one label that fits both.

  /* customers */
  name: 'الاسم',
  phone: 'رقم الهاتف',
  category: 'الفئة',
  identifier: 'رقم البطاقة أو الهاتف',
  note: 'ملاحظة',

  /* money and invoices */
  amount: 'المبلغ',
  amountGross: 'المبلغ قبل الخصم',
  invoiceId: 'رقم الفاتورة',
  currency: 'العملة',
  occurredAt: 'وقت العملية',
  branchId: 'الفرع',
  customerId: 'الزبون',
  quantity: 'العدد',

  /* discounts */
  threshold: 'حد الإنفاق',
  thresholdAmount: 'حد الإنفاق',
  discountPct: 'نسبة الخصم',
  discountValue: 'قيمة الخصم',
  maxDiscountValue: 'أقصى قيمة للخصم',
  validityDays: 'مدة الصلاحية بالأيام',
  tiers: 'مستويات الخصم',
  mode: 'نوع الخصم',

  /* Google Drive — the OAuth client, as the Google Cloud console labels it */
  clientId: 'معرّف العميل (Client ID)',
  clientSecret: 'سرّ العميل (Client secret)',

  /* cards */
  code: 'الرمز',
  cardNumber: 'رقم البطاقة',
  batchId: 'الدفعة',
  from: 'من',
  to: 'إلى',
  reason: 'السبب',

  /* settings and backup */
  merchant: 'المتجر',
  timezone: 'المنطقة الزمنية',
  paperWidth: 'عرض ورق الطباعة',
  key: 'مفتاح التشفير',
  backupKey: 'مفتاح التشفير',
  apiUrl: 'عنوان الخادم',
  url: 'عنوان الخادم',
  port: 'المنفذ',

  /* discount settings */
  discountType: 'نوع الخصم',
  minRate: 'أقل نسبة خصم',
  maxRate: 'أعلى نسبة خصم',
  absoluteMaxDiscountValue: 'أقصى قيمة خصم بالدينار',
  settlementStrategy: 'طريقة التسوية',
  rules: 'قواعد الخصم',
  discountRate: 'نسبة الخصم',

  /* scanning and sync */
  barcodeToken: 'الرمز الممسوح',
  invoice: 'الفاتورة',
  deviceId: 'الجهاز',
  operations: 'العمليات',

  /* auth */
  refreshToken: 'رمز الجلسة',
  role: 'الصلاحية',
  id: 'المعرّف',
});

/**
 * The Arabic name of a field, or `null` when this path has none.
 *
 * `null` rather than the raw path: printing `sourceThresholdAmount` at a merchant is
 * the same class of mistake as printing a Windows path at him, and a message that
 * simply omits the field name is still readable. The missing entry belongs in the map
 * above, and `messages.test.ts` names the ones that are missing.
 */
export function fieldLabel(path: string): string | null {
  if (!path) return null;
  if (FIELD_LABELS[path]) return FIELD_LABELS[path];
  const last = path.split('.').filter((s) => !/^\d+$/.test(s)).pop();
  return last && FIELD_LABELS[last] ? FIELD_LABELS[last] : null;
}

/**
 * One field's rejection, as a whole Arabic sentence naming the field.
 *
 * «رمز الفرع: أحرف إنجليزية وأرقام وشرطة فقط» rather than a message the reader has to
 * pair with a red outline to interpret. Where the message already opens with the
 * field's name — several schemas write theirs that way — it is not repeated.
 */
export function describeFieldError(path: string, message: string): string {
  const label = fieldLabel(path);
  if (!label) return message;
  if (message.startsWith(label)) return message;
  return `${label}: ${message}`;
}

/**
 * One sentence for a whole rejection, naming what has to change.
 *
 * One bad field gets that field's own sentence, which is the overwhelming case and
 * the one worth being exact about. Several get a list of NAMES rather than a wall of
 * rules — the rules are already rendered under each field, and a paragraph in a red
 * panel is read as "something is wrong" and not as instructions.
 *
 * Lives here rather than in the API because both ends need it: the service builds the
 * envelope's `message` with it, and the dashboard builds the same sentence for a
 * rejection it caught client-side, so the merchant reads one wording either way.
 */
export function summarizeFieldErrors(
  issues: ReadonlyArray<{ path: string; message: string }>,
): string {
  if (issues.length === 0) return 'تعذّر قبول البيانات المُدخلة';
  const [only] = issues;
  if (issues.length === 1 && only) return describeFieldError(only.path, only.message);

  const named = [...new Set(issues.map((issue) => fieldLabel(issue.path)))].filter(
    (label): label is string => Boolean(label),
  );
  /*
    Every path was one this build has no Arabic name for. That is a gap in
    `FIELD_LABELS` — `messages.test.ts` names them — and not a reason to print
    `sourceThresholdAmount` at a shop owner.
  */
  if (named.length === 0) return 'تعذّر قبول البيانات المُدخلة — راجع الحقول المعلّمة بالأحمر';

  return `راجع هذه الحقول: ${named.join('، ')}`;
}

/* ── The error map ─────────────────────────────────────────────────────────── */

const TYPE_NAMES: Record<string, string> = {
  string: 'نص',
  number: 'رقم',
  boolean: 'نعم/لا',
  array: 'قائمة',
  object: 'مجموعة قيم',
  date: 'تاريخ',
  integer: 'رقم صحيح',
  null: 'قيمة فارغة',
  undefined: 'قيمة فارغة',
  nan: 'قيمة غير رقمية',
};

const typeName = (t: unknown): string =>
  typeof t === 'string' && TYPE_NAMES[t] ? TYPE_NAMES[t] : 'قيمة صالحة';

/** «حرف» / «حرفان» / «أحرف» — Arabic counts three ways, and 10 is not 2. */
function unit(count: number, one: string, two: string, few: string, many: string): string {
  if (count === 1) return one;
  if (count === 2) return two;
  if (count >= 3 && count <= 10) return `${count} ${few}`;
  return `${count} ${many}`;
}

const chars = (n: number) => unit(n, 'حرف واحد', 'حرفان', 'أحرف', 'حرفاً');
const items = (n: number) => unit(n, 'عنصر واحد', 'عنصران', 'عناصر', 'عنصراً');

/**
 * Arabic for every issue Zod can raise.
 *
 * Deliberately exhaustive over `ZodIssueCode` rather than a switch with a default:
 * the default is where the next English message would come from.
 */
export const arabicErrorMap: z.ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type: {
      if (issue.received === 'undefined' || issue.received === 'null') {
        return { message: 'هذا الحقل مطلوب' };
      }
      return { message: `القيمة يجب أن تكون ${typeName(issue.expected)}` };
    }

    case z.ZodIssueCode.invalid_literal:
      return { message: `القيمة المسموحة هي ${String(issue.expected)} فقط` };

    case z.ZodIssueCode.unrecognized_keys:
      /*
        A caller sent a field this endpoint does not accept — a client and a server
        out of step, never something the person at the counter typed. Naming the keys
        would print `merchantName, branchName` at a merchant, so the keys go to the
        log (the envelope still carries the path) and he gets a sentence about what
        to do.
      */
      return { message: 'النموذج المرسل لا يطابق ما يتوقعه البرنامج — حدّث البرنامج على هذا الجهاز' };

    case z.ZodIssueCode.invalid_union:
      return { message: 'القيمة غير صالحة' };

    case z.ZodIssueCode.invalid_union_discriminator:
      return { message: 'النوع المحدد غير معروف' };

    case z.ZodIssueCode.invalid_enum_value:
      return { message: 'اختر قيمة من القائمة' };

    case z.ZodIssueCode.invalid_arguments:
    case z.ZodIssueCode.invalid_return_type:
      return { message: 'القيمة غير صالحة' };

    case z.ZodIssueCode.invalid_date:
      return { message: 'التاريخ غير صالح' };

    case z.ZodIssueCode.invalid_string: {
      if (issue.validation === 'uuid') return { message: 'المعرّف غير صالح' };
      if (issue.validation === 'email') return { message: 'البريد الإلكتروني غير صالح' };
      if (issue.validation === 'url') return { message: 'العنوان غير صالح' };
      if (issue.validation === 'datetime') return { message: 'التاريخ والوقت غير صالحين' };
      if (typeof issue.validation === 'object' && 'startsWith' in issue.validation) {
        return { message: `يجب أن يبدأ بـ «${issue.validation.startsWith}»` };
      }
      if (typeof issue.validation === 'object' && 'endsWith' in issue.validation) {
        return { message: `يجب أن ينتهي بـ «${issue.validation.endsWith}»` };
      }
      if (typeof issue.validation === 'object' && 'includes' in issue.validation) {
        return { message: `يجب أن يحتوي على «${issue.validation.includes}»` };
      }
      return { message: 'الصيغة غير صحيحة' };
    }

    case z.ZodIssueCode.too_small: {
      const min = Number(issue.minimum);
      if (issue.type === 'string') {
        if (min <= 1) return { message: 'هذا الحقل مطلوب' };
        return { message: `أدخل ${chars(min)} على الأقل` };
      }
      if (issue.type === 'array') {
        if (min <= 1) return { message: 'أضف عنصراً واحداً على الأقل' };
        return { message: `أضف ${items(min)} على الأقل` };
      }
      if (issue.type === 'number' || issue.type === 'bigint') {
        return {
          message: issue.inclusive
            ? `القيمة يجب ألا تقل عن ${min}`
            : `القيمة يجب أن تزيد عن ${min}`,
        };
      }
      return { message: 'القيمة أصغر من المسموح' };
    }

    case z.ZodIssueCode.too_big: {
      const max = Number(issue.maximum);
      if (issue.type === 'string') return { message: `الحد الأقصى ${chars(max)}` };
      if (issue.type === 'array') return { message: `الحد الأقصى ${items(max)}` };
      if (issue.type === 'number' || issue.type === 'bigint') {
        return {
          message: issue.inclusive
            ? `القيمة يجب ألا تزيد عن ${max}`
            : `القيمة يجب أن تقل عن ${max}`,
        };
      }
      return { message: 'القيمة أكبر من المسموح' };
    }

    case z.ZodIssueCode.not_multiple_of:
      return { message: `القيمة يجب أن تكون من مضاعفات ${String(issue.multipleOf)}` };

    case z.ZodIssueCode.not_finite:
      return { message: 'القيمة يجب أن تكون رقماً محدداً' };

    case z.ZodIssueCode.custom:
      /*
        A `.refine()` with no message of its own. The default is «Invalid input»; this
        is the same statement in the reader's language. A refine that has something
        specific to say still says it — its own message wins over the map.
      */
      return { message: 'القيمة غير صالحة' };

    default: {
      /*
        Unreachable while `ZodIssueCode` is what it is today, and deliberately not a
        pass-through to `ctx.defaultError` — that is the line through which a Zod
        upgrade adding a new issue code would put English back on a merchant's
        screen. A vague Arabic sentence is a worse message and a better failure.
      */
      void ctx;
      return { message: 'القيمة غير صالحة' };
    }
  }
};

let installed = false;

/**
 * Installs the map globally, once.
 *
 * Called from this package's entry point, so importing `@loyalty-pro/shared-types` anywhere
 * is what turns it on. There is no opt-in to forget: the API, the dashboard, the
 * Station and the Print Capture Agent all import this package to get their schemas,
 * and the schemas are useless without it.
 */
export function installArabicErrorMap(): void {
  if (installed) return;
  installed = true;
  z.setErrorMap(arabicErrorMap);
}
