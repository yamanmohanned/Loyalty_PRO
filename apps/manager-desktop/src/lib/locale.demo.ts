/**
 * Demo-mode copy, in its own module — and the separation is load-bearing.
 *
 * These strings started in `locale.ts` beside every other screen's copy, which is
 * where §9 says UI text belongs. `verify-demo-isolation.mjs` then found all four of
 * them in the PRODUCTION bundle: `locale` is one object literal that the whole app
 * reaches into, so nothing in it can ever be tree-shaken, no matter which branch reads
 * a given key. The strings were shipping to merchants who would never see them, and —
 * worse — they were evidence that the demo branches had shipped too.
 *
 * A separate module that only `DemoSurfaces.tsx` imports can be dropped whole once
 * that file's call sites fold away. It is still a centralised locale file; it is just
 * scoped to the build that uses it.
 *
 * Calm, never alarming. The merchant is looking at his own future product for the
 * first time; a red banner shouting that nothing is real would teach him to distrust
 * what he is seeing.
 */
export const demoText = {
    badge: 'نسخة تجريبية',
    noticeTitle: 'أهلاً بك في النسخة التجريبية',
    noticeBody:
      'كل الأرقام والأسماء هنا بيانات تجريبية لعرض شكل البرنامج وطريقة عمله — وليست بيانات متجرك. تصفّح كما تحب، لا شيء هنا يمكن أن يتلف.',
    noticeDismiss: 'فهمت',
    /* Hardware the demo has no access to. Stated as a fact about the demo, never as a
       fault: «غير متصل» alone reads as something broken that he should fix. */
    hardwareTitle: 'غير متاح في النسخة التجريبية',
    hardwareBody:
      'يتطلب هذا الجزء اتصالاً بجهاز الصندوق أو بالطابعة. في النسخة الكاملة يعمل تلقائياً بعد التركيب في المتجر.',
    resetTitle: 'البيانات التجريبية',
    resetBody:
      'يمكنك تعديل القواعد وتجربة كل شيء بحرية. إذا أردت العودة إلى البيانات كما كانت في البداية، اضغط هنا.',
    reset: 'إعادة تعيين البيانات التجريبية',
    resetRunning: 'جارٍ إعادة التعيين… قد يستغرق نصف دقيقة',
    resetDone: 'تمت إعادة التعيين — عادت البيانات كما كانت.',
    resetFailed: 'تعذّرت إعادة التعيين. أعد تشغيل البرنامج وحاول مجدداً.',
  } as const;
