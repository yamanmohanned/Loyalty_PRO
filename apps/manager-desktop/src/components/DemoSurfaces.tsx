import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { FlaskConical, Info, RotateCcw } from 'lucide-react';
import { api } from '../lib/api';
import { demoText } from '../lib/locale.demo';
import { DEMO_NOTICE_DISMISSED_KEY } from '../lib/demo';
import { Button, Card, CardHeader, cn, Notice } from './ui';

/**
 * Everything the demo build adds to the UI, in one file.
 *
 * Gathered here rather than sprinkled through the screens for one reason: it makes
 * "what does demo mode change?" answerable by opening a file, and it makes deleting
 * demo mode a matter of deleting a file plus its call sites.
 *
 * ── Nothing here checks `IS_DEMO`, and that is deliberate ────────────────────
 *
 * The first version guarded each component with `if (!IS_DEMO) return null`. That is a
 * RUNTIME check: the component stays exported, stays imported, stays called, and every
 * string it renders stays in the bundle. `verify-demo-isolation.mjs` found all four
 * demo markers in the production build and the isolation claim was simply false.
 *
 * The guard belongs at the CALL SITE — `{IS_DEMO && <DemoBadge />}`. `IS_DEMO` is a
 * compile-time literal, so that folds to `false`, the reference disappears, this module
 * becomes unreferenced, and Rollup drops it whole along with `locale.demo.ts`. The
 * verifier is what proves it, on every build.
 */

/** The quiet marker in the rail. Never red — this is not a warning. */
export function DemoBadge({ collapsed }: { collapsed: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-pill bg-accent-tint font-medium text-accent',
        collapsed ? 'justify-center px-1.5 py-1' : 'px-2.5 py-1 text-xs',
      )}
      title={demoText.badge}
    >
      <FlaskConical size={13} aria-hidden />
      {collapsed ? null : demoText.badge}
    </span>
  );
}

/**
 * The welcome line — once, on the first launch, then never again.
 *
 * Dismissal is remembered in `localStorage`, which is per machine and survives
 * restarts. Not modal and not blocking: the brief asks for one line he can wave away,
 * and a dialog in front of a product somebody is seeing for the first time is a dialog
 * they dismiss without reading.
 */
export function DemoWelcome() {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return window.localStorage.getItem(DEMO_NOTICE_DISMISSED_KEY) === '1';
    } catch {
      // A locked-down profile can throw on storage access. Showing the line every
      // launch is a far smaller failure than white-screening on it.
      return false;
    }
  });

  if (dismissed) return null;

  return (
    <div className="border-b border-border bg-accent-tint/50 px-8 py-3">
      <div className="mx-auto flex max-w-content items-start gap-3">
        <Info size={18} className="mt-0.5 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink">{demoText.noticeTitle}</p>
          <p className="mt-0.5 text-sm leading-relaxed text-ink/80">{demoText.noticeBody}</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setDismissed(true);
            try {
              window.localStorage.setItem(DEMO_NOTICE_DISMISSED_KEY, '1');
            } catch {
              /* Dismissed for this session at least. */
            }
          }}
          className="shrink-0 rounded-md border border-accent/40 px-3 py-1.5 text-sm font-semibold text-accent transition-colors duration-fast hover:bg-accent-tint"
        >
          {demoText.noticeDismiss}
        </button>
      </div>
    </div>
  );
}

/**
 * A hardware-dependent surface, in the demo.
 *
 * **Not an error, and that distinction is the whole reason this component exists.**
 * The capture agent, the barcode scanner and the slip printer are all absent on a
 * laptop, and every one of those screens would otherwise render its genuine
 * "disconnected" state — which is red, correctly, because on a real till it means the
 * shop has stopped capturing sales. Shown to a merchant evaluating the product it
 * means only that he has no till. So the demo states it as a fact about the demo.
 */
export function DemoHardwareNotice({ className }: { className?: string }) {
  return (
    <div className={className}>
      <Notice tone="accent" title={demoText.hardwareTitle}>
        {demoText.hardwareBody}
      </Notice>
    </div>
  );
}

/**
 * «إعادة تعيين البيانات التجريبية».
 *
 * The demo is meant to be clicked around, and clicking around is destructive: he can
 * retire a discount level, redeem every voucher, void a card batch. Without this he
 * can reach a state he cannot get out of, and the demo becomes evidence that the
 * product is fragile.
 *
 * It rebuilds six months through the real services, so it takes around half a minute.
 * The button says so before it starts rather than appearing to hang.
 */
export function DemoResetCard() {
  const [done, setDone] = useState(false);

  const reset = useMutation({
    mutationFn: () => api.post<{ invoices: number }>('/system/demo/reset', {}),
    onSuccess: () => {
      setDone(true);
      // A full reload rather than invalidating caches one by one: every screen's data
      // was just replaced, and half-refreshed screens showing a mix of the old shop
      // and the new one is the confusing outcome this control exists to prevent.
      setTimeout(() => window.location.reload(), 1200);
    },
  });

  return (
    <Card>
      <CardHeader title={demoText.resetTitle} />
      <div className="space-y-4 p-6">
        <p className="text-sm leading-relaxed text-steel">{demoText.resetBody}</p>
        {reset.isPending ? <Notice tone="neutral">{demoText.resetRunning}</Notice> : null}
        {done ? <Notice tone="accent">{demoText.resetDone}</Notice> : null}
        {reset.isError ? <Notice tone="danger">{demoText.resetFailed}</Notice> : null}
        <Button
          variant="secondary"
          onClick={() => reset.mutate()}
          disabled={reset.isPending || done}
        >
          <RotateCcw
            size={18}
            aria-hidden
            className={cn(reset.isPending && 'motion-safe:animate-spin')}
          />
          {reset.isPending ? demoText.resetRunning : demoText.reset}
        </Button>
      </div>
    </Card>
  );
}
