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

    /**
     * A blank pre-printed card (§12.25). Different from an unknown number, and the
     * difference matters: this is a real card in the operator's hand, so registration
     * binds THIS card instead of minting a fresh one and wasting it.
     */
    blankCard: 'بطاقة جديدة غير مُسلَّمة',
    blankCardHint: (serial: string) => `بطاقة رقم ${serial} — سجّل الزبون لتسليمها له`,
    registerOnCard: 'تسجيل زبون على هذه البطاقة',

    /**
     * A card that exists and cannot be used. One honest sentence per state — never a
     * shared "error", because an operator who is not told which state will retry, and
     * retrying is the one thing that cannot help.
     */
    cardLost: 'هذه البطاقة مُبلَّغ عنها كمفقودة',
    cardLostHint: 'إن كان الزبون قد وجدها، استعدها من شاشة البحث — أو أصدر بطاقة بديلة',
    cardReplaced: 'هذه البطاقة استُبدلت ببطاقة أخرى',
    cardReplacedHint: (serial: string) => `البطاقة الحالية للزبون هي رقم ${serial}`,
    cardReplacedNoSerial: 'الزبون يملك بطاقة أحدث — اطلب منه البطاقة الجديدة',
    cardVoid: 'هذه البطاقة متلَفة ولا تُستخدم',
    cardVoidHint: 'استخدم بطاقة أخرى من الدفعة',
    inactiveCustomer: 'حساب الزبون موقوف',
    inactiveCustomerHint: 'راجع الإدارة',
    findCustomer: 'بحث عن الزبون',

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
    submit: 'تسجيل وتسليم البطاقة',
    submitThermal: 'تسجيل وطباعة بطاقة ورقية',
    submitting: 'جاري التسجيل…',
    cancel: 'إلغاء',
    done: 'تم التسجيل',
    printCard: 'طباعة البطاقة',
    duplicate: 'رقم الهاتف مسجّل مسبقاً — ابحث عنه لإعادة طباعة البطاقة',

    /* ── The card being handed over (§12.25) ─────────────────────────────── */

    /**
     * Scanned, never typed. Transcription error on this one field would bind this
     * customer's details to a card in somebody else's pocket — and scanning is faster
     * besides, which matters with a queue.
     */
    cardLabel: 'امسح البطاقة التي ستسلّمها',
    cardPlaceholder: 'امسح البطاقة…',
    cardScanned: (serial: string) => `بطاقة رقم ${serial} — جاهزة للتسليم`,
    cardScannedNoSerial: 'بطاقة جاهزة للتسليم',
    cardClear: 'مسح',
    /** The fallback: no blank to hand, so nobody is turned away (§6.3). */
    noCard: 'لا توجد بطاقة جاهزة؟',
    noCardAction: 'اطبع بطاقة ورقية بدلاً منها',
    withCardAction: 'العودة لمسح بطاقة جاهزة',
    handOver: 'سلّم البطاقة للزبون',
    handOverHint: 'البطاقة مطبوعة مسبقاً — لا حاجة لطباعة شيء',
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

    /* ── Card lifecycle (§12.25) ─────────────────────────────────────────── */

    serial: 'رقم البطاقة المطبوع',
    noActiveCard: 'لا توجد بطاقة فعّالة لهذا الزبون',
    noActiveCardHint: 'أصدر بطاقة بديلة ليتمكن الزبون من الاستخدام',
    reportLost: 'الإبلاغ عن فقدان البطاقة',
    reportLostConfirm: 'سيتم رفض هذه البطاقة عند أي مسح بعد الآن. متابعة؟',
    reportedLost: 'تم الإبلاغ — البطاقة مرفوضة الآن',
    restore: 'استعادة البطاقة (وجدها الزبون)',
    restoreReason: 'وجدها الزبون',
    restored: 'تمت استعادة البطاقة',
    replace: 'إصدار بطاقة بديلة',
    /** The primary path: a durable card the customer keeps (§12.25). */
    replaceScan: 'امسح البطاقة الجديدة',
    replaceScanHint: 'امسح البطاقة الجاهزة التي ستسلّمها للزبون',
    replaceDone: 'تم إصدار البطاقة البديلة — البطاقة القديمة مرفوضة الآن',
    /** The fallback that keeps §6.3's promise when the stock drawer is empty. */
    replaceThermal: 'لا توجد بطاقة جاهزة — اطبع بطاقة ورقية',
    replaceThermalHint: 'يخرج الزبون ببطاقة تعمل فوراً، ويحتفظ بكامل رصيده وسجلّه',
    historyTitle: 'بطاقات الزبون',
    statusLabel: {
      PRINTED: 'غير مُسلَّمة',
      ASSIGNED: 'فعّالة',
      LOST: 'مفقودة',
      REPLACED: 'مستبدَلة',
      VOID: 'متلَفة',
    } as const,
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

  /**
   * A write that reached the server and was NOT stored (CLAUDE_v3.md §12.16).
   *
   * Deliberately not folded into `errors`. This is not a message about a request —
   * it is a message about a sale that did not get recorded, and it has to say three
   * things a generic error never says: what did not happen, that waiting will not
   * fix it, and what the operator must do now. The offline copy above promises the
   * opposite ("it will be counted when the connection returns"), so these two must
   * never be confusable.
   */
  notSaved: {
    title: 'لم تُحفظ العملية',
    detail: 'وصل الطلب إلى الخادم ولم يُسجَّل. لم تُحتسب المشتريات ولن تُحتسب لاحقاً.',
    instruction: 'أبلغ الإدارة فوراً — المشكلة في الخادم وليست في هذا الجهاز.',
    /** Shown when the server named storage as the cause: actionable for the manager. */
    storageHint: 'الخادم غير قادر على الحفظ — تحقّق من المساحة الفارغة على قرص جهاز الإدارة.',
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
