/**
 * Arabic UI copy, centralized (CLAUDE.md §9). Ported from the Next.js dashboard —
 * the copy survived the pivot; only the screens it labels changed.
 */
/**
 * Counts are grouped the same way money is.
 *
 * `4200000 زبون` sitting a card away from `987,654,321 د.ع` is the defect this
 * fixes: the money was grouped and the count was not, so the two most prominent
 * numbers on a screen were formatted by different rules and the ungrouped one could
 * not be read at a glance. Found by rendering the screen against a stress payload
 * rather than the seed data, which is the only way a grouping bug shows itself —
 * every real figure in development has four digits or fewer (§12.27).
 *
 * `en-US` rather than `ar-IQ` deliberately: §6.3 sets Western digits in IBM Plex
 * Mono across the product so a number reads the same on a screen, on a slip and
 * down a phone line.
 */
const group = (value: number): string => new Intl.NumberFormat('en-US').format(value);

export const locale = {
  appName: 'Customer loyalty',
  appTagline: 'إدارة المتجر',

  nav: {
    overview: 'نظرة عامة',
    customers: 'الزبائن',
    discounts: 'قواعد الخصم',
    reports: 'التقارير',
    capture: 'التقاط الفواتير',
    cards: 'البطاقات',
    backup: 'النسخ الاحتياطي',
    modules: 'الوحدات',
    logout: 'تسجيل الخروج',
  },

  /** The reporting window, shared by Overview and Reports. */
  range: {
    label: 'الفترة',
    options: {
      '7d': 'آخر 7 أيام',
      '30d': 'آخر 30 يوماً',
      '90d': 'آخر 90 يوماً',
      '365d': 'آخر سنة',
    } as const,
  },

  cards: {
    title: 'بطاقات الولاء',
    subtitle: 'الدفعات المطبوعة، ومقدار ما تبقّى منها',

    /* ── The counter that decides when to reorder ─────────────────────────── */

    blanksRemaining: 'بطاقات جاهزة للتسليم',
    blanksRemainingHint: 'اطلب دفعة جديدة قبل أن تنفد',
    nextSerial: 'أول مسلسل في الدفعة القادمة',

    /* ── Generating ───────────────────────────────────────────────────────── */

    generate: 'إنشاء دفعة جديدة',
    quantity: 'عدد البطاقات',
    quantityHint: 'حدّد العدد فقط — النظام يختار المسلسلات بنفسه، فلا يمكن أن تتداخل دفعتان',
    note: 'ملاحظة (اختياري)',
    notePlaceholder: 'اسم المطبعة أو رقم الطلب',
    generating: 'جاري الإنشاء…',
    generated: (range: string) => `تم إنشاء الدفعة — المدى ${range}`,

    /* ── Export ───────────────────────────────────────────────────────────── */

    export: 'تنزيل ملف الطباعة',
    exportManifest: 'تنزيل كشف الدفعة',
    exporting: 'جاري التحضير…',
    exportSection: 'الطباعة',
    exportWhole: 'تنزيل ملف الطباعة (الدفعة كاملة)',
    exportWholeHint: 'ملف CSV للمطبعة يحتوي كل بطاقات الدفعة، مع كشف بالتفاصيل',
    /* ── Reprinting a slice (2026-09-02) ──────────────────────────────────── */
    reprint: 'إعادة طباعة مدى محدّد',
    reprintHint: 'لطباعة بديل عن بطاقات تلفت أو خرجت غير مقروءة — دون سحب أرقام الدفعة كلها مرة أخرى',
    reprintFrom: 'من مسلسل',
    reprintTo: 'إلى مسلسل',
    reprintSubmit: 'تنزيل ملف إعادة الطباعة',
    reprintRangeError: 'حدّد بداية المدى ونهايته داخل مدى هذه الدفعة',
    /**
     * The count comes first and the range last, with no dash between them.
     *
     * The first draft read «...للمدى 000002 — 000004 — 3 بطاقة» and put three
     * em-dashes in one line, one of which belongs to the range itself. Read aloud it
     * is not clear which dash separates what — a §12.27 rendered check, on a sentence
     * rather than a number.
     */
    reprintedRange: (range: string, count: number) =>
      `تم تحضير ملف إعادة طباعة لـ ${count} بطاقة، المدى ${range}`,
    exportedRows: (count: number) => `${count} بطاقة في الملف`,
    /**
     * The warning has to be on the screen, not in a manual. The file necessarily
     * contains every card number in the batch — that is what a card printer needs —
     * so the person downloading it is the person who has to delete it afterwards.
     */
    exportWarning:
      'ملف الطباعة يحتوي أرقام كل البطاقات في الدفعة. سلّمه للمطبعة فقط، واحذفه بعد انتهاء الطباعة.',
    exportedAt: 'آخر تنزيل',

    /* ── Voiding ──────────────────────────────────────────────────────────── */

    voidBatch: 'إتلاف الدفعة بالكامل',
    voidBatchHint: 'استخدمه إذا تسرّب ملف الطباعة — تُتلَف البطاقات غير المُسلَّمة فقط',
    voidBatchReason: 'سبب الإتلاف',
    voidBatchConfirm: (count: number) =>
      `سيتم إتلاف ${count} بطاقة غير مُسلَّمة. البطاقات التي بيد الزبائن لا تتأثر. متابعة؟`,
    voidedCount: (count: number) => `تم إتلاف ${group(count)} بطاقة`,

    /* ── The table ────────────────────────────────────────────────────────── */

    colBatch: 'الدفعة',
    colRange: 'المدى',
    colQuantity: 'الكمية',
    colStatus: 'الحالة',
    colGeneratedBy: 'أنشأها',
    colGeneratedAt: 'التاريخ',
    countPrinted: 'جاهزة',
    countAssigned: 'مُسلَّمة',
    countLost: 'مفقودة',
    countReplaced: 'مستبدَلة',
    countVoid: 'متلَفة',
    batchStatus: {
      GENERATED: 'أُنشئت',
      EXPORTED: 'نُزّل ملفها',
      RECEIVED: 'استُلمت',
      RETIRED: 'متلَفة',
    } as const,

    empty: 'لا توجد دفعات بعد',
    emptyBody:
      'البطاقات المطبوعة مسبقاً تُنشأ هنا ثم تُطبع لدى مطبعة. حتى ذلك الحين تطبع المحطة بطاقات ورقية.',

    /* ── The sequence, made prominent (2026-09-02) ────────────────────────── */

    /**
     * The whole answer to the merchant's collision worry, so it is stated rather than
     * left to be inferred from a serial in a corner: the last number that exists, the
     * first number the next batch would take, and the fact that he does not choose it.
     */
    sequenceTitle: 'تسلسل المسلسلات',
    sequenceHint: 'النظام يختار المسلسلات بنفسه — لا يمكن أن تتداخل دفعتان',
    sequenceReached: 'وصل التسلسل إلى',
    sequenceReachedNone: 'لم تُنشأ أي دفعة بعد',
    sequenceNext: 'الدفعة القادمة تبدأ من',
    sequenceTotal: 'مجموع ما طُبع',
    sequenceBatches: (count: number) => `${group(count)} دفعة`,

    /* ── Batch card chrome ────────────────────────────────────────────────── */

    batchLabel: (number: number) => `الدفعة ${number}`,
    batchDetails: 'تفاصيل الدفعة',
    batchNote: 'ملاحظة',
    exportedNever: 'لم يُنزّل بعد',
    countsTitle: 'حالة بطاقات هذه الدفعة',
    dangerZone: 'إجراء لا رجعة فيه',
  },

  common: {
    currency: 'د.ع',
    loading: 'جارٍ التحميل',
    retry: 'إعادة المحاولة',
    save: 'حفظ',
    saving: 'جارٍ الحفظ…',
    saved: 'تم الحفظ',
    cancel: 'إلغاء',
    edit: 'تعديل',
    delete: 'حذف',
    add: 'إضافة',
    search: 'بحث',
    viewAll: 'عرض الكل',
    back: 'رجوع',
    none: 'لا يوجد',
    enabled: 'مفعّل',
    disabled: 'غير مفعّل',
    error: 'حدث خطأ',
    errorBody: 'تعذّر تحميل البيانات. تحقّق من الاتصال بالخادم وأعد المحاولة.',
    comingSoon: 'قيد التطوير',
  },

  setup: {
    title: 'الإعداد الأولي',
    subtitle: 'وجّه التطبيق إلى خادم ولاء الخاص بمتجرك',
    urlLabel: 'رابط خادم ولاء',
    urlPlaceholder: 'http://192.168.1.10:4000',
    urlHint: 'عنوان جهاز المدير على شبكة المتجر',
    connect: 'اتصال والمتابعة',
    testing: 'جارٍ الاختبار…',
    support: 'إذا لم تكن متأكداً، تواصل مع الدعم الفني.',
  },

  login: {
    /* ── V4-4: the brand panel's real content, in place of marketing copy ── */
    tagline: 'لوحة تحكم برنامج الولاء — الزبائن، شرائح الخصم، التقارير والنسخ الاحتياطي.',
    greeting: 'مرحباً بك مجدداً',
    /* The card says what to DO. The panel beside it already says what this app IS,
       and rendering both showed the same sentence twice on one screen. */
    signInHint: 'أدخل بيانات حسابك للمتابعة إلى لوحة التحكم',
    serverLabel: 'الخادم المتصل به هذا الجهاز',
    title: 'تسجيل الدخول',
    subtitle: 'لوحة تحكم برنامج الولاء',
    username: 'اسم المستخدم',
    password: 'كلمة المرور',
    submit: 'دخول',
    submitting: 'جارٍ الدخول…',
    changeServer: 'تغيير الخادم',
    /** Shown when the credentials are valid but belong to another app entirely. */
    wrongApp: 'هذا الحساب ليس مخصّصاً للوحة التحكم',
  },

  overview: {
    /* ── V4-4: the four headline figures §2.4 asks for ─────────────────── */
    kpiSales: 'المبيعات الملتقطة',
    kpiSalesHint: (invoices: number, average: number) =>
      `${group(invoices)} فاتورة · متوسط السلة ${group(average)} د.ع`,
    kpiCustomersHint: (added: number) => `${group(added)} زبون جديد في هذه الفترة`,
    kpiDiscountsHint: 'ما مُنح للزبائن من شرائح الخصم',
    title: 'نظرة عامة',
    subtitle: 'ملخّص أداء برنامج الولاء',
    kpiCustomers: 'الزبائن المسجّلون',
    kpiCaptured: 'فواتير ملتقطة',
    kpiAttributed: 'فواتير مرتبطة بزبون',
    kpiEnrolment: 'نسبة الارتباط',
    kpiDiscounts: 'قيمة الخصومات الممنوحة',
    chartTitle: 'المبيعات الملتقطة عبر الوقت',
    chartEmpty: 'لا توجد فواتير ملتقطة في هذه الفترة',
    topCustomers: 'أفضل الزبائن',
    topCustomersEmpty: 'لم يسجّل أي زبون إنفاقاً في هذه الفترة',
    recent: 'أحدث الفواتير',
    unattributed: 'غير مرتبطة',
    attributionHint: 'الفواتير غير المرتبطة طبيعية — أغلب المتسوقين غير مسجّلين في البرنامج.',

    /* ── V4-4: the attribution split, drawn ──────────────────────────────── */
    splitTitle: 'توزيع الفواتير الملتقطة',
    splitCentreLabel: 'نسبة الارتباط',
    splitAttributed: 'مرتبطة بزبون',
    splitUnattributed: 'غير مرتبطة',
    splitInvoices: (n: number) => `${group(n)} فاتورة`,
    rankLabel: (n: number) => `المرتبة ${group(n)}`,
  },

  customers: {
    title: 'الزبائن',
    subtitle: 'الزبائن المسجّلون في البرنامج',
    searchPlaceholder: 'ابحث برقم الهاتف',
    searchHint: 'البحث برقم الهاتف فقط — الاسم ليس معرّفاً فريداً',
    colCustomer: 'الزبون',
    colBalance: 'إجمالي المشتريات',
    colCategory: 'الفئة',
    colCard: 'رقم البطاقة',
    noCard: 'لا يحمل بطاقة',
    resetFilters: 'إعادة تعيين',
    colJoined: 'تاريخ التسجيل',
    empty: 'لا يوجد زبائن',
    emptyBody: 'يتم تسجيل الزبائن من محطة الولاء عند الصندوق.',

    /* ── List controls ───────────────────────────────────────────────────── */

    categoryAll: 'كل الفئات',
    categoryRegular: 'اعتيادي',
    categoryWholesale: 'جملة',
    categoryVip: 'كبار المشترين',
    sortLabel: 'الترتيب',
    sortNewest: 'الأحدث تسجيلاً',
    sortSpend: 'الأعلى إنفاقاً (الإجمالي)',
    sortName: 'الاسم',
    /** Shown as `عرض 1–25 من 1,847`, so nobody mistakes a page for the whole list. */
    pageRange: (from: number, to: number, total: number) =>
      `عرض ${from}–${to} من ${total.toLocaleString('en-US')}`,
    prev: 'السابق',
    next: 'التالي',
    exportCsv: 'تصدير CSV',
    /**
     * The export carries phone numbers, which §7.11 calls the one identifier worth
     * protecting. Said on the screen rather than assumed, for the same reason the
     * card batch export says it.
     */
    exportWarning: 'الملف يحتوي أرقام هواتف الزبائن — تعامل معه بحذر.',
  },

  /** The rules a specific customer is measured against (customer detail). */
  appliedRules: {
    perInvoice: 'على كل فاتورة تبلغ هذا المبلغ',
    title: 'الخصم المطبَّق على هذا الزبون',
    /**
     * v3 has ONE ladder for everybody (§2.3). Said plainly on the screen because the
     * v1 design had a per-customer override card here, and a manager who remembers it
     * should be told the answer rather than left hunting for a button.
     */
    subtitle: 'تُطبَّق قواعد المتجر العامة على جميع الزبائن — لا توجد استثناءات فردية.',
    current: 'المستوى الحالي',
    none: 'لم يبلغ أي مستوى بعد',
    capNote: (cap: string) => `الحد الأقصى المطلق للخصم: ${cap}`,
    edit: 'تعديل قواعد الخصم',
  },

  customer: {
    balanceThisPeriod: 'إجمالي المشتريات (منذ التسجيل)',
    derivedNote: 'محسوب من الفواتير — للتقارير فقط، ولا يؤثر على الخصم',
    invoices: 'فاتورة',
    details: 'التفاصيل',
    toNextTier: 'للوصول إلى خصم',
    perInvoiceNote: 'الخصم يُحتسب على قيمة كل فاتورة على حدة — وليس على إجمالي المشتريات.',
    allTiersReached: 'تم بلوغ جميع المستويات',
    vouchers: 'القسائم',
    transactions: 'سجل الفواتير',
    transactionsEmpty: 'لا توجد فواتير مرتبطة بهذا الزبون بعد',
    vouchersEmpty: 'لم يحصل هذا الزبون على أي قسيمة بعد',
    colInvoice: 'رقم الفاتورة',
    colGross: 'قبل الخصم',
    colDiscount: 'الخصم',
    colNet: 'بعد الخصم',
    colDate: 'التاريخ',
    colCapture: 'طريقة الالتقاط',
  },

  discounts: {
    title: 'قواعد الخصم',
    subtitle: 'الخصم يُطبَّق فوراً على نفس الفاتورة التي يتسوّق بها الزبون.',
    settingsTitle: 'الإعدادات العامة',
    discountType: 'نوع الخصم',
    typePercentage: 'نسبة مئوية',
    typeFixed: 'مبلغ ثابت',
    typeNone: 'معطّل',
    typeNoneHint: 'يوقف الخصم الفوري مع استمرار التقاط الفواتير والتقارير.',
    minRate: 'أدنى نسبة مسموحة',
    maxRate: 'أعلى نسبة مسموحة',
    absoluteCap: 'الحد الأقصى المطلق للخصم',
    absoluteCapHint:
      'خط الدفاع الأخير: يُطبَّق بعد حساب النسبة مهما بلغت قيمة الفاتورة. بدونه، فاتورة كبيرة بنسبة عالية تكلّف المتجر مبلغاً ضخماً.',
    settlement: 'آلية تسوية الخصم',
    settlementHint:
      'تحدّد نص التوجيه المطبوع على قسيمة الخصم. الخيار الافتراضي يذكر المبالغ دون افتراض طريقة قيد الخصم في الدفاتر.',
    rulesTitle: 'مستويات الخصم',
    rulesSubtitle: 'كلما ارتفعت قيمة الفاتورة الواحدة، ارتفع الخصم عليها.',
    colThreshold: 'قيمة الفاتورة من',
    colRate: 'قيمة الخصم',
    addRule: 'إضافة مستوى',
    /* ── V4-4 ─────────────────────────────────────────────────────────── */
    colRuleCap: 'حد أقصى لهذه الشريحة',
    colRuleCapHint: 'اتركه فارغاً ليطبَّق الحد الأقصى العام',
    assessmentDiscount: 'الخصم عند هذه القيمة:',
    assessmentProfit: 'الربح الصافي التقديري:',
    assessmentSafe: (min: number, max: number) => `ضمن النطاق الآمن (${min}–${max}٪).`,
    inactiveRule: 'غير مفعّلة',
    inactiveRuleHint:
      'هذه الشريحة مخزّنة كغير مفعّلة، فلا يطبّقها المحرّك. لا يمكن إنشاء هذه الحالة من هذه الشاشة — راجع من كتبها مباشرةً في قاعدة البيانات.',
    removeRule: 'حذف',
    safeBand: 'النطاق الآمن الموصى به: 1–3٪',
    marginTitle: 'تحذير الهامش',
    savedNotice: 'تم حفظ القواعد. تُطبَّق على عمليات المسح القادمة فقط.',
  },

  modules: {
    title: 'الوحدات',
    subtitle: 'فعّل أو أوقف الوحدات الاختيارية دون الحاجة لتحديث التطبيق.',
    whatsapp: 'تكامل واتساب',
    whatsappHint:
      'إرسال صورة الباركود وملخّصات المشتريات. يتطلب قوالب معتمدة من Meta ويُحتسب لكل محادثة.',
    cardPrinting: 'طباعة بطاقات الزبائن',
    cardPrintingHint: 'طباعة بطاقة الولاء عند التسجيل في المحطة.',
    cloudBackup: 'النسخ الاحتياطي السحابي',
    cloudBackupHint: 'رفع نسخة مشفّرة إلى Google Drive. إلزامي — لا تُوقفه إلا مؤقتاً.',
    advancedReports: 'التقارير المتقدّمة',
    advancedReportsHint: 'تحليلات إضافية لسلوك الزبائن.',
    voucherReconciliation: 'تسوية القسائم',
    voucherReconciliationHint: 'مطابقة القسائم المُستلمة في نهاية اليوم مع سجلات النظام.',
    smsFallback: 'رسائل SMS بديلة',
    smsFallbackHint: 'إرسال رسالة نصية عند تعذّر واتساب.',
    autoUpdate: 'التحديث التلقائي',
    autoUpdateHint: 'خارج نطاق الإصدار الحالي — يُثبّت المطوّر التحديثات يدوياً.',
  },

  capture: {
    title: 'التقاط الفواتير',
    subtitle: 'كيف يصل النظام إلى الفواتير المطبوعة من برنامج المحاسبة.',
    modeTitle: 'وضع الالتقاط',
    modeSpoolHint:
      'الوضع المفضّل: يراقب مجلد الطباعة دون الدخول في مسار الطباعة، فلا يمكنه إيقاف الطباعة إطلاقاً.',
    inPathWarning:
      'هذا الوضع يقع داخل مسار الطباعة. يكتب البايتات إلى الطابعة أولاً قبل أي معالجة، لكن إذا توقّف الوكيل تماماً فقد تُفقد فاتورة حتى يعيد المراقب تشغيله.',
    preferredBadge: 'مفضّل',
    codepage: 'ترميز النصوص',
    codepageHint:
      'طابعات السوق العربي تستخدم CP864 أو Windows-1256 غالباً — وليس UTF-8.',
    agentStatus: 'حالة الوكيل',
    agentNotInstalled: 'الوكيل غير مثبّت بعد',
    agentNotInstalledHint:
      'يُبنى وكيل الالتقاط في مرحلة لاحقة. لا يمكن التقاط الفواتير تلقائياً حتى ذلك الحين.',
    calibrationTitle: 'معايرة قراءة الفاتورة',
    calibrationHint:
      'اطبع فاتورة تجريبية، ثم اختر من النص الملتقط موضع رقم الفاتورة والإجمالي. يُنشئ النظام قالب القراءة تلقائياً.',
    /* ── The station's slip printer (§5) ──────────────────────────────── */
    paperTitle: 'ورق طابعة محطة الولاء',
    paperHint:
      'عرض الورق الحراري المُحمَّل في طابعة محطة الولاء — وهي غير طابعة فواتير الصندوق أعلاه. اختر العرض المطابق للبكرة الموجودة فعلاً، وإلا خرجت القسيمة مقطوعة أو ضيّقة.',
    paperLabel: 'عرض الورق',
    paperOption: (mm: number) => `${mm} ملم`,
    paperPropagation:
      'يصل التغيير إلى المحطة عند تحديث جلستها (خلال ١٥ دقيقة تقريباً) أو عند إعادة تسجيل الدخول.',
    calibrationStart: 'بدء المعايرة',
    calibrationPending: 'بانتظار فاتورة تجريبية من الوكيل…',
  },

  backup: {
    title: 'النسخ الاحتياطي',
    subtitle: 'كل البيانات على هذا الجهاز. النسخ الاحتياطي ليس اختيارياً.',
    riskTitle: 'خطر فقدان البيانات',
    riskNotice:
      'قاعدة البيانات موجودة على هذا الجهاز فقط. عطل في القرص أو سرقة أو برمجية خبيثة تعني فقدان كل شيء بدون نسخة احتياطية.',
    driveTitle: 'Google Drive (مشفّر)',
    driveHint: 'تُشفَّر النسخة قبل الرفع. لا تغادر البيانات المالية الجهاز بصيغة مقروءة.',
    driveNotConnected: 'غير متصل',
    localTitle: 'نسخة محلية',
    usbTitle: 'نسخة على USB',
    scheduleTitle: 'الجدولة',
    scheduleHint: 'يومياً بعد الإغلاق، وبعد كل ٥٠٠ عملية.',
    restoreTitle: 'اختبار الاستعادة',
    restoreHint: 'نسخة احتياطية لم تُختبر ليست نسخة احتياطية. اختبرها شهرياً.',
    lastBackup: 'آخر نسخة',
    never: 'لم تُنفَّذ بعد',

    runNow: 'أخذ نسخة الآن',
    running: 'جاري النسخ…',
    verifyNow: 'اختبار الاستعادة الآن',
    verifying: 'جاري الاختبار…',
    nextRun: 'النسخة المجدولة القادمة',
    scheduleDaily: (at: string) => `يومياً الساعة ${at} بتوقيت المتجر`,
    scheduleCounter: (n: number) => `وبعد كل ${n} عملية`,
    sinceLastBackup: (n: number) => `${n} عملية منذ آخر نسخة`,
    scheduleOff: 'الجدولة متوقفة',

    historyTitle: 'سجل النسخ',
    historyHint: 'كل محاولة تُسجَّل — نجحت أو فشلت أو تخطّت.',
    historyEmpty: 'لم تُسجَّل أي محاولة بعد',
    outcomeCompleted: 'تمت',
    outcomeFailed: 'فشلت',
    outcomeSkipped: 'تُخطّيت',
    scheduledRun: 'مجدولة',
    outOfSpace: 'مساحة غير كافية',

    verifiedAt: 'آخر اختبار استعادة ناجح',
    neverVerified: 'لم يُجرَ اختبار استعادة بعد',
    verifyPassed: 'نجح الاختبار — النسخة تحتوي على أحدث العمليات',
    verifyFailed: 'فشل الاختبار',
    /** The §12.17 assertion, named on screen so it is not mistaken for "the file opened". */
    recencyProven: 'تم التحقق من أن النسخة تحتوي على عملية سُجّلت قبل أخذها مباشرة',
    integrity: 'فحص سلامة قاعدة البيانات',
  },

  /**
   * The key ceremony (CLAUDE_v3.md §12.19).
   *
   * The copy carries the whole weight of this feature. A manager who reads "احفظ
   * المفتاح" and clicks past it has done nothing; a manager who reads that losing this
   * key makes every backup permanently unopenable writes it down. So the wording states
   * the consequence in full, and states it before the key is shown rather than after.
   */
  keyCeremony: {
    title: 'مفتاح تشفير النسخ الاحتياطي',
    subtitle: 'خطوة إلزامية لمرة واحدة — لا يمكن تخطّيها',

    whyTitle: 'لماذا هذه الخطوة إلزامية',
    why:
      'النسخ الاحتياطية مشفّرة، ولا يمكن فتحها إلا بهذا المفتاح. المفتاح محفوظ على هذا الجهاز — وهو الجهاز نفسه الذي تحميك النسخ الاحتياطية من فقدانه.',
    whyHard:
      'إذا احترق هذا الجهاز أو سُرق أو تعطّل قرصه، وكان المفتاح موجوداً عليه فقط، فإن كل النسخ الاحتياطية تصبح غير قابلة للاستعادة نهائياً. لا يستطيع أحد فتحها — لا نحن ولا Google ولا أي شخص آخر.',
    whyWorse: 'هذا أسوأ من عدم وجود نسخ احتياطية أصلاً، لأنك ستعتمد عليها.',
    /**
     * The consequence got more expensive with pre-printed cards (§12.25).
     *
     * §12.11 already forbade regenerating `QR_TOKEN_SECRET` on a machine whose cards
     * are printed. It now also destroys blank stock in a drawer that no customer has
     * ever touched — cards the merchant paid a vendor to print. Said on the screen,
     * not only in a manual, because the person who would do it is the person reading
     * this one.
     */
    whyCards:
      'ملاحظة مهمة: لا تُعِد توليد مفاتيح الخادم بعد طباعة بطاقات الولاء. تغييرها يُبطل كل البطاقات المطبوعة — بما فيها البطاقات الجاهزة في الدرج التي لم تُسلَّم لأي زبون بعد.',

    generate: 'توليد المفتاح',
    generating: 'جاري التوليد…',
    reveal: 'إظهار المفتاح',
    revealing: 'جاري الإظهار…',

    keyLabel: 'مفتاح التشفير',
    keyHint: 'اكتبه على ورق واحفظه خارج هذا الجهاز — في خزنة، أو مع المحاسب، أو في أي مكان آمن لا يتأثر بما يصيب هذا الجهاز.',
    /**
     * Named so it cannot be mistaken for the secret.
     *
     * The fingerprint is safe to display — it is a hash of 256 random bits — but it is
     * sixteen monospace hex characters sitting above a button that says "reveal the
     * key", and the first operator to see this screen read it as the key. A caption
     * underneath was not enough; the label itself now carries the denial.
     */
    fingerprintLabel: 'بصمة المفتاح — ليست المفتاح',
    fingerprintHint:
      'رمز تعريف قصير للمفتاح، آمن للمشاركة ولا يكشف المفتاح. المفتاح نفسه لم يُعرض بعد.',
    print: 'طباعة المفتاح',

    confirmTitle: 'أدخل المفتاح للتأكيد',
    confirmHint:
      'أعد كتابة المفتاح من الورقة التي كتبته عليها — لا نسخاً ولصقاً من الشاشة. الهدف هو التأكد من أنه محفوظ فعلاً خارج هذا الجهاز.',
    confirmPlaceholder: 'الصق أو اكتب المفتاح هنا',
    confirm: 'تأكيد الحفظ وتفعيل النسخ الاحتياطي',
    confirming: 'جاري التأكيد…',
    mismatch: 'المفتاح المُدخل لا يطابق المفتاح الحالي',

    confirmedTitle: 'تم تفعيل النسخ الاحتياطي',
    confirmedBy: 'أكّده',
    confirmedAt: 'بتاريخ',

    /** The persistent banner, shown anywhere in the app while backups are off. */
    bannerTitle: 'النسخ الاحتياطي متوقف',
    bannerUnconfirmed: 'لم يتم تأكيد حفظ مفتاح التشفير خارج هذا الجهاز. لا تعمل أي نسخة احتياطية حتى يتم ذلك.',
    bannerUnconfigured: 'لم يتم إعداد مفتاح التشفير بعد. لا تعمل أي نسخة احتياطية.',
    bannerAction: 'إكمال الخطوة الآن',
    /**
     * For a manager. The ceremony is the owner's — generating and revealing the key are
     * OWNER-only — so telling a manager to "complete it now" would be an instruction
     * they cannot carry out.
     */
    bannerOwnerOnly: 'هذه الخطوة يقوم بها المالك. أبلغه ليسجّل الدخول ويكملها — لا تعمل أي نسخة احتياطية حتى ذلك.',

    printTitle: 'مفتاح تشفير النسخ الاحتياطي — ولاء',
    printWarning:
      'بدون هذا المفتاح لا يمكن استعادة أي نسخة احتياطية. احفظ هذه الورقة في مكان آمن خارج جهاز الإدارة.',
    printGeneratedAt: 'تاريخ الطباعة',
  },

  reports: {
    title: 'التقارير',
    subtitle: 'أداء البرنامج وتسوية القسائم',
    discountsGranted: 'الخصومات الممنوحة',
    vouchersIssued: 'قسائم صادرة',
    vouchersRedeemed: 'قسائم مستخدَمة',
    vouchersOutstanding: 'قسائم لم تُستلم',
    outstandingHint: 'قسائم صدرت ولم تصل إلى الصندوق — تحقّق إذا استمر الرقم بالارتفاع.',
    redemptionRate: 'نسبة الاستخدام',
    captureHealth: 'صحة الالتقاط',
    attributionRate: 'نسبة الارتباط بالزبائن',
    averageBasket: 'متوسط قيمة الفاتورة',

    /* ── Breakdowns ──────────────────────────────────────────────────────── */

    categoryTitle: 'توزيع الزبائن حسب الفئة',
    categoryEmpty: 'لا يوجد زبائن مسجّلون بعد',
    tierTitle: 'توزيع الفواتير على شرائح الخصم',
    tierSubtitle: 'عدد الفواتير التي بلغت كل شريحة خلال الفترة المختارة',
    tierEmpty: 'لم تُحدَّد شرائح خصم بعد',
    /** Customers-per-tier in v3; invoices-per-bracket in v4 (§10.6). */
    tierReached: (count: number) => `${group(count)} زبون`,
    bracketInvoices: (count: number) => `${group(count)} فاتورة`,

    /* ── Who the discounts go to (v4 §10.5) ────────────────────────────── */
    perCustomerTitle: 'قيمة الخصم لكل زبون',
    perCustomerSubtitle:
      'الخصم يُحتسب على كل فاتورة على حدة — تابع هنا من يحصل على أكبر نصيب خلال الفترة',
    perCustomerEmpty: 'لم يحصل أي زبون على خصم في هذه الفترة',
    perCustomerColName: 'الزبون',
    perCustomerColValue: 'قيمة الخصم',
    discountedInvoices: (count: number) => `${group(count)} فاتورة مخصومة`,
    ofThreshold: 'فاتورة من',

    /* ── Charts (2026-09-02) ──────────────────────────────────────────────── */

    funnelTitle: 'مسار القسائم',
    funnelSubtitle: 'من الإصدار إلى الاستلام — كل مرحلة نسبة مما قبلها',
    funnelEmpty: 'لم تصدر أي قسيمة في هذه الفترة',
    funnelIssued: 'صدرت',
    funnelRedeemed: 'وصلت الصندوق',
    funnelOutstanding: 'لم تصل بعد',
    funnelShare: (pct: number) => `${pct}٪ من الصادر`,

    captureSubtitle: 'كيف وصلت الفواتير من الصندوق — الوضع المفضَّل هو مراقبة قائمة الطباعة',
    captureEmpty: 'لم يصل أي التقاط بعد — تحقّق من وكيل الالتقاط على جهاز الصندوق',
    captureColMode: 'طريقة الالتقاط',
    captureColCount: 'عدد الفواتير',

    categorySubtitle: 'عدد الزبائن المسجّلين في كل فئة',
    categoryColCategory: 'الفئة',
    categoryColCount: 'عدد الزبائن',

    tierColTier: 'المستوى',
    tierColReached: 'بلغوه',

    /* ── The cap, reported (§12.37) ───────────────────────────────────────── */

    /**
     * §2.3's guardrails exist to protect the margin, and a guardrail that never
     * reports is one nobody can tune. The copy names the *consequence* — your tiers
     * are asking for more than you decided to give — rather than the mechanism.
     */
    capTitle: 'أثر الحد الأقصى للخصم',
    capSubtitle: 'كم مرة خفّض الحد الأقصى قيمة الخصم، وكم وفّر عليك',
    /**
     * Two different zeros, and they must not read alike.
     *
     * **Zero out of N discounted sales is a verified absence** — the check ran across
     * N sales and found nothing wrong. **Zero out of zero is silence** — nothing has
     * happened yet that the cap could have applied to. A bare "0" collapses the two,
     * and the first is a reassurance while the second is just an empty period.
     *
     * Same principle as the backup screen showing dates and gaps rather than a blank:
     * the absence of a problem should be stated, with the denominator that makes it
     * a statement rather than a shrug.
     */
    capNeverApplied: 'لم يُطبَّق الحد الأقصى على أي عملية',
    capNeverAppliedOf: (count: number) =>
      `من أصل ${group(count)} فاتورة استحقت خصماً في هذه الفترة — مستويات الخصم ضمن الحد الأقصى`,
    capNoDiscounts: 'لم تستحق أي فاتورة خصماً في هذه الفترة',
    capNoDiscountsHint: 'لا يوجد ما يُقاس عليه الحد الأقصى بعد',
    capTimes: 'فواتير طُبّق عليها الحد الأقصى',
    capOfDiscounted: (pct: number) => `${pct}٪ من الفواتير التي استحقت خصماً`,
    capSaved: 'ما وفّره الحد الأقصى',
    capSavedHint: 'الفرق بين ما طلبته مستويات الخصم وما مُنح فعلياً',
    /** The line that turns a statistic into an instruction. */
    capAdvice:
      'الحد الأقصى يعمل في أغلب الخصومات — مستويات الخصم أعلى مما قرّرته. راجع «قواعد الخصم».',
    capAdviceLink: 'قواعد الخصم',

    reconTitle: 'تسوية اليوم',
    reconSubtitle: 'القسائم الصادرة اليوم ومصيرها',
    reconEmpty: 'لم تصدر قسائم اليوم',
    reconStrategy: 'آلية التسوية',

    /** Said in words beside the number, never left to the bar's width alone. */
    shareOfTotal: (pct: number) => `${pct}٪`,

    /**
     * Counts carry their unit wherever a share sits beside them.
     *
     * §12.27's second instance was two bare adjacent numbers — `9` next to `75٪`
     * read as `975٪`. Every panel on this screen puts a count beside a percentage,
     * so every count here is a phrase rather than a numeral.
     */
    invoiceCount: (count: number) => `${group(count)} فاتورة`,
    voucherCount: (count: number) => `${group(count)} قسيمة`,
  },

  /**
   * Chart chrome, shared by every panel that draws one.
   *
   * The table toggle is offered on every chart rather than only the ones judged
   * hard to read: a reader who wants numbers should not have to work out which
   * charts were given the escape hatch.
   */
  viz: {
    showTable: 'عرض كجدول',
    showChart: 'عرض كرسم',
    empty: 'لا توجد بيانات في هذه الفترة',
  },

  /**
   * The free-space banner (CLAUDE_v3.md §12.15).
   *
   * The copy names the consequence rather than the condition. "Low disk space" is a
   * message every Windows user has learned to close; "sales will stop being recorded"
   * is one a shop owner acts on. §12.15's failure is that a full drive looks like an
   * application bug, so the wording has to make the connection for them.
   */
  storage: {
    warnTitle: 'المساحة الحرة على القرص منخفضة',
    warnBody: 'إذا امتلأ القرص ستتوقف عمليات البيع عن التسجيل. فرّغ مساحة على هذا الجهاز.',
    criticalTitle: 'المساحة الحرة على القرص شبه منتهية',
    criticalBody:
      'تسجيل المبيعات قد يتوقف في أي لحظة. فرّغ مساحة على هذا الجهاز الآن — الفواتير التي لا تُسجَّل لا يمكن استرجاعها لاحقاً.',
    unknownTitle: 'تعذّرت قراءة المساحة الحرة',
    unknownBody: 'لم يستطع الخادم قياس المساحة على قرص قاعدة البيانات. تحقّق من الجهاز.',
    freeLabel: 'المساحة المتبقية',
  },

  roles: { OWNER: 'مالك', MANAGER: 'مدير', STATION: 'محطة', AGENT: 'وكيل الالتقاط' },
  categories: { REGULAR: 'عادي', WHOLESALE: 'جملة', VIP: 'مميّز' },
  voucherStatus: { ISSUED: 'صادرة', REDEEMED: 'مستخدَمة', VOID: 'ملغاة' },
  captureModes: {
    SPOOL_WATCH: 'مراقبة قائمة الطباعة',
    VIRTUAL_PRINTER: 'طابعة وسيطة',
    SERIAL_BRIDGE: 'جسر COM',
    NETWORK_PROXY: 'وسيط شبكة',
    MANUAL: 'إدخال يدوي',
  },
} as const;
