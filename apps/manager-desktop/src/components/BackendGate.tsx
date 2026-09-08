import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, ServerOff } from 'lucide-react';
import { getApiUrl } from '../lib/config';
import { isBackendHealthy, readBackendStatus, type BackendStatus } from '../lib/backend';
import { locale } from '../lib/locale';
import { ServerAddressForm } from './ServerAddressForm';

/**
 * Holds the app closed until the backend is actually serving, and says why when it is not.
 *
 * ── The failure this replaces ────────────────────────────────────────────────
 *
 * With the API down, every screen rendered its own «تعذّر تحميل البيانات. تحقّق من
 * الاتصال بالخادم وأعد المحاولة.» — a sentence about network connectivity, shown for a
 * disk-space refusal, a migration failure, a locked database and a port collision
 * alike. Nine panels each repeating the same wrong guess. The API had meanwhile
 * written the correct cause and the correct remedy to disk, and no surface in the
 * product could reach it.
 *
 * Three things had to change together, and the third is this component:
 *
 *   1. the API records WHY it could not start, outside its own lifetime;
 *   2. the shell exposes that file through a narrow command, since the webview has no
 *      filesystem;
 *   3. one surface reads it and renders it verbatim, instead of every screen guessing.
 *
 * ── Starting is not failing ──────────────────────────────────────────────────
 *
 * A cold start opens SQLite, applies pragmas and binds a port; on a slow shop PC that
 * is a few seconds, and calling it a failure would train the merchant to restart the
 * app during normal operation. `starting` gets a patient message with no remedy and no
 * alarm; only a backend that has actually stopped gets one.
 *
 * ── Why it polls rather than waiting for an event ────────────────────────────
 *
 * The thing being waited for is a process that may never come up. An event-driven wait
 * has no answer for that case, and the poll doubles as the liveness check that decides
 * between the two messages.
 */

const POLL_MS = 1000;
/** After this long with no health, start showing what the status file says. */
const PATIENCE_MS = 4000;

interface Props {
  children: React.ReactNode;
}

export function BackendGate({ children }: Props): React.ReactElement {
  const [healthy, setHealthy] = useState(false);
  const [status, setStatus] = useState<BackendStatus | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [checking, setChecking] = useState(false);
  /** Whether an address could be resolved at all. `true` until proven otherwise. */
  const [located, setLocated] = useState(true);
  const started = useRef(Date.now());
  /** So the "no address" line is logged once rather than once per poll. */
  const reportedMissing = useRef(false);

  const probe = useCallback(async () => {
    const base = await getApiUrl();

    /*
      ── A missing address used to be waved through, and that was the bug ──────

      This read: no address configured, therefore not a backend failure, therefore
      let the app through to the first-run Setup screen. That screen is gone, because
      the manager PC resolves its own backend — so `null` no longer means "nobody has
      configured this yet". It means the app looked for a backend, on this machine and
      in its settings, and found none.

      Waving that through now would drop the merchant onto a login form that cannot
      possibly succeed, with no explanation. It is a distinct, explained state instead,
      and it is the one place outside Settings that offers an address field: it is also
      the one moment Settings is unreachable, being behind the login this state blocks.
    */
    if (!base) {
      // Once, not on every one-second poll: this is a standing state, and a console
      // filling at 1 Hz buries the line somebody is looking for.
      if (!reportedMissing.current) {
        reportedMissing.current = true;
        console.error('[backend] no address resolved', await readBackendStatus());
      }
      setLocated(false);
      setElapsed(Date.now() - started.current);
      return;
    }
    reportedMissing.current = false;
    setLocated(true);

    if (await isBackendHealthy(base)) {
      setHealthy(true);
      return;
    }
    const next = await readBackendStatus();

    /*
      ── The diagnostics moved from the screen to the console ─────────────────

      This panel used to render the attempt count and a disclosure listing the exact
      files consulted — `C:\ProgramData\Walaa\logs\status.json` and its neighbour.
      Both were put there for a good reason (the defect that produced this whole
      component was two processes disagreeing about which file was in play, with no
      surface naming either) and both were aimed at me, printed on a shop owner's
      screen.

      A merchant reading "5 attempts" and a Windows path learns nothing he can act on,
      and learns that this product expects him to understand its internals. The facts
      are still recorded, in the place they were always actually useful.
    */
    console.error('[backend] not serving', {
      state: next.state,
      attempts: next.attempts,
      at: next.at,
      port: next.port,
      checked: next.checked,
      reason: next.reason,
    });

    setStatus(next);
    setElapsed(Date.now() - started.current);
  }, []);

  useEffect(() => {
    let live = true;
    void probe();
    const timer = setInterval(() => {
      if (live && !healthy) void probe();
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [probe, healthy]);

  if (healthy) return <>{children}</>;

  /*
    Nothing to talk to at all — no service on this machine and no address configured.
    Distinct from a backend that failed, because the remedy is different: this reader
    either restarts the manager PC or names the manager PC, and telling them to
    restart a service that was never installed sends them hunting for it.

    The patience window still applies: on a cold boot the shell may not have read the
    service's status file yet, and flashing "no server found" for a second at every
    launch would be its own defect.
  */
  if (!located && elapsed >= PATIENCE_MS) {
    return (
      <Frame>
        <ServerOff className="size-6 text-amber" aria-hidden />
        <h1 className="text-xl font-semibold text-ink">{locale.backend.missingTitle}</h1>
        <p className="max-w-prose leading-relaxed text-steel">{locale.backend.missingBody}</p>

        <div className="w-full max-w-prose rounded-2xl border border-border bg-surface p-6 text-start">
          <ServerAddressForm onSaved={() => window.location.reload()} />
        </div>

        <button
          type="button"
          onClick={() => {
            setChecking(true);
            void probe().finally(() => setChecking(false));
          }}
          className="min-h-12 rounded-xl bg-accent px-5 font-semibold text-white active:translate-y-px"
        >
          {checking ? locale.backend.retrying : locale.backend.retry}
        </button>
      </Frame>
    );
  }

  // Inside the patience window, or the supervisor says it is still coming up.
  const state = status?.state ?? 'unknown';
  const stillStarting = elapsed < PATIENCE_MS || state === 'starting';

  if (stillStarting) {
    return (
      <Frame>
        <Loader2 className="size-6 animate-spin text-accent" aria-hidden />
        <h1 className="text-xl font-semibold text-ink">{locale.backend.startingTitle}</h1>
        <p className="max-w-prose text-steel">{locale.backend.startingBody}</p>
      </Frame>
    );
  }

  const { title, body } =
    state === 'terminal'
      ? { title: locale.backend.terminalTitle, body: locale.backend.terminalBody }
      : state === 'stopped'
        ? { title: locale.backend.stoppedTitle, body: locale.backend.stoppedBody }
        : state === 'failed'
          ? { title: locale.backend.failedTitle, body: null }
          : { title: locale.backend.unknownTitle, body: locale.backend.unknownBody };

  return (
    <Frame>
      <AlertTriangle className="size-6 text-red" aria-hidden />
      <h1 className="text-xl font-semibold text-ink">{title}</h1>
      {body ? <p className="max-w-prose text-steel">{body}</p> : null}

      {/*
        The backend's own sentence, verbatim. It is already written in Arabic for this
        exact reader and it names both the cause and the remedy — paraphrasing it here
        would be how the information gets lost a second time.
      */}
      <div className="w-full max-w-prose rounded-2xl border border-border bg-surface p-4 text-start">
        <p className="mb-1 text-xs font-semibold text-steel">{locale.backend.reasonLabel}</p>
        <p className="text-ink">{status?.reason ?? locale.backend.failedFallback}</p>
      </div>

      <button
        type="button"
        onClick={() => {
          setChecking(true);
          void probe().finally(() => setChecking(false));
        }}
        className="min-h-12 rounded-xl bg-accent px-5 font-semibold text-white active:translate-y-px"
      >
        {checking ? locale.backend.retrying : locale.backend.retry}
      </button>

    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 bg-canvas px-6 text-center">
      {children}
    </div>
  );
}
