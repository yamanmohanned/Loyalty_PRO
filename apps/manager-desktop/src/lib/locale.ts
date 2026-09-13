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

/**
 * Dates, in Arabic, with Western digits.
 *
 * ── The inconsistency this removes ───────────────────────────────────────────
 *
 * Money and counts already used `en-US`, deliberately and for the reason above.
 * Dates used `ar-IQ`, which renders Arabic-Indic digits (٠١٢٣). So five of the eight
 * screens showed both numeral systems at once — a customer's join date in ٢٠٢٦ beside
 * their spend in 34,299,500 — and neither choice was wrong on its own. Mixed, they
 * read as two products stitched together, and a merchant comparing a date on screen
 * with a date on a printed slip is doing a conversion nobody asked him to do.
 *
 * `-u-nu-latn` keeps everything else about the Iraqi Arabic locale — month names,
 * ordering, the calendar — and changes only the numbering system. So this is the same
 * date a merchant already reads, with the digits the rest of the product uses.
 *
 * Not a display detail: §6.3 makes the numeral system a product-wide rule, and this is
 * the half that had not been applied.
 */
export const DATE_LOCALE = 'ar-IQ-u-nu-latn';

/**
 * One metric, one name.
 *
 * `attributionRatePct` — the share of captured invoices tied to a known customer — was
 * labelled «نسبة الارتباط» on the Overview KPI and inside its donut, and
 * «نسبة الارتباط بالزبائن» on Reports. Same field, same number, two names, and no way
 * for a merchant to know that the figure he is comparing between two screens is the
 * same figure. The longer form is kept because it says what the rate is *of*; the
 * short one could equally have meant capture rate or redemption rate.
 *
 * Defined here and referenced from all three sites, so the next edit cannot reintroduce
 * the drift by touching one of them.
 */
export const ATTRIBUTION_RATE_LABEL = 'نسبة الارتباط بالزبائن';

export const formatDate = (value: string | number | Date): string =>
  new Date(value).toLocaleDateString(DATE_LOCALE);

export const formatDateTime = (
  value: string | number | Date,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
): string => new Date(value).toLocaleString(DATE_LOCALE, options);

export const formatTime = (
  value: string | number | Date,
  options: Intl.DateTimeFormatOptions = {},
): string => new Date(value).toLocaleTimeString(DATE_LOCALE, options);

export const locale = {
  appName: 'Customer loyalty',
  appTagline: 'إدارة المتجر',

  nav: {
    overview: 'نظرة عامة',
    customers: 'الزبائن',
    discounts: 'قواعد الخصم',
    reports: 'التقارير',
    capture: 'التقاط الفواتير',
    /* «بطاقات الولاء», matching the page title it opens. «البطاقات» alone was the
       one nav label in the rail that did not say what its screen says at the top. */
    cards: 'بطاقات الولاء',
    backup: 'النسخ الاحتياطي',
    modules: 'الوحدات',
    settings: 'الإعدادات',
    logout: 'تسجيل الخروج',
    /**
     * The word only — the number is rendered separately inside a `<bdi dir="ltr">`.
     *
     * It used to interpolate the version into the string, and `0.1.0-preview` came
     * out as `preview-0.1.0`: an isolate cannot be applied to a fragment of a plain
     * string, so the two have to be separate nodes.
     */
    version: 'الإصدار',
    collapseRail: 'طيّ القائمة',
    expandRail: 'توسيع القائمة',
  },

  /**
   * The notification bell.
   *
   * Every string here describes a condition the system can actually observe. There is
   * no «لديك 3 إشعارات» because there is no notification store — the count is the
   * number of standing warnings that are true right now, and the healthy answer is
   * zero.
   */
  /**
   * The update path.
   *
   * Three short lines. The merchant does not need to know what a release is, what was
   * fixed, or that anything was downloaded — only that a newer version is on his
   * machine and restarting will use it.
   */
  update: {
    ready: 'يتوفّر تحديث جديد للبرنامج، وقد تم تنزيله. سيُطبَّق عند إعادة التشغيل.',
    restart: 'إعادة التشغيل الآن',
    later: 'لاحقاً',
    installed: 'الإصدار المثبَّت',
  },

  alerts: {
    title: 'التنبيهات',
    label: (n: number) => (n === 0 ? 'التنبيهات — لا يوجد' : `التنبيهات — ${n}`),
    none: 'لا توجد تنبيهات. النسخ الاحتياطي والمساحة الحرة على ما يُرام.',
    backupKeyTitle: 'النسخ الاحتياطي متوقف',
    backupKeyFirstRun: 'لم يُؤكَّد مفتاح التشفير بعد — لا تعمل أي نسخة احتياطية',
    backupKeyReplaced: 'تم استبدال المفتاح ولم يُؤكَّد الجديد بعد',
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
    /* Shown only when a screen's own request failed and the server gave no sentence of
       its own. It said «تحقّق من الاتصال بالخادم» — the guess `BackendGate` exists to
       stop making: by the time a screen is rendering, the backend was answering. Reopening
       the program is what routes the person to the gate, which says what is actually
       wrong. */
    errorBody: 'تعذّر تحميل هذه الصفحة. اضغط «إعادة المحاولة»، وإذا تكرّر الأمر أغلق البرنامج وافتحه من جديد.',
    comingSoon: 'قيد التطوير',
    /* Beside a label, not as an asterisk — the asterisk needs a legend, and every
       form that uses one forgets to render it. */
    requiredMark: 'مطلوب',
    /* Under a field whose rule is only about the alphabet, which is the rule the
       merchant broke on install night. */
    latinOnlyHint: 'أحرف إنجليزية وأرقام فقط',

    /**
     * ── The three sentences that replace a browser's English ─────────────────
     *
     * Every screen renders `error.message` from whatever its mutation threw. When
     * that is an `ApiRequestError` the message is this product's own Arabic. When it
     * is anything else — a dropped connection, a reply that was not JSON — it is
     * whatever the browser said, in English, in a shop in Baghdad: «Failed to fetch»,
     * «Unexpected token < in JSON at position 0».
     *
     * Fixing that at each of the twelve call sites would fix it until the thirteenth.
     * `apiFetch` converts instead, so nothing but an Arabic sentence can leave the API
     * client, and the browser's own words go to the console where they are useful.
     */
    networkError: 'تعذّر الاتصال بالخادم. تأكّد من تشغيل جهاز المدير ومن اتصال الشبكة، ثم أعد المحاولة.',
    badResponse: 'وصل ردّ غير مفهوم من الخادم. أعد المحاولة، وإذا تكرّر الأمر أعد تشغيل الجهاز.',
    /* «افتح الإعدادات لتحديد جهاز المدير» sent a manager-PC user to set an address on
       the machine that is the server — and Settings is behind the login this state
       blocks. Reopening routes to `BackendGate`, which names the real state. */
    noServer: 'لم يتمكّن البرنامج من تحديد جهاز المدير. أغلق البرنامج وافتحه من جديد لعرض السبب.',
  },

  /**
   * The backend gate.
   *
   * Every string here answers one of three questions a merchant actually has when the
   * dashboard does not open: is it still coming up, has it given up, and what do I do.
   * `errorBody` in `common` — «تحقّق من الاتصال بالخادم» — answered none of them, and
   * was shown for a failure it never described. It stays only for genuine per-panel
   * fetch failures on a live backend; a backend that is down gets these instead.
   */
  backend: {
    startingTitle: 'جارٍ تشغيل البرنامج',
    startingBody: 'يستغرق التشغيل الأول بضع ثوانٍ. لا تُغلق النافذة.',

    failedTitle: 'تعذّر تشغيل البرنامج',
    /* Shown only when the backend left no explanation of its own. It says what is
       known — that it stopped — and does not invent a cause. */
    failedFallback: 'توقّف البرنامج ولم يترك سبباً مكتوباً.',

    terminalTitle: 'توقّف البرنامج ولن يُعيد المحاولة',
    terminalBody: 'تكرّر الخطأ نفسه عدّة مرّات، لذلك توقّفت المحاولات. عالِج السبب أدناه ثم أعد فتح البرنامج.',

    stoppedTitle: 'البرنامج متوقّف',
    /* «أعد فتح البرنامج» — reopening the dashboard does not start a Windows service.
       Restarting the machine does, and it is what `notRunningBody` already says. */
    stoppedBody: 'أعد تشغيل الجهاز — تبدأ الخدمة مع النظام تلقائياً.',

    unknownTitle: 'لا يمكن الوصول إلى البرنامج',
    unknownBody: 'البرنامج لا يستجيب ولم يترك سبباً. أعد تشغيل الجهاز، وإذا تكرّر الأمر تواصل مع الدعم الفني.',

    /**
     * ── No backend at all, which is different from a backend that failed ─────
     *
     * A machine that hosts the service and whose service is down needs "restart it".
     * A machine that hosts nothing — a second PC someone installed the dashboard on —
     * needs "tell me which machine to talk to", and telling *that* person to restart
     * a service sends them looking for something that was never installed.
     *
     * This is also the one screen in the product that may show an address field
     * outside Settings, because it is the one moment Settings cannot be reached: it
     * is behind the login, the login is behind a working backend, and there is none.
     */
    missingTitle: 'لم يُعثر على جهاز المدير',
    missingBody:
      'هذا الجهاز لا يشغّل خادم ولاء بنفسه، ولم يُحدَّد له عنوان جهاز المدير. أدخل عنوان جهاز المدير على شبكة المتجر أدناه.',

    /* ── The four states a machine that HOSTS the service can be in ────────────

       Split out of `missing*`, which used to answer for all of them with one
       sentence, one guess about the cause, and an address field.

       Every one of these is a manager PC. On a manager PC the address is not a
       question — the machine runs the service and works its own port out — so none of
       these screens carries a field, and every one of them names the remedy that
       actually resolves the state it describes. */

    /** `walaa.env` is gone. The service cannot start and no address can help. */
    configMissingTitle: 'إعدادات البرنامج مفقودة',
    configMissingBody:
      'البرنامج مثبّت على هذا الجهاز لكن ملف إعداداته غير موجود، ولذلك لا تعمل الخدمة. بيانات المتجر لم تتغيّر. لا يمكن حل هذا بإعادة التثبيت ولا بإدخال عنوان — تواصل مع الدعم الفني لاستعادة الملف.',

    /** Installed and configured, but nothing is listening. */
    notRunningTitle: 'خدمة ولاء متوقّفة على هذا الجهاز',
    notRunningBody:
      'البرنامج مثبّت وإعداداته موجودة، لكن الخدمة لا تعمل الآن. أعد تشغيل الجهاز — تبدأ الخدمة مع النظام تلقائياً. إذا تكرّر الأمر بعد إعادة التشغيل، تواصل مع الدعم الفني.',

    /** An address IS configured for another machine, and nothing answers there. */
    remoteUnreachableTitle: 'لا يمكن الوصول إلى جهاز المدير',
    remoteUnreachableBody:
      'العنوان المحفوظ لجهاز المدير لا يستجيب. تأكّد أن جهاز المدير يعمل وأنكما على نفس الشبكة، ثم أعد المحاولة أو صحّح العنوان أدناه.',

    /** Something answered there, and it is not this product. */
    remoteNotWalaaTitle: 'العنوان المحفوظ ليس خادم ولاء',
    remoteNotWalaaBody:
      'يوجد جهاز يستجيب على هذا العنوان لكنه ليس خادم ولاء. صحّح العنوان أدناه — الأرجح أن رقم المنفذ مختلف.',

    /** A walaa answered, at an incompatible version. */
    remoteVersionTitle: 'إصدار جهاز المدير مختلف',
    remoteVersionBody:
      'خادم ولاء على هذا العنوان بإصدار مختلف عن هذا الجهاز، ولا يمكنهما العمل معاً. حدّث الجهازين إلى نفس الإصدار.',

    reasonLabel: 'السبب',
    retry: 'إعادة المحاولة الآن',
    retrying: 'جارٍ إعادة المحاولة…',
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

    /**
     * The four ways pointing the app at a server can fail.
     *
     * They were previously three sentences and a status code, and two genuinely
     * different problems — "nothing is there" and "something is there but it is not
     * ولاء" — shared one message. A merchant who has typed his neighbour's printer
     * address and a merchant whose service has not started need different next moves,
     * so they are told different things.
     */
    errors: {
      /** Not a URL at all. */
      malformed: 'العنوان غير صالح. يجب أن يبدأ بـ http:// أو https:// ثم عنوان الجهاز.',
      /** Nothing answered: wrong address, wrong port, machine off, or firewall. */
      unreachable:
        'لا يوجد خادم على هذا العنوان. تأكّد من تشغيل جهاز المدير ومن رقم المنفذ، ومن أنّ الجهازين على الشبكة نفسها.',
      /** Something answered, but it is not this product. */
      notWalaa: 'يوجد خادم على هذا العنوان لكنّه ليس خادم ولاء. راجع العنوان ورقم المنفذ.',
      /** It is ولاء, at a version this dashboard cannot talk to. */
      versionMismatch: 'خادم ولاء على هذا العنوان بإصدار مختلف. حدّث الطرفين إلى الإصدار نفسه.',
      /** It is ولاء, but the demo one — which holds sample data, not the shop's. */
      demoServer: 'هذا العنوان يشير إلى النسخة التجريبية، وليس إلى خادم متجرك.',
    },
    connected: 'تم الاتصال بنجاح',
  },

  login: {
    /* ── V4-4: the reference's strip, carrying facts rather than marketing ── */
    /* The art column's headline. Says what this console IS — not a slogan about it,
       which is what the reference's «نظام ولاء العملاء المتكامل» is. */
    artHeadline: 'لوحة تحكم برنامج الولاء',
    stripReports: 'تقارير وتسويات',
    stripSecure: 'نسخ احتياطي مشفّر',
    /* The third cell used to print the server address. It is now a statement about
       the product rather than a technical detail about this installation — see the
       note further down for why nothing on this screen names a machine. */
    stripOffline: 'يعمل دون إنترنت',

    /* ── V4-4: the brand panel's real content, in place of marketing copy ── */
    tagline: 'لوحة تحكم برنامج الولاء — الزبائن، مستويات الخصم، التقارير والنسخ الاحتياطي.',
    greeting: 'مرحباً بك مجدداً',
    /* The card says what to DO. The panel beside it already says what this app IS,
       and rendering both showed the same sentence twice on one screen. */
    signInHint: 'أدخل بيانات حسابك للمتابعة إلى لوحة التحكم',
    title: 'تسجيل الدخول',
    subtitle: 'لوحة تحكم برنامج الولاء',
    username: 'اسم المستخدم',
    password: 'كلمة المرور',
    submit: 'دخول',
    submitting: 'جارٍ الدخول…',
    showPassword: 'إظهار كلمة المرور',
    hidePassword: 'إخفاء كلمة المرور',
    /** Shown when the credentials are valid but belong to another app entirely. */
    wrongApp: 'هذا الحساب ليس مخصّصاً للوحة التحكم',
    /**
     * ── What this screen no longer says ──────────────────────────────────────
     *
     * `changeServer` («تغيير الخادم»), `serverLabel` and `stripServer` are gone, with
     * the controls and the panel cell that carried them. A shop owner signing in has
     * no use for an address, a port or a button offering to change the server that is
     * working — and that button is precisely how he talks himself into believing the
     * product is broken. Server configuration now lives in Settings (`settings.server`
     * below) and in the recovery screen that appears when there genuinely is no
     * backend, which is the only moment an address is the actionable thing.
     */
    /** A failed sign-in says what to do, and never names a machine or a port. */
    failed: 'تعذّر تسجيل الدخول. تأكّد من اسم المستخدم وكلمة المرور ثم حاول مرّة أخرى.',
  },

  /**
   * Settings — where every technical control lives, off the daily path.
   *
   * ── The distinction this wording has to carry ────────────────────────────
   *
   * There are two machines in this product and they need opposite things said to
   * them. The MANAGER PC runs the service; it has nothing to configure and asking
   * it to would be inventing a question. A SECOND machine — another manager
   * workstation, or a PC beside the till — has to be told which machine to talk to.
   *
   * Conflating them is what produced a first-run address form on every install,
   * including the one that already knew the answer. So the two are separate
   * sections with separate headings, and the first one is a statement of fact
   * rather than a form.
   */
  settings: {
    /* ── Staff accounts ────────────────────────────────────────────────────

       The screen first run always said it was deferring to, and which did not
       exist: without it the Loyalty Station has no account and the shop cannot
       trade. */
    staff: {
      title: 'حسابات الدخول',
      subtitle: 'حساب محطة الولاء عند الصندوق، وأي مدير إضافي.',
      add: 'إضافة حساب',
      name: 'الاسم',
      username: 'اسم الدخول',
      password: 'كلمة المرور',
      passwordHint: '8 أحرف على الأقل — اكتبها وسلّمها لمن سيستخدم الحساب',
      roleLabel: 'نوع الحساب',
      roleHint:
        'المحطة: المسح والتسجيل والطباعة. برنامج الالتقاط: التقاط الفواتير من الصندوق فقط. المدير: التقارير والإعدادات.',
      role: {
        OWNER: 'مالك',
        MANAGER: 'مدير',
        STATION: 'محطة',
        AGENT: 'برنامج الالتقاط',
      } as Record<string, string>,
      branch: 'الفرع',
      branchHint: 'حسابا المحطة وبرنامج الالتقاط يعملان داخل فرع واحد — الفواتير تُنسب إليه.',
      branchRequired: 'اختر الفرع الذي يعمل فيه هذا الحساب',
      noBranch: 'بدون فرع',
      writeItDown:
        'اكتب كلمة المرور وسلّمها لمن سيستخدم الحساب. يمكنك تغييرها لاحقاً من هذه الشاشة — كلمة مرور المالك وحدها لا يمكن استعادتها.',
      submit: 'إنشاء الحساب',
      creating: 'جارٍ الإنشاء…',
      created: (username: string) => `تم إنشاء الحساب «${username}». سجّل الدخول به على الجهاز الذي سيستخدمه.`,
      disable: 'إيقاف',
      enable: 'تفعيل',
      disabled: 'تم إيقاف الحساب. أي جلسة مفتوحة به أُغلقت.',
      enabled: 'تم تفعيل الحساب.',
      ownerLocked: 'حساب المالك',
    },
    title: 'الإعدادات',
    subtitle: 'إعدادات الخادم والنسخ الاحتياطي — لا حاجة لتغييرها في التشغيل اليومي',

    server: {
      title: 'الخادم',

      /* The normal case: this machine hosts the service. */
      localTitle: 'خادم هذا الجهاز',
      localBody:
        'هذا الجهاز يشغّل خادم ولاء بنفسه. لا يحتاج إلى أي إعداد — يتعرّف البرنامج على الخادم تلقائياً عند كل تشغيل.',
      localRunning: 'يعمل الآن',
      localStopped: 'متوقّف',
      localUnknown: 'لم يُعثر على خادم على هذا الجهاز',
      localUnknownBody:
        'لم يتمكّن البرنامج من العثور على خدمة ولاء على هذا الجهاز. إذا كان هذا الجهاز هو جهاز المدير، أعد تشغيله؛ وإذا كان جهازاً ثانياً، اربطه بجهاز المدير من القسم أدناه.',
      /* The address the Loyalty Station tablet types in, on the shop's own network.
         Shown because somebody has to type it on the till — it is information the
         merchant needs, unlike the address of the machine he is already sitting at. */
      stationLabel: 'العنوان الذي تُدخله في جهاز نقطة الولاء',
      stationHint: 'افتح هذا العنوان من متصفّح الجهاز اللوحي المتّصل بشبكة المتجر نفسها',

      /* The second-machine case. */
      remoteTitle: 'الاتصال بجهاز مدير آخر',
      remoteBody:
        'استخدم هذا القسم فقط إذا كان هذا الجهاز ليس جهاز المدير، وتريد ربطه بجهاز المدير الموجود في المتجر.',
      remoteLabel: 'عنوان جهاز المدير',
      remotePlaceholder: 'http://192.168.1.10:4000',
      remoteHint: 'اسأل من ثبّت البرنامج عن هذا العنوان إن لم تكن تعرفه',
      remoteActive: 'هذا الجهاز متّصل حالياً بجهاز مدير آخر',
      test: 'اختبار وحفظ',
      testing: 'جارٍ الاختبار…',
      saved: 'تم الحفظ. أعد تشغيل البرنامج لتطبيق العنوان الجديد.',
      useLocal: 'العودة إلى خادم هذا الجهاز',
      useLocalDone: 'تمت العودة إلى خادم هذا الجهاز. أعد تشغيل البرنامج.',
    },

    /**
     * Google Drive.
     *
     * Almost nothing here describes a failure, because the API already writes the
     * failure sentences: it classifies no-network, a withdrawn grant, an expired
     * token, a full Drive and a wrong client separately, each with its own message and
     * its own remedy, and the panel renders those verbatim. Restating them here would
     * be a second copy to drift.
     *
     * What is left is the frame: the three states, the labels on the controls, and the
     * one sentence about scope a merchant deserves to read before granting anything.
     */
    drive: {
      title: 'النسخ الاحتياطي إلى Google Drive',
      stateConnected: 'متصل',
      stateNotConnected: 'غير متصل',
      stateNotConfigured: 'غير مُعدّ',
      lastSuccess: 'آخر نسخة ناجحة:',
      /* Said plainly, before he grants anything: this app cannot read his Drive. */
      scopeNote:
        'يطلب البرنامج صلاحية «drive.file» فقط — أي أنه لا يرى ولا يفتح أي ملف في حسابك عدا النسخ الاحتياطية التي ينشئها هو. لا يمكنه الاطلاع على بقية ملفاتك.',
      connect: 'ربط حساب Google',
      connecting: 'جارٍ فتح صفحة الموافقة…',
      consentOpened: 'فُتحت صفحة الموافقة في المتصفّح. أكمل الموافقة هناك ثم عد إلى هذه الشاشة.',
      connected: 'تم ربط الحساب بنجاح.',
      disconnect: 'فصل الحساب',
      disconnected: 'تم فصل الحساب. تستمر النسخ الاحتياطية على هذا الجهاز كالمعتاد.',
      keepLabel: 'عدد النسخ المحفوظة في Drive',
      keepHint: 'عند تجاوز هذا العدد تُحذف أقدم نسخة تلقائياً',
    },
  },

  /**
   * A customer's own invoices.
   *
   * This panel used to be an `EmptyState` reading «قيد التطوير» with an inline Arabic
   * sentence in the JSX — the only place in the shipped product that admitted to being
   * unfinished, and a §9 violation besides. §5 lists customer detail as "balance,
   * transactions, coupons", and a manager who opens a customer is nearly always asking
   * one of two things: what has this person spent, and did they get the discount they
   * were owed. A balance answers neither.
   */
  customerHistory: {
    title: 'فواتير هذا الزبون',
    subtitle: 'الأحدث أولاً',
    invoice: 'رقم الفاتورة',
    date: 'التاريخ',
    branch: 'الفرع',
    gross: 'قبل الخصم',
    discount: 'الخصم',
    net: 'المدفوع',
    voucher: 'القسيمة',
    noVoucher: '—',
    empty: 'لا توجد فواتير مسجّلة لهذا الزبون بعد.',
    emptyBody: 'تظهر هنا كل فاتورة تُربط ببطاقته، مع الخصم الذي حصل عليه.',
    truncated: 'تُعرض أحدث 100 فاتورة فقط.',
    statuses: {
      ISSUED: 'صادرة',
      REDEEMED: 'مستخدمة',
      VOID: 'ملغاة',
    } as Record<string, string>,
  },

  /**
   * First run.
   *
   * The shipped database has no accounts, deliberately — a template carrying a working
   * login would be the same password on every copy of this product. So the first screen
   * a merchant sees is not a login but this, and it appears exactly once.
   */
  firstRun: {
    tagline: 'الخطوة الأولى: تعريف المتجر وإنشاء حساب المالك.',
    title: 'إعداد المتجر لأول مرة',
    subtitle: 'لا يوجد حساب على هذا الجهاز بعد. أنشئ حساب المالك الآن — يستغرق دقيقة واحدة.',
    merchantName: 'اسم المتجر',
    merchantNameHint: 'كما يظهر في التقارير وعلى بطاقات الزبائن',
    /*
      ── Every hint here is a rule the merchant actually broke ────────────────

      He typed a branch code in Arabic and got «البيانات المرسلة غير صحيحة». The rule
      was known, was written down in the schema, and was shown to him only in a
      refusal that did not name it. A hint under the box costs one line and is read
      before the mistake rather than after.
    */
    allRequired: 'كل الحقول في هذه الصفحة مطلوبة.',
    branchName: 'اسم الفرع',
    branchNameHint: 'مثال: الفرع الرئيسي',
    branchCode: 'رمز الفرع',
    branchCodeHint: 'أحرف إنجليزية وأرقام وشرطة فقط — مثال: BAG-01. يُطبع على الفواتير.',
    ownerName: 'اسم المالك',
    ownerNameHint: 'الاسم الذي يظهر في سجل العمليات',
    username: 'اسم المستخدم للدخول',
    usernameHint: 'أحرف إنجليزية وأرقام فقط، بدون مسافات — مثال: owner',
    password: 'كلمة المرور',
    passwordHint: '10 أحرف على الأقل. اخترها بنفسك ولا تشاركها مع أحد.',
    passwordConfirm: 'تأكيد كلمة المرور',
    passwordMismatch: 'كلمتا المرور غير متطابقتين. أعد إدخالهما.',
    noResetTitle: 'لا توجد طريقة لاستعادة كلمة المرور',
    noResetBody:
      'هذا البرنامج يعمل داخل متجرك ولا يرسل بريداً ولا رسائل استعادة. إذا نسيت كلمة المرور فلا يمكن لأحد فتح الحساب — اكتبها في مكان آمن الآن.',
    submit: 'إنشاء الحساب والمتابعة',
    submitting: 'جارٍ الإنشاء…',
    created: 'تم إنشاء الحساب. سجّل الدخول الآن بالبيانات التي اخترتها.',
  },

  overview: {
    /* ── V4-4: the four headline figures §2.4 asks for ─────────────────── */
    kpiSales: 'المبيعات الملتقطة',
    /**
     * ── Two keys held in place, deliberately unused ────────────────────────
     *
     * `kpiSalesHint` and `kpiCustomersHint` packed four real figures — captured
     * invoices, average basket, new customers — into 13px grey sentences beneath a
     * 32px number, which is where a figure goes to be skipped. All four now have
     * their own cards in the Overview's activity band, at a weight somebody will
     * actually read, and repeating them in a caption above would be saying the same
     * number twice in two sizes.
     *
     * They stay defined rather than deleted because a locale key is a contract with
     * whatever else may be translating against this file; the numbers they carried
     * are all still on the screen.
     */
    kpiSalesHint: (invoices: number, average: number) =>
      `${group(invoices)} فاتورة · متوسط قيمة الفاتورة ${group(average)} د.ع`,
    kpiCustomersHint: (added: number) => `${group(added)} زبون جديد في هذه الفترة`,
    kpiDiscountsHint: 'ما مُنح للزبائن من مستويات الخصم',
    /**
     * `totalCustomers` counts every registered customer, not the ones who bought in
     * the selected window — the only figure on this screen the range control does
     * not move. Saying so is the difference between a tile that is understood and a
     * tile that looks broken when the range changes and it does not.
     */
    kpiCustomersNote: 'إجمالي المسجّلين في البرنامج، غير محدود بالفترة',
    title: 'نظرة عامة',
    subtitle: 'ملخّص أداء برنامج الولاء',
    kpiCustomers: 'الزبائن المسجّلون',
    kpiCaptured: 'فواتير ملتقطة',
    kpiAttributed: 'فواتير مرتبطة بزبون',
    kpiEnrolment: ATTRIBUTION_RATE_LABEL,
    kpiDiscounts: 'قيمة الخصومات الممنوحة',
    chartTitle: 'المبيعات الملتقطة عبر الوقت',
    chartEmpty: 'لا توجد فواتير ملتقطة في هذه الفترة',
    topCustomers: 'أفضل الزبائن',
    topCustomersEmpty: 'لم يسجّل أي زبون إنفاقاً في هذه الفترة',
    recent: 'أحدث الفواتير',
    unattributed: 'غير مرتبطة',
    attributionHint: 'الفواتير غير المرتبطة طبيعية — أغلب المتسوقين غير مسجّلين في البرنامج.',

    /* ── V4-4: the attribution split, drawn ──────────────────────────────── */
    refresh: 'تحديث البيانات',
    captureTrend: 'الالتقاط والارتباط يومياً',
    seriesCaptured: 'فواتير ملتقطة',
    seriesAttributed: 'مرتبطة بزبون',
    colDate: 'التاريخ',
    colNet: 'بعد الخصم',
    splitTitle: 'توزيع الفواتير الملتقطة',
    splitCentreLabel: ATTRIBUTION_RATE_LABEL,
    splitAttributed: 'مرتبطة بزبون',
    splitUnattributed: 'غير مرتبطة',
    splitInvoices: (n: number) => `${group(n)} فاتورة`,
    rankLabel: (n: number) => `المرتبة ${group(n)}`,

    /* ── The presentation rebuild (2026-09-05) ───────────────────────────── */

    /** From `dataUpdatedAt` on the query that is already running — not a new fetch. */
    lastUpdated: (time: string) => `آخر تحديث ${time}`,
    /**
     * The reference's primary action is «تصدير». This screen has no export endpoint,
     * and the screen that produces a report does. So the emerald button navigates
     * there rather than pretending to a capability that does not exist.
     */
    detailedReport: 'التقارير التفصيلية',

    /*
      The trend pill's wording, and it is the whole reason the pill is defensible.

      `/reports/overview` takes a window and no offset, so «عن الفترة السابقة» — what
      the reference writes — is a comparison the API cannot answer. What IS in the
      response is every day of the selected window, so the two halves of it can be
      compared honestly. The caption says exactly that, because a correctly computed
      number under a wrong label is still a wrong statement.
    */
    deltaCaption: 'مقارنةً بالنصف الأول من الفترة',
    /*
      **These return the numeric token ALONE, and the unit word travels separately.**

      Not a style choice — a bidi one, measured in the running app. `'+685.0٪ '` as a
      single string inside `dir="rtl"` paints as **`685.0٪+`**: `+` is bidi class ES,
      it has no European number before it to bind to, so it resolves to the paragraph
      direction and is laid out at the far end of the run. A sign printed after the
      percent sign is not a formatting blemish, it is a different statement — a reader
      scanning a row of pills cannot tell a rise from a fall.

      So the token goes inside a `<bdi dir="ltr">` in `DeltaPill`, which is the same
      remedy §12.25 applies to invoice numbers, and any Arabic unit word stays outside
      it in the RTL flow where it belongs.

      One decimal below 100 and none above it: at 685٪ the tenth is noise, and it is
      exactly the magnitude at which the extra glyphs start to crowd the pill.
    */
    deltaPct: (v: number) =>
      `${v > 0 ? '+' : v < 0 ? '-' : ''}${Math.abs(v) >= 100 ? Math.round(Math.abs(v)) : Math.abs(v).toFixed(1)}٪`,
    /** A rate moves in percentage POINTS. Reporting it in ٪ would compound a ratio. */
    deltaPoints: (v: number) =>
      `${v > 0 ? '+' : v < 0 ? '-' : ''}${Math.abs(v) >= 100 ? Math.round(Math.abs(v)) : Math.abs(v).toFixed(1)}`,
    deltaPointsUnit: 'نقطة',

    sectionAnalytics: 'التحليلات',
    sectionActivity: 'مؤشرات النشاط',

    chartSubtitle: 'قيمة الفواتير الملتقطة لكل يوم',
    splitSubtitle: 'كم منها بلغ زبوناً مسجّلاً',
    captureTrendSubtitle: 'عدد الفواتير يومياً، وما ارتبط منها بزبون',
    topCustomersSubtitle: 'الأعلى إنفاقاً خلال الفترة المحددة',
    recentSubtitle: 'آخر عشر فواتير التقطها النظام',

    /* «متوسط قيمة الفاتورة», the name `locale.reports` already gave this field.
       It is capturedSales ÷ capturedInvoices — the mean INVOICE, and «سلة
       المشتريات» was the reference's word for it, not the model's. */
    miniBasket: 'متوسط قيمة الفاتورة',
    miniNew: 'زبائن جدد',
    miniNewCaption: 'خلال الفترة المحددة',
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
    colRuleCap: 'حد أقصى لهذا المستوى',
    colRuleCapHint: 'اتركه فارغاً ليطبَّق الحد الأقصى العام',
    assessmentDiscount: 'الخصم عند هذه القيمة:',
    assessmentProfit: 'الربح الصافي التقديري:',
    assessmentSafe: (min: number, max: number) => `ضمن النطاق الآمن (${min}–${max}٪).`,
    inactiveRule: 'غير مفعّلة',
    inactiveRuleHint:
      'هذا المستوى مخزّن كغير مفعّل، فلا يطبّقها المحرّك. لا يمكن إنشاء هذه الحالة من هذه الشاشة — تواصل مع الدعم الفني.',
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
    /* It said «خارج نطاق الإصدار الحالي — يُثبّت المطوّر التحديثات يدوياً». Signed
       updates ship in this release (packaging/SIGNING.md), so the sentence was false —
       and it matters, because it is what a merchant reads when a restart installs
       something. This is what `UpdateNotice` actually does. */
    autoUpdateHint:
      'يعمل دائماً: يُفحص عند فتح البرنامج، ويُنزَّل التحديث الموقَّع في الخلفية، ويُثبَّت عند إغلاق البرنامج وفتحه من جديد.',
    autoUpdateLocked: 'مفعّل دائماً',
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
    /*
      These were constants — «الوكيل غير مثبّت بعد — يُبنى في مرحلة لاحقة» — shown on every
      installation whatever was happening. The agent exists, and the screen now says what
      the captures themselves say.
    */
    captureNever: 'لم تصل أي فاتورة من برنامج الالتقاط بعد',
    captureNeverHint:
      'ثبّت برنامج الالتقاط على جهاز الصندوق، وأنشئ له حساباً من نوع «برنامج الالتقاط» من «الإعدادات ← حسابات الدخول»، ثم اطبع فاتورة من الصندوق. تظهر هنا خلال ثوانٍ.',
    captureStale: 'لم تصل فواتير من الصندوق منذ أكثر من يوم',
    captureStaleHint: (at: string) =>
      `آخر فاتورة وصلت: ${at}. إن كان المتجر يبيع اليوم، فتأكّد أن جهاز الصندوق يعمل وأن برنامج الالتقاط شغّال عليه.`,
    captureLive: (count: number) => `وصلت ${count} فاتورة من الصندوق خلال آخر 24 ساعة`,
    captureLiveHint: (at: string) => `آخر فاتورة وصلت: ${at}.`,
    calibrationUnavailable: 'المعايرة من هذه الشاشة غير متاحة في هذا الإصدار.',
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
      'يصل التغيير إلى المحطة عند تحديث جلستها (خلال 15 دقيقة تقريباً) أو عند إعادة تسجيل الدخول.',
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
    scheduleHint: 'يومياً بعد الإغلاق، وبعد كل 500 عملية.',
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
    attributionRate: ATTRIBUTION_RATE_LABEL,
    averageBasket: 'متوسط قيمة الفاتورة',

    /* ── Breakdowns ──────────────────────────────────────────────────────── */

    categoryTitle: 'توزيع الزبائن حسب الفئة',
    categoryEmpty: 'لا يوجد زبائن مسجّلون بعد',
    tierTitle: 'توزيع الفواتير على مستويات الخصم',
    tierSubtitle: 'عدد الفواتير التي بلغت كل مستوى خلال الفترة المختارة',
    tierEmpty: 'لم تُحدَّد مستويات خصم بعد',
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
    /**
     * **Was «بلغوه» — a v3 word over v4 numbers.**
     *
     * Under v3 this column counted CUSTOMERS who had climbed to each tier, and
     * "they reached it" was the right heading. v4 counts INVOICES that landed in
     * each level (§10.6, `bracketPerformance.invoiceCount`), and the cells beside
     * this heading already read «N فاتورة». A column head naming people over a
     * column of invoices is not a wording preference, it is the table stating the
     * wrong unit.
     */
    tierColReached: 'عدد الفواتير',

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
    unknownBody: 'لم يستطع البرنامج قياس المساحة الفارغة على هذا الجهاز. التسجيل مستمر، لكن لن يصلك تنبيه إذا امتلأ القرص — تواصل مع الدعم الفني.',
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
