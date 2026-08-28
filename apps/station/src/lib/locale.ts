/**
 * Every string the station shows, in one file (CLAUDE.md §9).
 *
 * Copy scattered through JSX cannot be reviewed as copy, and this app's copy carries
 * real weight: §6.2 #3 requires that a customer who has not yet earned a discount is
 * shown *progress*, never rejection. The difference between "لا يوجد خصم" and
 * "تبقّى 12,000 د.ع للحصول على خصم 2٪" is the difference between a loyalty programme
 * and a rebuff, and it is a one-word edit away at all times.
 *
 * The operator's own language is deliberately plain and short: this UI has to be
 * learnable in two minutes by someone whose job is not using software (§6.4).
 */

export const locale = {
  app: {
    name: 'ولاء',
    station: 'محطة الولاء',
  },

  setup: {
    title: 'إعداد المحطة',
    subtitle: 'أدخل عنوان خادم ولاء على شبكة المتجر',
    urlLabel: 'عنوان الخادم',
    urlHint: 'مثال: http://192.168.0.106:4000',
    submit: 'اتصال',
    testing: 'جاري الاتصال…',
    change: 'تغيير عنوان الخادم',
  },

  login: {
    title: 'تسجيل الدخول',
    subtitle: 'حساب مشغّل المحطة',
    username: 'اسم المستخدم',
    password: 'كلمة المرور',
    submit: 'دخول',
    submitting: 'جاري الدخول…',
    failed: 'اسم المستخدم أو كلمة المرور غير صحيحة',
    notStation: 'هذا الحساب لا يملك صلاحية تشغيل المحطة',
  },

  scan: {
    /** The one instruction on the main screen. */
    prompt: 'امسح بطاقة الزبون',
    hint: 'أو اكتب رقم البطاقة أو رقم الهاتف واضغط Enter',
    working: 'جاري المعالجة…',
    placeholder: 'رقم البطاقة',
    again: 'مسح بطاقة أخرى',
    offline: 'غير متصل — سيُرسل عند عودة الاتصال',
  },

  outcome: {
    qualified: 'استحق الخصم',
    slipPrinted: 'تمت طباعة قسيمة الخصم',
    printSlip: 'طباعة القسيمة',
    before: 'قبل الخصم',
    discount: 'الخصم',
    after: 'بعد الخصم',
    voucher: 'رقم القسيمة',
    handToCashier: 'سلّم القسيمة إلى الكاشير',

    notQualified: 'لم يصل إلى الخصم بعد',
    /** Progress, never rejection (§6.2 #3). */
    progress: (remaining: string, reward: string) => `تبقّى ${remaining} للحصول على خصم ${reward}`,
    progressNoRule: 'شكراً لتسوّقك معنا',
    currentTotal: 'إجمالي مشترياتك هذه الفترة',

    unknownCard: 'بطاقة غير معروفة',
    unknownCardHint: 'هذه البطاقة غير مسجّلة — سجّل الزبون الآن',
    register: 'تسجيل زبون جديد',

    noInvoice: 'لا توجد فاتورة بانتظار الربط',
    noInvoiceHint: 'اطلب من الكاشير طباعة الفاتورة أولاً، ثم امسح البطاقة',
  },

  register: {
    title: 'تسجيل زبون جديد',
    /** Name and phone only — every extra field costs enrolment (§6.2 #4). */
    name: 'الاسم',
    namePlaceholder: 'الاسم الكامل',
    phone: 'رقم الهاتف',
    phonePlaceholder: '07XX XXX XXXX',
    submit: 'تسجيل وطباعة البطاقة',
    submitting: 'جاري التسجيل…',
    cancel: 'إلغاء',
    done: 'تم التسجيل',
    printCard: 'طباعة البطاقة',
    duplicate: 'رقم الهاتف مسجّل مسبقاً — ابحث عنه لإعادة طباعة البطاقة',
  },

  reprint: {
    title: 'بحث وإعادة طباعة بطاقة',
    subtitle: 'ابحث برقم البطاقة أو رقم الهاتف أو الاسم',
    queryLabel: 'بحث عن زبون',
    queryPlaceholder: 'رقم الهاتف أو الاسم',
    search: 'بحث',
    searching: 'جاري البحث…',
    noMatches: 'لا توجد نتائج',
    truncated: 'هناك نتائج أخرى — أضف حروفاً للبحث',
    registeredOn: 'مسجّل منذ',
    reprint: 'إعادة طباعة البطاقة',
    /** The card keeps its number forever (§6.2 #5). */
    sameNumber: 'نفس رقم البطاقة — لا يفقد الزبون سجلّه',
  },

  card: {
    title: 'بطاقة الولاء',
    holder: 'حامل البطاقة',
    number: 'رقم البطاقة',
    keepSafe: 'احتفظ بهذه البطاقة وأبرزها عند كل عملية شراء',
  },

  slip: {
    title: 'قسيمة خصم',
    invoice: 'رقم الفاتورة',
    customer: 'الزبون',
    issuedAt: 'التاريخ',
    voucher: 'رقم القسيمة',
  },

  connection: {
    online: 'متصل',
    syncing: 'قيد المزامنة',
    offline: 'غير متصل',
    queued: (count: number) => `${count} بانتظار الإرسال`,
  },

  actions: {
    retry: 'إعادة المحاولة',
    close: 'إغلاق',
    back: 'رجوع',
    print: 'طباعة',
    logout: 'خروج',
  },

  errors: {
    network: 'تعذّر الوصول إلى الخادم',
    unexpected: 'حدث خطأ غير متوقّع',
    sessionExpired: 'انتهت الجلسة — سجّل الدخول مرة أخرى',
  },
} as const;

/** IQD, grouped, with the unit a cashier reads: `85,000 د.ع`. */
export function money(amount: number): string {
  return `${amount.toLocaleString('en-US')} د.ع`;
}

/** A percentage or a fixed amount, however the rule was configured. */
export function discountLabel(type: string, rate: number): string {
  return type === 'PERCENTAGE' ? `${rate}٪` : money(rate);
}
