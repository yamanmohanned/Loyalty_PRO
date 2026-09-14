import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertOctagon } from 'lucide-react';
import type { LicenseState } from '@walaa/shared-types';
import { api } from '../lib/api';
import { formatDate, locale } from '../lib/locale';
import { onRealtimeConnect } from '../lib/realtime';
import { buttonClass } from './ui';

/**
 * The licence, as the shell shows it (packaging/LICENSING.md).
 *
 * The screen decides nothing here. The service evaluates the licence — in Rust, on every
 * sale — and this reads the verdict so the manager learns it from a banner rather than
 * from a refused scan at the till.
 *
 * **Undismissible, like the storage and backup banners.** Read-only is a standing
 * condition; a banner the manager can close is one he closes, and the condition stays.
 * The grace period gets the same red bar on every launch, which is what it is for: five
 * days of warning that are only worth anything if they are seen.
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

/** The sentence for a state that needs one; null for a licence in good standing. */
export function licenseNotice(state: LicenseState): { title: string; body: string } | null {
  const t = locale.license;
  switch (state.status) {
    case 'UNLICENSED':
      return { title: t.unlicensedTitle, body: t.readOnlyBody };
    case 'EXPIRED':
      return { title: t.expiredTitle, body: t.readOnlyBody };
    case 'TAMPERED':
      return {
        title: t.tamperedTitle,
        body: state.storedLicenseInvalid
          ? t.tamperedCodeBody
          : t.tamperedClockBody(t.minutes(state.clockBehindMinutes ?? 0)),
      };
    case 'TRIAL_GRACE':
      return { title: t.graceTitle, body: t.graceBody(state.graceEndsAt ? formatDate(state.graceEndsAt) : '—') };
    case 'TRIAL':
    case 'PERPETUAL':
      return null;
  }
}

/** «تنتهي الفترة التجريبية خلال X» — only in a trial's last seven days. */
export function licenseCountdown(state: LicenseState | undefined): string | null {
  if (!state || state.status !== 'TRIAL' || !state.showExpiryWarning || state.daysLeft === null) return null;
  return state.daysLeft <= 0
    ? locale.license.countdownToday
    : locale.license.countdown(locale.license.days(state.daysLeft));
}

export function LicenseBanner({ state, onOpen }: { state: LicenseState | undefined; onOpen: () => void }) {
  if (!state) return null;
  const notice = licenseNotice(state);
  if (!notice) return null;

  return (
    <div className="border-b border-danger/25 bg-danger-tint px-8 py-3 print:hidden" role="alert">
      <div className="mx-auto flex max-w-content items-center gap-3">
        <AlertOctagon size={20} className="shrink-0 text-danger" aria-hidden />
        <div className="flex-1">
          <p className="text-sm font-bold text-danger">{notice.title}</p>
          <p className="text-sm leading-relaxed text-ink">{notice.body}</p>
        </div>
        <button type="button" className={buttonClass('secondary', 'shrink-0 bg-surface')} onClick={onOpen}>
          {locale.license.open}
        </button>
      </div>
    </div>
  );
}
