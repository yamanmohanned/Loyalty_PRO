import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
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
  Settings,
  Users,
  BarChart3,
} from 'lucide-react';
import { setTokens, setUnauthenticatedHandler } from './lib/api';
import { startRealtime } from './lib/realtime';
import { BackendGate } from './components/BackendGate';
import { locale } from './lib/locale';
import { cn, Monogram } from './components/ui';
import { BrandMark } from './components/BrandMark';
import { RouteErrorBoundary } from './components/ErrorBoundary';
import { StorageBanner, useStorageStatus } from './components/StorageBanner';
import { AppBar, collectAlerts } from './components/AppBar';
import { DemoBadge, DemoWelcome } from './components/DemoSurfaces';
import { startUpdateCheck, UpdateNotice } from './components/UpdateNotice';
import { IS_DEMO } from './lib/demo';
import { LoginScreen, type SessionUser } from './screens/Login';
import { OverviewScreen } from './screens/Overview';
import { CardsScreen } from './screens/Cards';
import { CustomersScreen } from './screens/Customers';
import { CustomerDetailScreen } from './screens/CustomerDetail';
import { DiscountsScreen } from './screens/Discounts';
import { ModulesScreen } from './screens/Modules';
import { SettingsScreen } from './screens/Settings';
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
 * ── Boot order, and the screen that is no longer in it ─────────────────────
 *
 * There used to be a first-run SETUP state ahead of login: with no server URL stored,
 * the app opened on a form asking the shop owner for an address. The justification was
 * sound as far as it went — a login screen that cannot reach a server is a dead end —
 * but it answered the wrong question. The manager PC *hosts* the server; the installer
 * fixed its port; the address was never unknown, only unasked-for.
 *
 * So the app resolves its own backend (`lib/config.ts`), `BackendGate` is the single
 * surface that reports a backend which cannot be reached, and boot is now two states:
 * signed out, or signed in. An address is typed in exactly two places — Settings, and
 * the recovery panel `BackendGate` shows when nothing was found at all — and on
 * neither of them is anyone trying to start their working day.
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

type BootState = 'needs-login' | 'ready';

const NAV_ITEMS = [
  { to: '/', label: locale.nav.overview, icon: LayoutDashboard, end: true },
  { to: '/customers', label: locale.nav.customers, icon: Users, end: false },
  { to: '/discounts', label: locale.nav.discounts, icon: BadgePercent, end: false },
  { to: '/reports', label: locale.nav.reports, icon: BarChart3, end: false },
  { to: '/capture', label: locale.nav.capture, icon: Printer, end: false },
  { to: '/cards', label: locale.nav.cards, icon: CreditCard, end: false },
  { to: '/backup', label: locale.nav.backup, icon: DatabaseBackup, end: false },
  { to: '/modules', label: locale.nav.modules, icon: Boxes, end: false },
  /* Last in the rail, which is where a merchant expects it and where it stays out of
     the daily path. Everything technical lives behind it — the server address that
     used to sit under the login form, and the cloud-backup fields. */
  { to: '/settings', label: locale.nav.settings, icon: Settings, end: false },
];

/**
 * Does the window have room for the rail's labels?
 *
 * `useSyncExternalStore` over a `matchMedia` list rather than a resize listener with
 * local state: the media query is the external source of truth, React subscribes to
 * it directly, and there is no render where the component's idea of the width
 * disagrees with the browser's.
 */
function useWideViewport(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia('(min-width: 1280px)');
      query.addEventListener('change', notify);
      return () => query.removeEventListener('change', notify);
    },
    () => window.matchMedia('(min-width: 1280px)').matches,
    () => true,
  );
}

/**
 * Fixed navigation rail on the RIGHT — the RTL reading position (§6.5).
 *
 * **Collapse is a prop now, not a media query.** It was `xl:` variants, which is
 * correct until a control has to override it: CSS cannot be told "collapsed unless
 * the merchant said otherwise". The width still decides the DEFAULT — see
 * `useWideViewport` — and the toggle in the app bar overrides it for the session.
 */
function NavRail({
  user,
  onLogout,
  collapsed,
}: {
  user: SessionUser;
  onLogout: () => void;
  collapsed: boolean;
}) {
  return (
    // Glass on the rail: it sits on the canvas rather than over content, which is
    // the one placement where the steel nav labels still clear 4.5:1 (4.76). The
    // frosting here is texture rather than refraction — nothing scrolls behind it —
    // and the top highlight is what makes it read as a lit edge rather than a
    // faded panel.
    /*
      ── Collapse ───────────────────────────────────────────────────────────

      The rail is 288 px and the content area is capped at 1440; on a 1280 window
      that leaves 928 px for a seven-column table, which is where the Overview's
      invoice rows start eliding. Dropping the labels returns 212 px of it.

      **The width sets the default and the merchant can override it.** This was
      CSS-only, on the argument that a manual control is something a manager has to
      discover, get wrong and put back. That still holds as a default — which is why
      `useWideViewport` decides the initial state and nothing is persisted — but a
      shop owner on a 1366 laptop who wants the labels back had no way to say so.
      Every nav item is present at both widths and keeps its name in `title` and
      `aria-label`, so collapsing loses a label visually and loses nothing to a
      screen reader or a hover.
    */
    <aside
      className={cn(
        'glass flex shrink-0 flex-col border-0 border-e border-border transition-[width] duration-base ease-native',
        collapsed ? 'w-rail-collapsed' : 'w-rail',
      )}
    >
      {/* The mark at 64 rather than 40 (v4 §2.5). The rail header is where the
          product identifies itself on every screen, and at 40 it read as a favicon
          beside the wordmark rather than as the mark. The 384 px asset carries it.
          Collapsed, 64 is wider than the rail's usable width, so it steps down —
          a prop now that collapse is state rather than a media query. */}
      <div className={cn('border-b border-border', collapsed ? 'px-3 py-4' : 'px-6 py-6')}>
        <div className={cn('flex items-center gap-4', collapsed ? 'justify-center' : 'justify-start')}>
          <BrandMark size={collapsed ? 40 : 64} />
          {collapsed ? null : (
          <div className="min-w-0">
            <p className="font-display text-lg font-bold leading-tight text-ink">{locale.appName}</p>
            {/*
              The SHOP's name, not a product label.

              `merchantName` has been on the session since the Station needed a name to
              print on cards, and the manager app rendered it nowhere — found by the
              §10.9 standing check, which is now the fourth field this check has
              recovered. A manager running two shops could not tell from this rail
              which one they were looking at; «إدارة المتجر» told them nothing they
              did not know.
            */}
            <p className="truncate text-sm text-steel" title={user.merchantName}>
              {user.merchantName}
            </p>
          </div>
          )}
        </div>
      </div>

      {/* Demo marker: in the rail rather than the app bar, so it is on every screen and
          never competes with the two controls up there. Renders nothing at all in a
          production build — `IS_DEMO` is a compile-time literal. */}
      {IS_DEMO ? (
        <div className={cn('px-3 pt-3', collapsed && 'flex justify-center')}>
          <DemoBadge collapsed={collapsed} />
        </div>
      ) : null}

      <nav className="flex-1 overflow-y-auto p-3">
        <ul className="space-y-1">
          {NAV_ITEMS.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.end}
                title={item.label}
                aria-label={item.label}
                className={({ isActive }) =>
                  cn(
                    'flex min-h-control items-center gap-3 rounded-md text-base transition-colors duration-fast',
                    collapsed ? 'justify-center' : 'justify-start px-3',
                    isActive
                      ? 'bg-accent-tint font-semibold text-accent'
                      : 'text-steel hover:bg-canvas hover:text-ink',
                  )
                }
              >
                <item.icon size={20} strokeWidth={2} aria-hidden className="shrink-0" />
                {collapsed ? null : <span>{item.label}</span>}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <div className="border-t border-border p-3">
        {/* The reference's profile block: an avatar, a name, a role. The avatar is a
            monogram — we hold no photographs and §0.4 keeps stored data minimal. */}
        <div
          className={cn(
            'mb-2 flex items-center gap-3 py-1',
            collapsed ? 'justify-center' : 'justify-start px-3',
          )}
          title={`${user.name} — ${locale.roles[user.role] ?? user.role}`}
        >
          <Monogram name={user.name} size="sm" />
          {collapsed ? null : (
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-ink">{user.name}</p>
            <p className="text-xs text-steel">{locale.roles[user.role] ?? user.role}</p>
          </div>
          )}
        </div>
        <button
          type="button"
          onClick={onLogout}
          title={locale.nav.logout}
          aria-label={locale.nav.logout}
          className={cn(
            'flex min-h-control w-full items-center gap-3 rounded-md text-base text-steel transition-colors duration-fast hover:bg-canvas hover:text-danger',
            collapsed ? 'justify-center' : 'justify-start px-3',
          )}
        >
          <LogOut size={20} strokeWidth={2} aria-hidden className="shrink-0" />
          {collapsed ? null : <span>{locale.nav.logout}</span>}
        </button>

        {/*
          The version, and nothing else.

          This slot held a git sha and a dirty flag — diagnostic output aimed at me,
          shown to the shop owner on every screen. A version is the one identifier a
          support call needs, and it is the one a merchant can read back over a phone.
          Hidden with the labels when the rail is collapsed.
        */}
        {collapsed ? null : (
          <p className="mt-2 select-text px-3 font-mono text-[11px] leading-tight text-steel">
            {/*
              **The version number is isolated, and it has to be.**

              `0.1.0-preview` inside an RTL paragraph painted as `preview-0.1.0`: the
              hyphen is bidi class ES and the trailing word is a neutral Latin run, so
              the algorithm reorders the two around it. A version a merchant reads back
              over the phone must be the version that is installed. Same remedy as the
              trend pills and the invoice numbers (§12.25) — one `<bdi dir="ltr">`.
            */}
            {locale.nav.version}{' '}
            <bdi dir="ltr">{__APP_VERSION__}</bdi>
          </p>
        )}
      </div>
    </aside>
  );
}

function Shell({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const keyStatus = useKeyStatus();
  const storage = useStorageStatus();

  /*
    Rail collapse: the viewport proposes, the merchant disposes.

    `null` means "follow the window", which is the state the app starts in and never
    leaves unless the toggle is pressed. Not persisted: a preference stored across
    launches is a preference the owner has to remember setting, and the window width
    is right often enough that the override is a session-long correction rather than
    a setting.
  */
  const wide = useWideViewport();
  const [railOverride, setRailOverride] = useState<boolean | null>(null);
  const railCollapsed = railOverride ?? !wide;

  // Assembled from the two queries the banners below already run — no extra request.
  const alerts = useMemo(
    () => collectAlerts(storage.data, keyStatus.data),
    [storage.data, keyStatus.data],
  );

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
  /*
    ── The ceremony gate is lifted in the demo, and this is not a shortcut ──────

    On a real installation the gate is right: an unconfirmed backup key means every
    archive this shop ever writes is unopenable, and an optional step there is a step
    nobody takes (§12.19).

    In a demo there are no archives, no shop, and no key worth escrowing — and the
    OWNER account is the one the merchant is most likely to try first. He would
    double-click the installer, sign in, and meet a full-screen wall with no close
    control demanding he write down a cryptographic key. That is not a demo of
    anything; it is a locked door. The brief's «nothing modal, nothing that blocks
    him» is exactly this case.

    The Backup screen still exists and still explains what the ceremony is for, so the
    feature is visible without being enforced against a laptop that has nothing to back
    up.
  */
  const ceremonyOutstanding = Boolean(keyStatus.data && !keyStatus.data.everConfirmed) && !IS_DEMO;
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
      <NavRail user={user} onLogout={onLogout} collapsed={railCollapsed} />
      {/* `app-atmosphere`: two soft mint washes at 0.03 and 0.022 alpha — at or under
          the computed 5% ceiling. No dot matrix here; a texture under a column of
          figures is noise pretending to be depth. */}
      <main className="app-atmosphere flex-1 overflow-y-auto">
        {/*
          The bar is above both banners and inside the scroller rather than pinned.

          Pinning it would put a translucent strip over a dense table on every scroll,
          which §6.2.1's glass note rules out for exactly this surface — steel on
          content does not reach 4.5:1 at any practical alpha. It scrolls away with
          the page, and the two controls on it are reachable again in one flick.
        */}
        <AppBar
          railCollapsed={railCollapsed}
          onToggleRail={() => setRailOverride(!railCollapsed)}
          alerts={alerts}
          onOpenAlert={(route) => navigate(route)}
        />
        {/*
          Above the backup banner deliberately. Both are standing warnings, but this one
          is about an outage that may start with the next scan, and the backup one is
          about a risk that has been standing for as long as it has been ignored.
        */}
        <UpdateNotice />
        {IS_DEMO ? <DemoWelcome /> : null}
        <StorageBanner status={storage.data} />
        {/* Suppressed in the demo for the same reason as the gate above: a red bar
            saying backups are stopped is true, unactionable and alarming on a machine
            that has no shop on it. The Backup screen says so calmly instead. */}
        {keyStatus.data && !IS_DEMO ? (
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
            <Route path="/settings" element={<SettingsScreen />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          </RouteErrorBoundary>
        </div>
      </main>
    </div>
  );
}

function Boot() {
  /*
    No `loading` state and no probe.

    Both existed to answer "is a server address configured", which is a question this
    app no longer asks anybody. `BackendGate` above has already established that the
    backend answers before this component renders at all, so starting anywhere but the
    login screen would be showing a spinner for a fact already in hand.
  */
  const [state, setState] = useState<BootState>('needs-login');
  const [user, setUser] = useState<SessionUser | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    // A refresh that fails anywhere in the app returns the manager to login rather
    // than leaving a screen half-populated with stale data.
    setUnauthenticatedHandler(() => {
      setUser(null);
      setState('needs-login');
      navigate('/');
    });
  }, [navigate]);

  if (state === 'needs-login' || !user) {
    return (
      <LoginScreen
        onAuthenticated={(session) => {
          setUser(session);
          setState('ready');
        }}
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
  // Above the session gate: an update is a property of the machine, not of who is
  // signed in, and a shop PC left on the login screen should still get one.
  useEffect(() => startUpdateCheck(), []);

  return (
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        {/*
          Outside `Boot` on purpose. `Boot` decides between setup, login and the
          dashboard — all of which assume there is something to talk to. Whether there
          IS is a prior question, and it is the one that used to be answered on nine
          separate panels with the same wrong guess about the network.
        */}
        <BackendGate>
          <Boot />
        </BackendGate>
      </HashRouter>
    </QueryClientProvider>
  );
}
