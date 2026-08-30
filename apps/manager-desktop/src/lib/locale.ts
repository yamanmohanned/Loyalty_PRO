/**
 * Arabic UI copy, centralized (CLAUDE.md §9). Ported from the Next.js dashboard —
 * the copy survived the pivot; only the screens it labels changed.
 */
export const locale = {
  appName: 'ولاء',
  appTagline: 'إدارة المتجر',

  nav: {
    overview: 'نظرة عامة',
    customers: 'الزبائن',
    discounts: 'قواعد الخصم',
    reports: 'التقارير',
    capture: 'التقاط الفواتير',
    backup: 'النسخ الاحتياطي',
    modules: 'الوحدات',
    logout: 'تسجيل الخروج',
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
    title: 'نظرة عامة',
    subtitle: 'ملخّص أداء برنامج الولاء',
    kpiCustomers: 'الزبائن المسجّلون',
    kpiCaptured: 'فواتير ملتقطة',
    kpiAttributed: 'فواتير مرتبطة بزبون',
    kpiEnrolment: 'نسبة الارتباط',
    kpiDiscounts: 'قيمة الخصومات الممنوحة',
    kpiSales: 'المبيعات الملتقطة',
    chartTitle: 'المبيعات الملتقطة عبر الوقت',
    chartEmpty: 'لا توجد فواتير ملتقطة في هذه الفترة',
    topCustomers: 'أفضل الزبائن',
    topCustomersEmpty: 'لم يسجّل أي زبون إنفاقاً في هذه الفترة',
    recent: 'أحدث الفواتير',
    unattributed: 'غير مرتبطة',
    attributionHint: 'الفواتير غير المرتبطة طبيعية — أغلب المتسوقين غير مسجّلين في البرنامج.',
  },

  customers: {
    title: 'الزبائن',
    subtitle: 'الزبائن المسجّلون في البرنامج',
    searchPlaceholder: 'ابحث برقم الهاتف',
    searchHint: 'البحث برقم الهاتف فقط — الاسم ليس معرّفاً فريداً',
    colCustomer: 'الزبون',
    colBalance: 'الرصيد التراكمي',
    colProgress: 'التقدّم نحو العتبة',
    colCategory: 'الفئة',
    colJoined: 'تاريخ التسجيل',
    empty: 'لا يوجد زبائن',
    emptyBody: 'يتم تسجيل الزبائن من محطة الولاء عند الصندوق.',
  },

  customer: {
    balanceThisPeriod: 'الرصيد التراكمي (هذه الفترة)',
    derivedNote: 'محسوب من الفواتير — غير مخزّن',
    toNextTier: 'للوصول إلى خصم',
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
    periodType: 'دورة احتساب الرصيد',
    settlement: 'آلية تسوية الخصم',
    settlementHint: 'كيف يُحتسب الخصم في دفاتر المتجر عند الصندوق.',
    rulesTitle: 'مستويات الخصم',
    rulesSubtitle: 'كلما ارتفع إنفاق الزبون في الفترة، ارتفع الخصم.',
    colThreshold: 'عتبة الإنفاق',
    colRate: 'قيمة الخصم',
    addRule: 'إضافة مستوى',
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
    calibrationStart: 'بدء المعايرة',
    calibrationPending: 'بانتظار فاتورة تجريبية من الوكيل…',
  },

  backup: {
    title: 'النسخ الاحتياطي',
    subtitle: 'كل البيانات على هذا الجهاز. النسخ الاحتياطي ليس اختيارياً.',
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
  periodTypes: { WEEKLY: 'أسبوعية', MONTHLY: 'شهرية', CUSTOM: 'مخصّصة' },
} as const;
