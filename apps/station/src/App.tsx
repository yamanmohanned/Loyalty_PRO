import { useCallback, useEffect, useState } from 'react';
import { HashRouter, Link, Navigate, Route, Routes } from 'react-router-dom';
import { LogOut, Search } from 'lucide-react';
import type { AuthUser, LicenseState, PaperWidth as PaperWidthValue, SyncState } from '@walaa/shared-types';
import { api, restoreSession, setTokens, setUnauthenticatedHandler } from './lib/api';
import { resolveApiUrl } from './lib/config';
import { locale } from './lib/locale';
import { PrintProvider } from './lib/print';
import { LICENSE_REFUSED_EVENT, startQueue, subscribe, type QueueSnapshot } from './lib/queue';
import { startRealtime } from './lib/realtime';
import { LoginScreen } from './screens/Login';
import { RegisterScreen } from './screens/Register';
import { ReprintScreen } from './screens/Reprint';
import { ScanScreen } from './screens/Scan';
import { SetupScreen } from './screens/Setup';
import { BrandMark } from './components/BrandMark';
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

  // Only once there is a session: the handshake carries the access token, and a
  // socket opened before login would just be refused and retried on a backoff.
  useEffect(() => {
    if (boot.kind !== 'ready') return undefined;
    return startRealtime();
  }, [boot.kind]);

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
      <PaperWidth width={user.paperWidth} />
      <HashRouter>
        <div className="flex min-h-[100dvh] flex-col bg-canvas">
          <Header
            merchantName={user.merchantName}
            onLogout={() => {
              setTokens(null);
              setBoot({ kind: 'needs-login' });
            }}
          />
          <LicenseStrip />

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
      <div className="flex min-w-0 items-center gap-3">
        <BrandMark size={36} />
        <div className="min-w-0">
          <p className="truncate font-display text-lg font-bold">{merchantName}</p>
          <p className="text-sm text-steel">{locale.app.station}</p>
        </div>
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
/**
 * One line under the header while the manager PC's licence is read-only, so the cashier
 * knows before the first scan rather than learning it from a refusal. Says what still
 * happens (invoices are kept and credited later) before what does not.
 *
 * **Re-checked the moment the held count changes**, not only on a timer. It first polled
 * every five minutes — and after the shop was unlocked it went on telling the cashier that
 * registration was stopped while it worked, which is the ambiguity this strip exists to
 * remove. The held count is the till's own evidence: it rises when the manager PC refuses
 * for the licence and falls to zero when it starts accepting again. A one-minute poll
 * covers the rest.
 */
function LicenseStrip(): JSX.Element | null {
  const [readOnly, setReadOnly] = useState(false);
  const [held, setHeld] = useState(0);
  const [heldOnManager, setHeldOnManager] = useState(0);
  const [refusals, setRefusals] = useState(0);

  useEffect(() => {
    const onRefused = (): void => setRefusals((n) => n + 1);
    window.addEventListener(LICENSE_REFUSED_EVENT, onRefused);
    return () => window.removeEventListener(LICENSE_REFUSED_EVENT, onRefused);
  }, []);

  useEffect(() => subscribe((snapshot) => setHeld(snapshot.held)), []);

  useEffect(() => {
    let alive = true;
    const check = (): void => {
      api
        .get<LicenseState>('/license')
        .then((state) => {
          if (!alive) return;
          setReadOnly(state.readOnly);
          setHeldOnManager(state.heldAtStations?.count ?? 0);
        })
        // Unreachable is the connection pill's news, not this strip's.
        .catch(() => undefined);
    };
    check();
    const timer = window.setInterval(check, 60_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [held, refusals]);

  if (!readOnly) return null;
  return (
    <div role="status" className="border-b border-amber/30 bg-amber-tint px-5 py-2 text-center text-sm font-semibold text-ink">
      {locale.license.strip}
      {heldOnManager > 0 ? ` ${locale.license.stripHeld(heldOnManager)}` : null}
    </div>
  );
}

function ConnectionPill(): JSX.Element {
  const [snapshot, setSnapshot] = useState<QueueSnapshot>({ state: 'ONLINE', pending: 0, held: 0 });

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
      {snapshot.held > 0 ? (
        <span>{locale.connection.held(snapshot.held)}</span>
      ) : snapshot.pending > 0 ? (
        <span>{locale.connection.queued(snapshot.pending)}</span>
      ) : null}
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

/**
 * Puts the merchant's roll width onto the document root, where both the print
 * stylesheet and the on-screen preview read it (§5.1).
 *
 * **A component rather than an effect in `App`, and that is not style.** The first
 * version was a `useEffect` beside `const { user } = boot`, which sits *after* App's
 * early returns for the loading, setup and login states — so the hook rendered
 * conditionally and React threw #310, "rendered more hooks than during the previous
 * render", as a blank screen. Typecheck and lint both passed it. Owning the effect in a
 * component that only mounts once there is a session makes the ordering unconditional
 * by construction instead of by remembering.
 *
 * On `documentElement` rather than a rendered wrapper because the print stylesheet
 * styles `html`, `body` and `@page` — none of which any component owns. A width applied
 * further down the tree would leave the printed page 80 mm with a narrower block inside
 * it: the failure that looks like it worked.
 */
function PaperWidth({ width }: { width: PaperWidthValue }): null {
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--paper-width', `${width}mm`);
    // 58 mm rolls need tighter side margins or the slip loses usable width to padding:
    // 3 mm a side of 58 leaves 52 mm, against 74 of 80. The vertical padding is about
    // the tear rather than the width, so it does not change.
    root.style.setProperty('--paper-padding', width === 58 ? '4mm 2mm 8mm' : '4mm 3mm 8mm');
  }, [width]);

  return null;
}
