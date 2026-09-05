import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  HashRouter,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import {
  BadgePercent,
  Boxes,
  CreditCard,
  DatabaseBackup,
  LayoutDashboard,
  LogOut,
  Printer,
  Users,
  BarChart3,
} from 'lucide-react';
import { setTokens, setUnauthenticatedHandler } from './lib/api';
import { startRealtime } from './lib/realtime';
import { getApiUrl } from './lib/config';
import { locale } from './lib/locale';
import { cn } from './components/ui';
import { BrandMark } from './components/BrandMark';
import { RouteErrorBoundary } from './components/ErrorBoundary';
import { StorageBanner, useStorageStatus } from './components/StorageBanner';
import { SetupScreen } from './screens/Setup';
import { LoginScreen, type SessionUser } from './screens/Login';
import { OverviewScreen } from './screens/Overview';
import { CardsScreen } from './screens/Cards';
import { CustomersScreen } from './screens/Customers';
import { CustomerDetailScreen } from './screens/CustomerDetail';
import { DiscountsScreen } from './screens/Discounts';
import { ModulesScreen } from './screens/Modules';
import { CaptureScreen } from './screens/Capture';
import { BackupScreen } from './screens/Backup';
import { ReportsScreen } from './screens/Reports';
import {
  BackupBlockedBanner,
  KeyCeremonyScreen,
  useKeyStatus,
} from './screens/KeyCeremony';

/**
 * Application shell.
 *
 * `HashRouter`, not `BrowserRouter`: Tauri serves the frontend from the filesystem
 * in production, so path-based routing would 404 on a hard reload. Hash routing has
 * no such dependency and costs nothing in a desktop app with no URLs to share.
 *
 * Boot order follows CLAUDE_v2.md §9.2 — if no server URL is configured, the
 * first-run setup screen comes before login, because a login screen that cannot
 * reach a server is a dead end with no explanation.
 */

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The dashboard is driven by a local API on the same LAN, so a short stale
      // time is cheap and keeps the numbers close to live between WebSocket pushes.
      staleTime: 15_000,
      retry: 1,
      refetchOnWindowFocus: true,
      /*
        **`always`, and this is the fix for screens that hung instead of erroring.**

        React Query's default is `networkMode: 'online'`: a query whose fetch fails as
        a network error is left `pending` with `fetchStatus: 'paused'`, waiting for
        connectivity to come back. `isError` never becomes true, so every error branch
        on every screen is unreachable and the merchant watches a skeleton for as long
        as they are willing to.

        That default is written for a web app talking to the public internet, where
        `navigator.onLine` is a fair proxy for "can I reach my server". **Here it is
        not even related.** This backend is on localhost or the shop's LAN: a manager
        PC with no internet reaches it perfectly, and a manager PC with excellent
        internet reaches nothing if the service has not started — which is the
        overwhelmingly common real failure.

        `always` means a fetch is attempted regardless of what the browser believes
        about connectivity, and a failure is reported as a failure. Measured, not
        assumed: with the app pointed at a dead port and `navigator.onLine === true`,
        every query sat at `pending/paused` and no screen ever showed its error state.
      */
      networkMode: 'always',
    },
    mutations: {
      // Same reasoning: a mutation that cannot reach the server must fail and say so,
      // not queue silently against a reconnection that is not what is broken.
      networkMode: 'always',
    },
  },
});

type BootState = 'loading' | 'needs-setup' | 'needs-login' | 'ready';

const NAV_ITEMS = [
  { to: '/', label: locale.nav.overview, icon: LayoutDashboard, end: true },
  { to: '/customers', label: locale.nav.customers, icon: Users, end: false },
  { to: '/discounts', label: locale.nav.discounts, icon: BadgePercent, end: false },
  { to: '/reports', label: locale.nav.reports, icon: BarChart3, end: false },
  { to: '/capture', label: locale.nav.capture, icon: Printer, end: false },
  { to: '/cards', label: locale.nav.cards, icon: CreditCard, end: false },
  { to: '/backup', label: locale.nav.backup, icon: DatabaseBackup, end: false },
  { to: '/modules', label: locale.nav.modules, icon: Boxes, end: false },
];

/** Fixed navigation rail on the RIGHT — the RTL reading position (§6.5). */
function NavRail({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  return (
    // Glass on the rail: it sits on the canvas rather than over content, which is
    // the one placement where the steel nav labels still clear 4.5:1 (4.76). The
    // frosting here is texture rather than refraction — nothing scrolls behind it —
    // and the top highlight is what makes it read as a lit edge rather than a
    // faded panel.
    <aside className="glass flex w-rail shrink-0 flex-col border-0 border-e border-border">
      {/* The mark at 64 rather than 40 (v4 §2.5). The rail header is where the
          product identifies itself on every screen, and at 40 it read as a favicon
          beside the wordmark rather than as the mark. The 384 px asset carries it. */}
      <div className="border-b border-border px-6 py-6">
        <div className="flex items-center gap-4">
          <BrandMark size={64} />
          <div>
            <p className="font-display text-lg font-bold leading-tight text-ink">{locale.appName}</p>
            <p className="text-sm text-steel">{locale.appTagline}</p>
          </div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto p-3">
        <ul className="space-y-1">
          {NAV_ITEMS.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'flex min-h-control items-center gap-3 rounded-md px-3 text-base transition-colors duration-fast',
                    isActive
                      ? 'bg-accent-tint font-semibold text-accent'
                      : 'text-steel hover:bg-canvas hover:text-ink',
                  )
                }
              >
                <item.icon size={20} strokeWidth={2} aria-hidden />
                <span>{item.label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <div className="border-t border-border p-3">
        <div className="mb-2 px-3">
          <p className="truncate text-sm font-medium text-ink">{user.name}</p>
          <p className="text-xs text-steel">{locale.roles[user.role] ?? user.role}</p>
        </div>
        <button
          type="button"
          onClick={onLogout}
          className="flex min-h-control w-full items-center gap-3 rounded-md px-3 text-base text-steel transition-colors duration-fast hover:bg-canvas hover:text-danger"
        >
          <LogOut size={20} strokeWidth={2} aria-hidden />
          <span>{locale.nav.logout}</span>
        </button>

        {/* TEMPORARY — the build this page was served from. Remove once the
            stale-bundle question is settled. See vite.config.ts.

            Guarded with `typeof`, because the failure this is diagnosing is exactly
            the one that would make it throw: a dev server started before the config
            gained the define has no `__BUILD_STAMP__`, and a bare reference would
            white-screen the app instead of reporting the staleness. The guard turns
            that case into the answer. */}
        <p className="mt-2 select-text px-3 font-mono text-[11px] leading-tight text-steel">
          build {typeof __BUILD_STAMP__ === 'undefined' ? 'STALE SERVER — restart it' : __BUILD_STAMP__}
        </p>
      </div>
    </aside>
  );
}

function Shell({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const keyStatus = useKeyStatus();
  const storage = useStorageStatus();

  /**
   * One socket for the whole session (§7.2).
   *
   * Opened here rather than in any screen: it has to survive route changes, and the
   * free-space banner below is in the shell precisely because it is not any one screen's
   * business. Mounted after login, so there is a token for the handshake to carry.
   */
  useEffect(() => startRealtime(), []);

  /**
   * The backup key ceremony gate (CLAUDE_v3.md §12.19).
   *
   * On a **first run** — no key has ever been confirmed for this merchant — the ceremony
   * replaces the dashboard entirely for the OWNER. There is no close control and no
   * route around it, because the failure it prevents is invisible: archives that look
   * healthy and cannot be opened by anyone once this machine is gone. An optional step
   * here is a step that never happens.
   *
   * **Only the owner is walled, and that correction came from a real lockout.** The gate
   * originally blocked every dashboard role, but generating and revealing the key are
   * OWNER-only — so a manager logging in first was shown a wall they had no means to get
   * past: they could not reveal the key, therefore could not type it back, therefore
   * could not reach the dashboard, on this login or any future one. Walling somebody who
   * cannot perform the action protects nothing; it only makes the product unusable while
   * the owner is away. Backups still refuse to run, so nothing is deferred — the person
   * who can act still meets the wall.
   *
   * A key **replaced later**, and a manager waiting on the owner, both get
   * `BackupBlockedBanner` instead: standing, undismissible, and worded for whoever is
   * reading it.
   */
  const ceremonyOutstanding = Boolean(keyStatus.data && !keyStatus.data.everConfirmed);
  const canPerformCeremony = user.role === 'OWNER';

  if (ceremonyOutstanding && canPerformCeremony) {
    return (
      <KeyCeremonyScreen
        onCompleted={() => void keyStatus.refetch()}
        onLogout={onLogout}
      />
    );
  }

  return (
    // min-h-[100dvh] never h-screen (§6.5).
    //
    // NavRail comes FIRST in the DOM deliberately. Under `dir="rtl"` a flex
    // container lays its main axis right-to-left, so the first child renders at the
    // RIGHT edge — which is where §6.5 puts the navigation rail. Ordering it after
    // <main> (the LTR habit) silently mirrors the whole layout the wrong way.
    <div className="flex min-h-[100dvh] max-h-[100dvh]">
      <NavRail user={user} onLogout={onLogout} />
      <main className="flex-1 overflow-y-auto">
        {/*
          Above the backup banner deliberately. Both are standing warnings, but this one
          is about an outage that may start with the next scan, and the backup one is
          about a risk that has been standing for as long as it has been ignored.
        */}
        <StorageBanner status={storage.data} />
        {keyStatus.data ? (
          <BackupBlockedBanner
            status={keyStatus.data}
            canPerformCeremony={canPerformCeremony}
            onFix={() => navigate('/backup')}
          />
        ) : null}
        <div className="mx-auto max-w-content px-8 py-8">
          {/*
            Keyed on the pathname so navigating away from a broken screen clears the
            caught error. Without the key the boundary stays latched and every
            subsequent route renders the error card — the fix for one screen would
            break all of them.
          */}
          <RouteErrorBoundary key={pathname}>
          <Routes>
            <Route path="/" element={<OverviewScreen />} />
            <Route path="/customers" element={<CustomersScreen />} />
            <Route path="/customers/:id" element={<CustomerDetailScreen />} />
            <Route path="/discounts" element={<DiscountsScreen />} />
            <Route path="/reports" element={<ReportsScreen />} />
            <Route path="/capture" element={<CaptureScreen />} />
            <Route path="/cards" element={<CardsScreen />} />
            <Route path="/backup" element={<BackupScreen />} />
            <Route path="/modules" element={<ModulesScreen />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          </RouteErrorBoundary>
        </div>
      </main>
    </div>
  );
}

function Boot() {
  const [state, setState] = useState<BootState>('loading');
  const [user, setUser] = useState<SessionUser | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    void (async () => {
      const url = await getApiUrl();
      setState(url ? 'needs-login' : 'needs-setup');
    })();
  }, []);

  useEffect(() => {
    // A refresh that fails anywhere in the app returns the manager to login rather
    // than leaving a screen half-populated with stale data.
    setUnauthenticatedHandler(() => {
      setUser(null);
      setState('needs-login');
      navigate('/');
    });
  }, [navigate]);

  if (state === 'loading') {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center">
        <p className="text-steel">{locale.common.loading}</p>
      </div>
    );
  }

  if (state === 'needs-setup') {
    return <SetupScreen onConfigured={() => setState('needs-login')} />;
  }

  if (state === 'needs-login' || !user) {
    return (
      <LoginScreen
        onAuthenticated={(session) => {
          setUser(session);
          setState('ready');
        }}
        onChangeServer={() => setState('needs-setup')}
      />
    );
  }

  return (
    <Shell
      user={user}
      onLogout={() => {
        setTokens(null);
        setUser(null);
        setState('needs-login');
        queryClient.clear();
      }}
    />
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <Boot />
      </HashRouter>
    </QueryClientProvider>
  );
}
