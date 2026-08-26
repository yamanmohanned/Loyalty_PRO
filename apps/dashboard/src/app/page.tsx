import { formatIqd } from '@walaa/shared-types';
import { locale } from '@/lib/locale';

/**
 * Phase 0 foundation smoke screen.
 *
 * Deliberately not a real dashboard — it exists to prove the scaffold end to end:
 * RTL direction, the Arabic font stack, the Deep Teal accent, monospace money, and
 * a live import from `@walaa/shared-types`. Phase 2 replaces this file entirely
 * with the Overview screen from the Stitch designs.
 */

const TIERS = [
  { threshold: 100_000, discount: 5 },
  { threshold: 250_000, discount: 10 },
  { threshold: 500_000, discount: 15 },
];

export default function FoundationPage() {
  return (
    <main className="mx-auto min-h-[100dvh] max-w-3xl px-4 py-10">
      <header className="border-b border-border pb-6">
        <p className="text-sm text-steel">{locale.appTagline}</p>
        <h1 className="mt-1 text-3xl font-bold">{locale.appName}</h1>
        <p className="mt-3 text-base text-steel">
          الأساس جاهز — قاعدة البيانات، العقود المشتركة، ونظام التصميم.
        </p>
      </header>

      <section className="mt-8">
        <h2 className="text-xl font-semibold">مستويات الولاء الافتراضية</h2>
        <ul className="mt-4 divide-y divide-border rounded-lg border border-border bg-surface">
          {TIERS.map((tier) => (
            <li key={tier.threshold} className="flex items-center justify-between px-6 py-4">
              <span className="amount text-lg">{formatIqd(tier.threshold)}</span>
              <span className="rounded-pill bg-accent-tint px-3 py-1 text-sm font-medium text-accent">
                خصم {tier.discount}٪
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm text-steel">
          المبالغ معروضة بخط أحادي المسافة لمحاذاة الأرقام — والنسب بلون العلامة الوحيد.
        </p>
      </section>

      <section className="mt-8 rounded-lg border border-border bg-surface p-6 shadow-card">
        <h2 className="text-lg font-semibold">التحقق من الاتجاه</h2>
        <p className="mt-2 text-base text-steel">
          هذا النص محاذٍ لليمين، والصفحة كاملة باتجاه RTL من جذر المستند — وليس كتعديل
          لاحق على كل شاشة.
        </p>
      </section>
    </main>
  );
}
