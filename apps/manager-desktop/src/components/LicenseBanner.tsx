import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertOctagon, AlertTriangle } from 'lucide-react';
import type { LicenseState } from '@walaa/shared-types';
import { api } from '../lib/api';
import { formatDate, locale } from '../lib/locale';
import { onRealtimeConnect } from '../lib/realtime';
import { buttonClass, cn } from './ui';

/**
 * The licence, as the shell shows it (packaging/LICENSING.md).
 *
 * The screen decides nothing here. The service evaluates the licence — in Rust, on every
 * sale — and this reads the verdict so the manager learns it from the screen rather
 * than from a refused scan at the till.
 *
 * ── Escalation: days out, not hours ─────────────────────────────────────────
 *
 * The service grades every state (`warning`), and each grade has one place:
 *
 *   notice   two weeks out   — the bell
 *   warning  one week out    — a countdown chip in the top bar of every screen
 *   urgent   three days out, every read-only state, every grace day
 *                             — a red banner on every screen, undismissible
 *
 * **Undismissible**, like the storage and backup banners. A banner the manager can close
 * is one they close, and the condition stays.
 */

export const LICENSE_QUERY_KEY = ['license'] as const;

export function useLicense() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: LICENSE_QUERY_KEY,
    queryFn: () => api.get<LicenseState>('/license'),
    staleTime: 60_000,
    // A trial turns into grace, and grace into read-only, with nobody pressing anything.
    // A dashboard left open on a back-office monitor must notice within minutes.
    refetchInterval: 10 * 60_000,
  });

  useEffect(
    () => onRealtimeConnect(() => void queryClient.invalidateQueries({ queryKey: LICENSE_QUERY_KEY })),
    [queryClient],
  );

  return query;
}

export interface LicenseNotice {
  title: string;
  body: string;
  tone: 'danger' | 'amber';
}

const days = (n: number | null): string => locale.license.days(Math.max(1, n ?? 1));
const date = (value: string | null): string => (value ? formatDate(value) : '—');

/** The banner's sentence: for every urgent or read-only state, and a failing check. */
export function licenseNotice(state: LicenseState): LicenseNotice | null {
  const t = locale.license;
  if (state.degraded) {
    return {
      title: t.degradedTitle,
      body: state.readOnly ? `${t.degradedBody} ${t.readOnlyBody}` : t.degradedBody,
      tone: state.readOnly ? 'danger' : 'amber',
    };
  }
  switch (state.status) {
    case 'UNLICENSED':
      return { title: t.unlicensedTitle, body: t.readOnlyBody, tone: 'danger' };
    case 'EXPIRED':
      return { title: t.expiredTitle, body: t.readOnlyBody, tone: 'danger' };
    case 'TAMPERED':
      return {
        title: t.tamperedTitle,
        body: state.storedLicenseInvalid
          ? t.tamperedCodeBody
          : t.tamperedClockBody(t.minutes(state.clockBehindMinutes ?? 0)),
        tone: 'danger',
      };
    case 'GRACE':
      return {
        title: t.graceTitle,
        body: state.basis === 'emergency' ? t.graceEmergencyBody(date(state.graceEndsAt)) : t.graceBody(date(state.graceEndsAt)),
        tone: 'danger',
      };
    case 'EMERGENCY':
      return {
        title: t.emergencyTitle(date(state.expiresAt)),
        body: t.emergencyBody,
        tone: state.warning === 'urgent' ? 'danger' : 'amber',
      };
    case 'TRIAL':
      return state.warning === 'urgent'
        ? { title: t.trialUrgentTitle(days(state.daysLeft)), body: t.trialUrgentBody, tone: 'danger' }
        : null;
    case 'PERPETUAL':
      return null;
  }
}

/** What the bell lists: the banner's sentence, or — two weeks out — a quieter notice. */
export function licenseAlert(state: LicenseState): LicenseNotice | null {
  const notice = licenseNotice(state);
  if (notice) return notice;
  if (state.status === 'TRIAL' && state.warning !== 'none') {
    return {
      title: locale.license.trialUrgentTitle(days(state.daysLeft)),
      body: locale.license.trialNoticeBody,
      tone: 'amber',
    };
  }
  return null;
}

/** The top-bar chip: a trial's last week, and every emergency window. */
export function licenseCountdown(state: LicenseState | undefined): string | null {
  if (!state || state.degraded) return null;
  if (state.status === 'EMERGENCY') return locale.license.countdownEmergency(days(state.daysLeft));
  if (state.status !== 'TRIAL' || (state.warning !== 'warning' && state.warning !== 'urgent')) return null;
  return state.daysLeft !== null && state.daysLeft <= 0
    ? locale.license.countdownToday
    : locale.license.countdown(days(state.daysLeft));
}

export function LicenseBanner({ state, onOpen }: { state: LicenseState | undefined; onOpen: () => void }) {
  if (!state) return null;
  const notice = licenseNotice(state);
  if (!notice) return null;
  const danger = notice.tone === 'danger';
  const Icon = danger ? AlertOctagon : AlertTriangle;

  return (
    <div
      className={cn(
        'border-b px-8 py-3 print:hidden',
        danger ? 'border-danger/25 bg-danger-tint' : 'border-amber/25 bg-amber-tint',
      )}
      role="alert"
    >
      <div className="mx-auto flex max-w-content items-center gap-3">
        <Icon size={20} className={cn('shrink-0', danger ? 'text-danger' : 'text-amber')} aria-hidden />
        <div className="flex-1">
          <p className={cn('text-sm font-bold', danger ? 'text-danger' : 'text-amber')}>{notice.title}</p>
          <p className="text-sm leading-relaxed text-ink">{notice.body}</p>
        </div>
        <button type="button" className={buttonClass('secondary', 'shrink-0 bg-surface')} onClick={onOpen}>
          {locale.license.open}
        </button>
      </div>
    </div>
  );
}
