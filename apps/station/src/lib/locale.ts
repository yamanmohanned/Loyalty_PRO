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
    name: 'Customer loyalty',
    station: 'محطة الولاء',
  },

  setup: {
    title: 'إعداد المحطة',
    subtitle: 'أدخل عنوان خادم ولاء على شبكة المتجر',
    /* The operator is standing at a till, not reading documentation (§9: copy lives
       here, not in JSX). */
    askManager: 'اسأل مدير المتجر عن عنوان جهاز الإدارة على الشبكة.',
    urlLabel: 'عنوان الخادم',
    urlHint: 'مثال: http://192.168.0.106:4000',
    submit: 'اتصال',
    testing: 'جاري الاتصال…',
    change: 'تغيير عنوان الخادم',
  },

  login: {
    /* ── V4-4 ─────────────────────────────────────────────────────────── */
    tagline: 'امسح بطاقة الزبون ثم الفاتورة — واطبع قسيمة الخصم في ثوانٍ.',
    greeting: 'تسجيل دخول المحطة',
    title: 'تسجيل الدخول',
    subtitle: 'حساب مشغّل المحطة',
    username: 'اسم المستخدم',
    password: 'كلمة المرور',
    submit: 'دخول',
    submitting: 'جاري الدخول…',
    failed: 'اسم المستخدم أو كلمة المرور غير صحيحة',
    notStation: 'هذا الحساب لا يملك صلاحية تشغيل المحطة',
    /* ── V4-4: the reference's strip, carrying what this appliance does ──── */
    stripScan: 'مسح البطاقة والفاتورة',
    stripPrint: 'طباعة القسيمة',
    stripOffline: 'يعمل دون اتصال',
    or: 'أو',
  },

  scan: {
    /** The one instruction on the main screen. */
    prompt: 'امسح بطاقة الزبون',
    hint: 'أو اكتب رقم البطاقة أو رقم الهاتف واضغط Enter',
    working: 'جاري المعالجة…',
    placeholder: 'رقم البطاقة',
    again: 'زبون جديد',
    offline: 'غير متصل — سيُرسل عند عودة الاتصال',
  },

  /**
   * The guided two-step flow (CLAUDE.md §0 rule 1, §1.2).
   *
   * **Card first, invoice second, always.** The order is not a preference: an invoice
   * scanned before a customer is an unowned pending invoice waiting for someone to
   * claim it, which is the mis-attribution this design exists to prevent. The step
   * numbers are on screen so that an operator who is interrupted mid-customer can see
   * where they were without guessing.
   *
   * Every state below names the next action. An operator who has to work out what to
   * do next does it slowly, and does it differently each time.
   */
  flow: {
    stepOf: (step: number, total: number) => `الخطوة ${step} من ${total}`,

    /* Step 1 — identity. */
    cardTitle: 'امسح بطاقة الزبون',
    cardHint: 'أو اكتب رقم البطاقة واضغط Enter',
    cardStepName: 'بطاقة الزبون',
    cardWaiting: 'ابدأ بالبطاقة — قبل الفاتورة',
    identifying: 'جاري التعرّف على الزبون…',

    /* Step 2 — the invoice. */
    invoiceTitle: 'امسح الفاتورة',
    invoiceHint: 'امسح الباركود المطبوع على الفاتورة',
    invoiceStepName: 'الفاتورة',
    invoicePlaceholder: 'رقم الفاتورة',
    invoiceWorking: 'جاري ربط الفاتورة…',
    /** Shown when the scanned symbol matched no known receipt format (§13.6). */
    invoiceUnreadable: 'تعذّرت قراءة الباركود — اكتب رقم الفاتورة يدوياً',

    /* Who we are linking to — visible at every moment of step 2. */
    linkingTo: 'الفاتورة ستُربط بـ',
    /**
     * Label and number are separate strings on purpose.
     *
     * As one interpolated string — `بطاقة ••••1234` — the bidi algorithm resolved the
     * mask and the digits as one neutral-then-number run inside an Arabic line and
     * the reader saw `1234••••`: the mask on the wrong side, which is §12.27's exact
     * failure. The component pairs them with a `<bdi>` around the number so its
     * internal order is fixed no matter what surrounds it.
     */
    cardLabel: 'بطاقة',
    cardTail: (tail: string) => `••••${tail}`,
    changeCustomer: 'تغيير الزبون',
    lifetimeTotal: 'إجمالي مشترياته معنا',

    /**
     * The capture the agent already forwarded, offered by name and amount.
     *
     * The operator compares it against the paper in their hand before committing, so
     * the fallback for an unreadable barcode is a checked choice rather than "take
     * whatever printed last".
     */
    pendingTitle: 'آخر فاتورة وصلت من الصندوق',
    pendingUse: 'استخدم هذه الفاتورة',
    pendingCheck: 'طابق الرقم والمبلغ مع الفاتورة الورقية قبل التأكيد',
    pendingNone: 'لم تصل أي فاتورة من الصندوق بعد',
    pendingNoneHint: 'اطلب من الكاشير طباعة الفاتورة، ثم امسح الباركود عليها',

    /* The result. */
    invoiceTotal: 'إجمالي الفاتورة',
    /* ── Clearing the screen (§4) ─────────────────────────────────────── */
    clearForNext: 'شاشة جديدة — الزبون التالي',
    clearCountdown: (seconds: number) =>
      `تُمسح الشاشة تلقائياً بعد ${seconds} ثانية · أو اضغط Esc`,
    clearAfterPrint: 'تبقى الشاشة حتى تطبع القسيمة · أو اضغط Esc للمسح الآن',
    startOver: 'البدء من جديد',
  },

  /**
   * The on-screen preview of the paper (operator request, 2026-09-02).
   *
   * The same component the printer receives, shown at paper width before anything is
   * printed — so the customer sees the figures they are about to be charged while the
   * operator can still stop. A separately-built "preview" would drift from the real
   * slip and would be lying by the second edit.
   */
  preview: {
    title: 'معاينة القسيمة',
    hint: 'هكذا ستخرج القسيمة من الطابعة',
    print: 'طباعة القسيمة',
    printed: 'تمت الطباعة — سلّم القسيمة للكاشير',
    printAgain: 'طباعة مرة أخرى',
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
    /**
     * A sales prompt, never a rejection (§6.2 #3) — and never an instruction.
     *
     * The server composes the sentence (`bracketMessage`), because what it may
     * promise is a business rule and not a phrasing choice. This is the fallback the
     * station shows if it ever arrives empty. It names the bracket rather than a
     * difference: «أضف X لهذه الفاتورة» asked the customer to do something the shop
     * forbids — the receipt is already printed and the cashier may not change it
     * (§1.4, corrected 2026-09-04).
     */
    progressNoRule: 'شكراً لتسوّقك معنا',
    /** History, not a balance that buys anything (v4 §1.4). */
    lifetimeTotal: 'إجمالي مشترياتك معنا',

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
    queryHint:
      'اكتب رقم البطاقة أو رقم الهاتف أو اسم الزبون في نفس الحقل — النظام يميّز أيّها أدخلت.',
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

  /**
   * The walkthrough's chrome. Its page copy lives in `lib/guide.ts`, which is long
   * enough to deserve its own file and is reviewed as copy rather than as markup.
   */
  guide: {
    title: 'دليل الاستخدام',
    open: 'دليل الاستخدام',
    subtitle: 'شرح قصير لكل ما تحتاجه على هذه الشاشة',
    next: 'التالي',
    previous: 'السابق',
    done: 'إغلاق الدليل',
    pageOf: (page: number, total: number) => `الصفحة ${page} من ${total}`,
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
