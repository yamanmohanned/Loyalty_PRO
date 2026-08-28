import { useCallback, useEffect, useState } from 'react';
import { HashRouter, Link, Navigate, Route, Routes } from 'react-router-dom';
import { LogOut, Search } from 'lucide-react';
import type { AuthUser, SyncState } from '@walaa/shared-types';
import { restoreSession, setTokens, setUnauthenticatedHandler } from './lib/api';
import { resolveApiUrl } from './lib/config';
import { locale } from './lib/locale';
import { PrintProvider } from './lib/print';
import { startQueue, subscribe, type QueueSnapshot } from './lib/queue';
import { LoginScreen } from './screens/Login';
import { RegisterScreen } from './screens/Register';
import { ReprintScreen } from './screens/Reprint';
import { ScanScreen } from './screens/Scan';
import { SetupScreen } from './screens/Setup';
import { cn } from './components/ui';

/**
 * The Loyalty Station shell.
 *
 * `HashRouter`, not `BrowserRouter`. In production the API serves this bundle as
 * static files and declares only `/` and `/assets/*` — deliberately, so that unknown
 * `/api` paths keep returning 401 rather than being swallowed by an SPA catch-all.
 * Hash routing means the server only ever sees `/`, so deep links and reloads work
 * without a fallback route existing at all.
 *
 * There is **no settings screen** anywhere below this component (§6.4). Everything
 * configurable lives in the manager app behind manager authentication; the two
 * exceptions here are the first-run server address and logging out, and neither is a
 * setting so much as a way in and a way out.
 */

type Boot =
  | { kind: 'loading' }
  | { kind: 'needs-setup' }
  | { kind: 'needs-login' }
  | { kind: 'ready'; user: AuthUser };

export function App(): JSX.Element {
  const [boot, setBoot] = useState<Boot>({ kind: 'loading' });

  const start = useCallback(async () => {
    const url = await resolveApiUrl();
    if (!url) {
      setBoot({ kind: 'needs-setup' });
      return;
    }

    // A refresh token surviving in sessionStorage means the tab was reloaded rather
    // than opened fresh — the operator should not have to log in again for that.
    const restored = await restoreSession();
    setBoot(restored ? { kind: 'ready', user: restored } : { kind: 'needs-login' });
  }, []);

  useEffect(() => {
    void start();
  }, [start]);

  useEffect(() => {
    setUnauthenticatedHandler(() => setBoot({ kind: 'needs-login' }));
  }, []);

  useEffect(() => startQueue(), []);

  if (boot.kind === 'loading') {
    return <BootSkeleton />;
  }

  if (boot.kind === 'needs-setup') {
    return <SetupScreen onConfigured={() => void start()} />;
  }

  if (boot.kind === 'needs-login') {
    return <LoginScreen onAuthenticated={(user) => setBoot({ kind: 'ready', user })} />;
  }

  const { user } = boot;

  return (
    <PrintProvider>
      <HashRouter>
        <div className="flex min-h-[100dvh] flex-col bg-canvas">
          <Header
            merchantName={user.merchantName}
            onLogout={() => {
              setTokens(null);
              setBoot({ kind: 'needs-login' });
            }}
          />

          <main className="flex-1">
            <Routes>
              <Route path="/" element={<ScanScreen shopName={user.merchantName} />} />
              <Route path="/register" element={<RegisterScreen shopName={user.merchantName} />} />
              <Route path="/reprint" element={<ReprintScreen shopName={user.merchantName} />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>
        </div>
      </HashRouter>
    </PrintProvider>
  );
}

/* ── Chrome ────────────────────────────────────────────────────────────────── */

function Header({
  merchantName,
  onLogout,
}: {
  merchantName: string;
  onLogout: () => void;
}): JSX.Element {
  return (
    <header className="flex items-center justify-between gap-3 border-b border-border bg-surface px-5 py-3">
      <div className="min-w-0">
        <p className="truncate font-display text-lg font-bold">{merchantName}</p>
        <p className="text-sm text-steel">{locale.app.station}</p>
      </div>

      <div className="flex items-center gap-2">
        <ConnectionPill />
        <Link
          to="/reprint"
          className="flex min-h-[48px] items-center gap-2 rounded-md border border-border px-3 text-base"
        >
          <Search size={18} aria-hidden />
          <span className="hidden sm:inline">{locale.reprint.search}</span>
        </Link>
        <button
          type="button"
          onClick={onLogout}
          aria-label={locale.actions.logout}
          className="flex min-h-[48px] min-w-[48px] items-center justify-center rounded-md border border-border text-steel"
        >
          <LogOut size={18} aria-hidden />
        </button>
      </div>
    </header>
  );
}

/**
 * The sync indicator (§6.7 #3 of v1, carried into v3 §7.2).
 *
 * Present at all times, because "did that scan go through?" is the question the
 * operator will otherwise ask by scanning again.
 */
function ConnectionPill(): JSX.Element {
  const [snapshot, setSnapshot] = useState<QueueSnapshot>({ state: 'ONLINE', pending: 0 });

  useEffect(() => subscribe(setSnapshot), []);

  const label: Record<SyncState, string> = {
    ONLINE: locale.connection.online,
    SYNCING: locale.connection.syncing,
    OFFLINE: locale.connection.offline,
  };

  return (
    <span
      role="status"
      className={cn(
        'flex min-h-[48px] items-center gap-2 rounded-pill px-3 text-sm font-semibold',
        snapshot.state === 'ONLINE' && 'bg-success-tint text-success',
        snapshot.state === 'SYNCING' && 'bg-amber-tint text-amber',
        snapshot.state === 'OFFLINE' && 'bg-danger-tint text-danger',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'h-2.5 w-2.5 rounded-pill',
          snapshot.state === 'ONLINE' && 'bg-success',
          snapshot.state === 'SYNCING' && 'bg-amber',
          snapshot.state === 'OFFLINE' && 'bg-danger',
        )}
      />
      <span className="hidden sm:inline">{label[snapshot.state]}</span>
      {snapshot.pending > 0 ? <span>{locale.connection.queued(snapshot.pending)}</span> : null}
    </span>
  );
}

/** Skeletal, never a spinner (§6.4). */
function BootSkeleton(): JSX.Element {
  return (
    <div className="min-h-[100dvh] bg-canvas p-6">
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="h-14 animate-pulse rounded-md bg-border" />
        <div className="h-20 animate-pulse rounded-md bg-border" />
      </div>
    </div>
  );
}
