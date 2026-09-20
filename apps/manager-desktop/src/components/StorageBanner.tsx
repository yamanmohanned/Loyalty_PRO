import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertOctagon, AlertTriangle, HelpCircle } from 'lucide-react';
import type { StorageStatus } from '@loyalty-pro/shared-types';
import { api } from '../lib/api';
import { cn } from './ui';
import { locale } from '../lib/locale';
import { onRealtimeConnect, onRealtimeEvent } from '../lib/realtime';

/**
 * Free space on the manager machine (docs/legacy/CLAUDE_v3.md §12.15).
 *
 * §12.15 is blunt about why this is on screen at all: at a merchant, a full `C:` is not
 * a nuisance but an outage, and its symptom lies. SQLite refuses writes cleanly and goes
 * on serving reads, so this very dashboard renders correctly — every number in it
 * current, every chart drawn — while each scan at the till fails. Nobody looks at free
 * space until something breaks, so the number is put where it will be seen anyway.
 *
 * **Undismissible, like the backup banner.** A warning the manager can close is one they
 * close, and the condition does not go away when the banner does. It disappears when the
 * disk has room again and not before.
 *
 * **No action button**, because there is no action this app can take. Clearing space
 * happens in Windows. A button that merely re-checked would imply the app could fix it.
 */

const QUERY_KEY = ['system', 'storage'] as const;

/**
 * The current verdict, kept live.
 *
 * Fetched once on mount and thereafter updated by the push — the pairing the API
 * documents. Polling alone would put the banner up to a minute behind; the push alone
 * would leave a dashboard opened *after* the change showing nothing at all.
 *
 * The event carries the server's verdict and the client stores it verbatim. Nothing here
 * re-derives a level from `freeBytes`: the thresholds and their hysteresis live on the
 * server, and a second copy would disagree at exactly the boundary where disagreement is
 * most confusing.
 *
 * **A reconnect re-reads.** Transitions are announced once, so anything that happened
 * while the socket was down — the API service restarting is the ordinary case — is simply
 * missed. Without this the banner would hold a stale verdict until the query happened to
 * go stale and something happened to refocus the window, which on a dashboard left open
 * on a back-office monitor could be days.
 */
export function useStorageStatus() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => api.get<StorageStatus>('/system/storage'),
    // The reading is a minute old at worst on the server side, so re-asking more often
    // than that buys nothing.
    staleTime: 60_000,
  });

  useEffect(
    () => onRealtimeConnect(() => void queryClient.invalidateQueries({ queryKey: QUERY_KEY })),
    [queryClient],
  );

  useEffect(
    () =>
      onRealtimeEvent((event) => {
        if (event.type !== 'STORAGE_LEVEL_CHANGED') return;
        queryClient.setQueryData<StorageStatus>(QUERY_KEY, (previous) => ({
          // `totalBytes` is the size of the volume and does not change; the event omits
          // it rather than restating it on every transition.
          totalBytes: previous?.totalBytes ?? null,
          level: event.level,
          freeBytes: event.freeBytes,
          path: event.path,
          sampledAt: event.at,
          error: null,
        }));
      }),
    [queryClient],
  );

  return query;
}

const gigabytes = (bytes: number | null): string =>
  bytes === null ? '—' : `${(bytes / 1024 ** 3).toFixed(1)} GB`;

interface Presentation {
  title: string;
  body: string;
  icon: typeof AlertOctagon;
  /** Semantic colour only — §6.2 allows these to carry status, never decoration. */
  tone: 'danger' | 'amber';
}

function present(status: StorageStatus): Presentation | null {
  switch (status.level) {
    case 'CRITICAL':
      return {
        title: locale.storage.criticalTitle,
        body: locale.storage.criticalBody,
        icon: AlertOctagon,
        tone: 'danger',
      };
    case 'WARN':
      return {
        title: locale.storage.warnTitle,
        body: locale.storage.warnBody,
        icon: AlertTriangle,
        tone: 'amber',
      };
    case 'UNKNOWN':
      // Amber rather than red: not knowing is not the same as knowing it is bad. It is
      // still shown, because a reading that silently stopped arriving is the failure
      // shape this whole feature exists to prevent.
      return {
        title: locale.storage.unknownTitle,
        body: locale.storage.unknownBody,
        icon: HelpCircle,
        tone: 'amber',
      };
    case 'OK':
      return null;
  }
}

/**
 * The drive letter, and nothing else of the path.
 *
 * The whole path was printed here — `C:/Users/<account>/…` on a development layout,
 * `C:\ProgramData\LoyaltyPro` on a shop's — which disclosed the Windows account name and
 * gave the merchant nothing to act on. The disk is the useful fact: it is what he
 * frees space on.
 */
function volumeOf(path: string | null): string | null {
  return path ? (/^[A-Za-z]:/.exec(path)?.[0].toUpperCase() ?? null) : null;
}

export function StorageBanner({ status }: { status: StorageStatus | undefined }) {
  if (!status) return null;

  const presentation = present(status);
  if (!presentation) return null;

  const { icon: Icon, tone } = presentation;
  const critical = tone === 'danger';
  const heading = critical ? 'text-danger' : 'text-amber';

  return (
    <div
      className={cn(
        'border-b px-8 py-3 print:hidden',
        critical ? 'border-danger/25 bg-danger-tint' : 'border-amber/25 bg-amber-tint',
      )}
    >
      <div className="mx-auto flex max-w-content items-center gap-3">
        <Icon size={20} className={cn('shrink-0', heading)} aria-hidden />
        <div className="flex-1">
          <p className={cn('text-sm font-bold', heading)}>{presentation.title}</p>
          <p className="text-sm text-ink">{presentation.body}</p>
        </div>
        <div className="shrink-0 text-end">
          {status.freeBytes === null ? null : (
            <>
              <p className="text-xs text-steel">{locale.storage.freeLabel}</p>
              {/* Monospace, per §6.3 — a figure the manager compares against yesterday's. */}
              <p className="font-mono text-lg font-bold text-ink" dir="ltr">
                {gigabytes(status.freeBytes)}
              </p>
            </>
          )}
          {volumeOf(status.path) ? (
            <p className="text-xs text-steel">
              {locale.storage.volumeLabel}{' '}
              <bdi className="font-mono" dir="ltr">
                {volumeOf(status.path)}
              </bdi>
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
