/**
 * The operator's walkthrough (operator request, 2026-09-02).
 *
 * Reachable from the login screen, before anyone is signed in, because that is the
 * one moment a new operator is stuck with nothing else to look at.
 *
 * ── What this is, and what it must never become ────────────────────────────
 *
 * It is **reading matter**. Five screens, no controls but next and back, nothing
 * that changes any state. §6.4 forbids a settings screen anywhere in this app, and a
 * help section is exactly where one arrives first — as "just a link to the server
 * address", then "just a way to re-pair the scanner". There is no such link here and
 * none should be added: the way to change anything is the manager app, behind
 * manager authentication.
 *
 * ── Who it is written for ──────────────────────────────────────────────────
 *
 * A cashier, not a developer. So: no field names, no endpoints, no words like
 * "sync", "queue" or "token". Each line is something the reader can do or something
 * they will see, and the two-minute learnability §6.4 asks for is the target for the
 * whole document, not for one screen of it.
 *
 * The copy lives here rather than in JSX so it can be reviewed as copy (CLAUDE.md
 * §9) — the wording of what a station operator is told about a failed sale is not a
 * detail, and it should be readable in one place without hunting through markup.
 */

export interface GuidePage {
  /** Which lucide icon the page shows. Named, so the component maps it. */
  icon: 'login' | 'steps' | 'outcomes' | 'register' | 'connection';
  title: string;
  /** One sentence under the title, setting up what follows. */
  intro: string;
  sections: ReadonlyArray<{
    /** Omitted when the page is a single flat list. */
    heading?: string;
    items: readonly string[];
  }>;
}

export const GUIDE_PAGES: readonly GuidePage[] = [
  {
    icon: 'login',
    title: 'تسجيل الدخول',
    intro: 'حساب المحطة تستلمه من الإدارة، ويُستخدم على هذا الجهاز فقط.',
    sections: [
      {
        items: [
          'أدخل اسم المستخدم وكلمة المرور، ثم اضغط «دخول».',
          'حساب المدير لا يعمل هنا — هذه الشاشة لحساب المحطة وحده.',
          'إن نسيت كلمة المرور أو تغيّرت، راجع الإدارة. لا تُغيَّر من هذا الجهاز.',
          'اضغط زر الخروج (أعلى الشاشة) في نهاية الدوام.',
        ],
      },
    ],
  },

  {
    icon: 'steps',
    title: 'خطوتان: البطاقة أولاً، ثم الفاتورة',
    intro: 'هذا الترتيب ثابت ولا يتغيّر. البطاقة بيد الزبون، والفاتورة عند الكاشير.',
    sections: [
      {
        heading: 'الخطوة 1 — بطاقة الزبون',
        items: [
          'امسح بطاقة الزبون بالقارئ.',
          'أو اكتب رقم البطاقة واضغط Enter إن لم تُقرأ.',
        ],
      },
      {
        heading: 'الخطوة 2 — الفاتورة',
        items: [
          'يظهر اسم الزبون أعلى الشاشة — تأكّد أنه الشخص الواقف أمامك.',
          'امسح الباركود المطبوع على الفاتورة.',
          'إن لم يُقرأ الباركود، اكتب رقم الفاتورة يدوياً.',
          'أو اضغط «استخدم هذه الفاتورة» بعد مطابقة الرقم والمبلغ مع الورقة بيدك.',
          'إن كان الزبون خاطئاً، اضغط «تغيير الزبون» وابدأ من جديد.',
        ],
      },
    ],
  },

  {
    icon: 'outcomes',
    title: 'ماذا تعني كل نتيجة',
    intro: 'خمس نتائج فقط، ولكلٍّ منها إجراء واحد واضح.',
    sections: [
      {
        items: [
          'استحق الخصم — تظهر معاينة القسيمة. اضغط «طباعة القسيمة» وسلّمها للزبون ليعطيها الكاشير.',
          'لم تبلغ الفاتورة شريحة الخصم — المشتريات سُجّلت، ولا توجد قسيمة لهذه الفاتورة. اقرأ للزبون الجملة المعروضة: تخبره بقيمة الفاتورة التي تستحق خصماً.',
          'بطاقة غير معروفة — البطاقة غير مسجّلة. اضغط «تسجيل زبون جديد».',
          'بطاقة مفقودة أو مستبدلة أو متلَفة — لا تُعِد المسح، فالمسح لن يفيد. اضغط «بحث عن الزبون».',
          'لا توجد فاتورة بانتظار الربط — اطلب من الكاشير طباعة الفاتورة، ثم امسح الباركود عليها.',
        ],
      },
    ],
  },

  {
    icon: 'register',
    title: 'زبون جديد، وبطاقة بديلة',
    intro: 'التسجيل يستغرق أقل من دقيقة، والبطاقة البديلة تحفظ رصيد الزبون كاملاً.',
    sections: [
      {
        heading: 'تسجيل زبون جديد',
        items: [
          'اضغط «تسجيل زبون جديد» عند ظهور بطاقة غير معروفة.',
          'أدخل الاسم ورقم الهاتف فقط — لا شيء غير ذلك.',
          'امسح البطاقة الجاهزة التي ستسلّمها له.',
          'إن لم تتوفّر بطاقة جاهزة، اطبع بطاقة ورقية بدلاً منها.',
        ],
      },
      {
        heading: 'بطاقة مفقودة',
        items: [
          'اضغط زر «بحث» أعلى الشاشة، وابحث بالاسم أو رقم الهاتف.',
          '«الإبلاغ عن فقدان البطاقة» يوقف البطاقة القديمة فوراً.',
          '«إصدار بطاقة بديلة» يسلّمه بطاقة جديدة — ويبقى رصيده وسجلّه كما هو.',
        ],
      },
    ],
  },

  {
    icon: 'connection',
    title: 'حالة الاتصال',
    intro: 'العلامة الملوّنة أعلى الشاشة تخبرك بحالة الجهاز في كل لحظة.',
    sections: [
      {
        items: [
          'متصل (أخضر) — كل عملية تُسجَّل فوراً.',
          'قيد المزامنة (أصفر) — هناك عمليات بانتظار الإرسال، وسترسل وحدها.',
          'غير متصل (أحمر) — مشتريات الزبون ستُحسب عند عودة الاتصال، ولكن لا توجد قسيمة خصم لتلك الفاتورة. أخبر الزبون بذلك.',
        ],
      },
      {
        heading: 'رسالة واحدة تستدعي الإدارة',
        items: [
          '«لم تُحفظ العملية» تعني أن العملية لم تُسجَّل ولن تُسجَّل لاحقاً.',
          'الانتظار لا يصلحها، وإعادة المسح لا تفيد.',
          'أبلغ الإدارة فوراً — المشكلة في الخادم وليست في هذا الجهاز.',
        ],
      },
    ],
  },
];
