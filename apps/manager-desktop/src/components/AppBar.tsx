import { useEffect, useRef, useState } from 'react';
import { AlertOctagon, AlertTriangle, Bell, PanelRight, ShieldAlert } from 'lucide-react';
import type { KeyStatus, StorageStatus } from '@walaa/shared-types';
import { locale } from '../lib/locale';
import { IS_DEMO } from '../lib/demo';
import { cn } from './ui';

/**
 * The application bar.
 *
 * **It carries exactly two controls, and that is the whole specification.** The
 * reference's top bar also holds a global search, a theme toggle and a profile menu;
 * search has no command surface behind it yet, the palette has no dark variants at
 * all, and the profile already lives at the foot of the rail. A control that cannot
 * do what its icon promises is worse than an absent one, so those three are not here.
 */

/* ── Alerts ───────────────────────────────────────────────────────────────── */

export interface Alert {
  id: string;
  tone: 'danger' | 'warning';
  title: string;
  body: string;
  /** Where the merchant goes to act on it. */
  route: string;
}

/**
 * The badge count, derived from conditions the shell is ALREADY watching.
 *
 * No new request and no new state: `useStorageStatus` and `useKeyStatus` are both
 * running in `Shell` because the two standing banners need them, and this reads the
 * same two answers. A notification count assembled from anything else would be a
 * number nobody could trace back to a fact.
 *
 * **Deliberately not "3".** The reference draws a badge with a hardcoded three in it.
 * Here the count is the number of conditions currently true, and on a healthy
 * installation that is zero — a bell with nothing behind it is the correct state and
 * the panel says so in words.
 *
 * The capture agent's health is the obvious third source and is **not** included:
 * `AGENT_STATUS` arrives only as a realtime event, so before the first event lands
 * there is nothing to read, and a badge that silently under-reports until something
 * happens is worse than one that never mentions the agent at all.
 */
export function collectAlerts(
  storage: StorageStatus | undefined,
  key: KeyStatus | undefined,
): Alert[] {
  const alerts: Alert[] = [];

  if (storage && storage.level !== 'OK') {
    alerts.push({
      id: 'storage',
      tone: storage.level === 'CRITICAL' ? 'danger' : 'warning',
      title:
        storage.level === 'CRITICAL'
          ? locale.storage.criticalTitle
          : storage.level === 'UNKNOWN'
            ? locale.storage.unknownTitle
            : locale.storage.warnTitle,
      body: storage.path,
      route: '/backup',
    });
  }

  // Not in the demo: the backup key genuinely is unconfirmed, and on a demo laptop
  // that is neither news nor actionable. A bell that reads «1» on first launch teaches
  // the merchant that this product arrives with problems.
  if (key && !key.backupsEnabled && !IS_DEMO) {
    alerts.push({
      id: 'backup-key',
      tone: 'danger',
      title: locale.alerts.backupKeyTitle,
      body: key.everConfirmed ? locale.alerts.backupKeyReplaced : locale.alerts.backupKeyFirstRun,
      route: '/backup',
    });
  }

  return alerts;
}

/* ── The bar ──────────────────────────────────────────────────────────────── */

export function AppBar({
  railCollapsed,
  onToggleRail,
  alerts,
  onOpenAlert,
}: {
  railCollapsed: boolean;
  onToggleRail: () => void;
  alerts: readonly Alert[];
  onOpenAlert: (route: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape and an outside click both close it. A popover that can only be dismissed
  // by hitting the same small button again is a trap on a touch screen.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const toggleLabel = railCollapsed ? locale.nav.expandRail : locale.nav.collapseRail;

  return (
    <div className="flex items-center justify-between gap-3 border-b border-border bg-surface/70 px-8 py-2">
      {/* The toggle sits beside the rail it controls — the START edge under RTL. The
          reference puts its hamburger at the far end of the bar, which is the LTR
          habit: there the menu is on the left and so is the control. */}
      <button
        type="button"
        onClick={onToggleRail}
        title={toggleLabel}
        aria-label={toggleLabel}
        aria-expanded={!railCollapsed}
        className="flex size-9 items-center justify-center rounded-md text-steel transition-colors duration-fast hover:bg-canvas hover:text-ink"
      >
        <PanelRight size={18} aria-hidden />
      </button>

      <div className="relative" ref={panelRef}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={locale.alerts.label(alerts.length)}
          title={locale.alerts.label(alerts.length)}
          className="relative flex size-9 items-center justify-center rounded-md text-steel transition-colors duration-fast hover:bg-canvas hover:text-ink"
        >
          <Bell size={18} aria-hidden />
          {alerts.length > 0 ? (
            /* The count is announced through the button's own `aria-label`, so the
               badge itself is decoration and is hidden from the tree rather than
               read out as a stray digit. */
            <span
              aria-hidden
              className="absolute -top-0.5 end-0 flex min-w-[1.05rem] items-center justify-center rounded-pill bg-danger px-1 text-[11px] font-bold leading-[1.05rem] text-white"
            >
              {alerts.length}
            </span>
          ) : null}
        </button>

        {open ? (
          <div className="absolute end-0 top-11 z-30 w-80 overflow-hidden rounded-card border border-border bg-surface shadow-raised">
            <p className="border-b border-border px-4 py-3 text-sm font-semibold text-ink">
              {locale.alerts.title}
            </p>
            {alerts.length === 0 ? (
              <div className="flex items-start gap-3 px-4 py-5">
                <ShieldAlert size={18} className="mt-0.5 shrink-0 text-success" aria-hidden />
                <p className="text-sm leading-relaxed text-steel">{locale.alerts.none}</p>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {alerts.map((alert) => {
                  const Icon = alert.tone === 'danger' ? AlertOctagon : AlertTriangle;
                  return (
                    <li key={alert.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setOpen(false);
                          onOpenAlert(alert.route);
                        }}
                        className="flex w-full items-start gap-3 px-4 py-3 text-start transition-colors duration-fast hover:bg-canvas"
                      >
                        <Icon
                          size={18}
                          aria-hidden
                          className={cn(
                            'mt-0.5 shrink-0',
                            alert.tone === 'danger' ? 'text-danger' : 'text-amber',
                          )}
                        />
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-ink">{alert.title}</span>
                          <span className="mt-0.5 block truncate text-xs text-steel">
                            {alert.body}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
