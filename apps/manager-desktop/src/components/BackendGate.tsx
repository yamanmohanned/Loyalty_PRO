import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, ServerOff, SettingsIcon } from 'lucide-react';
import { getApiUrl, getRemoteApiUrl } from '../lib/config';
import { probeBackend, readBackendStatus, type BackendStatus } from '../lib/backend';
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
 * ═══════════════════════════════════════════════════════════════════════════
 *  What went wrong on the first real installation
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A manager PC lost its `walaa.env`. The service could not start without it, so
 * `backend_port` had nothing to report, so `getApiUrl()` returned `null`, so this
 * component took the `!located` branch and rendered:
 *
 *   «لم يُعثر على خادم ولاء» — with a text box asking the shop owner to type a server
 *   address, **on the machine that is the server**.
 *
 * Three faults in one screen. The **cause** was wrong: the settings file was missing,
 * not the server. The **remedy** was wrong: no address he could type would start a
 * service on this machine. And the **field should not exist here at all** — a control
 * offering to repoint a working manager PC at some other machine is how a merchant
 * talks himself into breaking an install that was fine.
 *
 * The root of it was that `null` from `getApiUrl()` was carrying two unrelated
 * meanings — "this machine hosts nothing, so somebody must say where to look" and
 * "this machine hosts a backend that cannot tell me its port" — and the screen picked
 * the first every time.
 *
 * ── The five states, kept apart ──────────────────────────────────────────────
 *
 * The shell now reports what this MACHINE has, so each is answerable:
 *
 *   | state                        | how it is known                  | address field |
 *   |------------------------------|----------------------------------|---------------|
 *   | starting                     | inside the patience window       | no            |
 *   | installed, settings missing   | hosts a service, no `walaa.env`  | **no**        |
 *   | installed, not running        | hosts a service, config present  | **no**        |
 *   | configured, remote failing    | a remote address is saved        | yes           |
 *   | hosts nothing, none configured| a second machine                 | yes           |
 *
 * The remote case splits three further ways — unreachable, answering but not ولاء, and
 * a version mismatch — because those need opposite next moves and used to be one
 * sentence.
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

/** What the gate has established, once the patience window has passed. */
type Diagnosis =
  | { kind: 'starting' }
  /** Installed here; `walaa.env` is gone. No address can help. */
  | { kind: 'config-missing' }
  /** Installed and configured here; nothing is listening. */
  | { kind: 'not-running' }
  /** The backend answered with a reason for refusing to start. */
  | { kind: 'refused' }
  /** An address is saved for another machine and it is failing. */
  | { kind: 'remote'; why: 'unreachable' | 'not-walaa' | 'version' }
  /** This machine hosts nothing and nothing is configured. */
  | { kind: 'unconfigured' };

interface Props {
  children: React.ReactNode;
}

export function BackendGate({ children }: Props): React.ReactElement {
  const [healthy, setHealthy] = useState(false);
  const [status, setStatus] = useState<BackendStatus | null>(null);
  const [diagnosis, setDiagnosis] = useState<Diagnosis>({ kind: 'starting' });
  const [elapsed, setElapsed] = useState(0);
  const [checking, setChecking] = useState(false);
  const started = useRef(Date.now());
  /** So the standing state is logged once rather than once per poll. */
  const lastLogged = useRef<string | null>(null);

  const probe = useCallback(async () => {
    const [base, remote, next] = await Promise.all([
      getApiUrl(),
      getRemoteApiUrl(),
      readBackendStatus(),
    ]);

    setStatus(next);
    setElapsed(Date.now() - started.current);

    if (base) {
      const result = await probeBackend(base);
      if (result.ok) {
        setHealthy(true);
        return;
      }

      /*
        Something is configured and it is not answering as this product. Which of the
        five states that is depends on WHOSE backend it is: a saved remote address
        failing is the merchant's network or a typo, and this machine's own service
        failing is a service to restart — and the two have no remedy in common.
      */
      setDiagnosis(
        remote
          ? { kind: 'remote', why: result.why }
          : next.reason
            ? { kind: 'refused' }
            : { kind: 'not-running' },
      );
    } else if (remote) {
      // A remote is saved but produced no usable base — a malformed stored value.
      setDiagnosis({ kind: 'remote', why: 'unreachable' });
    } else if (next.hostsService) {
      /*
        ── The state that used to be reported as "no server found" ─────────────

        This machine HAS the service installed. The port could not be resolved, which
        means the service has not published one — and the commonest reason for that, by
        a distance, is that `walaa.env` is not there for it to read.
      */
      setDiagnosis(next.configPresent ? { kind: 'not-running' } : { kind: 'config-missing' });
    } else {
      // Genuinely a machine with nothing on it: a second PC someone installed the
      // dashboard on. This is the ONE state where an address is a real question.
      setDiagnosis({ kind: 'unconfigured' });
    }

    /*
      ── The diagnostics go to the console, not to the screen ──────────────────

      This panel used to render the attempt count and a disclosure listing the exact
      files consulted. Both were put there for a good reason — the defect that produced
      this whole component was two processes disagreeing about which file was in play,
      with no surface naming either — and both were aimed at me, printed on a shop
      owner's screen.

      Logged once per distinct state rather than at 1 Hz: a console filling at every
      poll buries the line somebody is looking for.
    */
    const signature = JSON.stringify({
      state: next.state,
      hostsService: next.hostsService,
      configPresent: next.configPresent,
      databasePresent: next.databasePresent,
      base,
      remote,
    });
    if (lastLogged.current !== signature) {
      lastLogged.current = signature;
      console.error('[backend] not serving', {
        ...next,
        base,
        remote,
      });
    }
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

  const retry = (
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
  );

  // Inside the patience window, or the supervisor says it is still coming up. A cold
  // SQLite open is several seconds on a shop PC and is not a fault.
  if (elapsed < PATIENCE_MS || status?.state === 'starting') {
    return (
      <Frame>
        <Loader2 className="size-6 animate-spin text-accent" aria-hidden />
        <h1 className="text-xl font-semibold text-ink">{locale.backend.startingTitle}</h1>
        <p className="max-w-prose text-steel">{locale.backend.startingBody}</p>
      </Frame>
    );
  }

  /*
    ── The one place outside Settings that may show an address field ───────────

    And only in the two states where an address is genuinely the question. On a machine
    that hosts the service it is not a question, so the field is absent — see the header
    for what showing it there cost.
  */
  if (diagnosis.kind === 'unconfigured') {
    return (
      <Frame>
        <ServerOff className="size-6 text-amber" aria-hidden />
        <h1 className="text-xl font-semibold text-ink">{locale.backend.missingTitle}</h1>
        <p className="max-w-prose leading-relaxed text-steel">{locale.backend.missingBody}</p>
        <div className="w-full max-w-prose rounded-2xl border border-border bg-surface p-6 text-start">
          <ServerAddressForm onSaved={() => window.location.reload()} />
        </div>
        {retry}
      </Frame>
    );
  }

  if (diagnosis.kind === 'remote') {
    const copy =
      diagnosis.why === 'not-walaa'
        ? { title: locale.backend.remoteNotWalaaTitle, body: locale.backend.remoteNotWalaaBody }
        : diagnosis.why === 'version'
          ? { title: locale.backend.remoteVersionTitle, body: locale.backend.remoteVersionBody }
          : {
              title: locale.backend.remoteUnreachableTitle,
              body: locale.backend.remoteUnreachableBody,
            };

    return (
      <Frame>
        <AlertTriangle className="size-6 text-red" aria-hidden />
        <h1 className="text-xl font-semibold text-ink">{copy.title}</h1>
        <p className="max-w-prose leading-relaxed text-steel">{copy.body}</p>
        {/*
          A version mismatch is the one remote failure a new address does not fix: both
          machines have to be updated, and offering a box invites the merchant to hunt
          for an address that does not exist.
        */}
        {diagnosis.why === 'version' ? null : (
          <div className="w-full max-w-prose rounded-2xl border border-border bg-surface p-6 text-start">
            <ServerAddressForm onSaved={() => window.location.reload()} />
          </div>
        )}
        {retry}
      </Frame>
    );
  }

  if (diagnosis.kind === 'config-missing') {
    return (
      <Frame>
        <SettingsIcon className="size-6 text-red" aria-hidden />
        <h1 className="text-xl font-semibold text-ink">{locale.backend.configMissingTitle}</h1>
        <p className="max-w-prose leading-relaxed text-steel">{locale.backend.configMissingBody}</p>
        {/* No address field. The service is on THIS machine and no address starts it. */}
        {retry}
      </Frame>
    );
  }

  if (diagnosis.kind === 'not-running') {
    return (
      <Frame>
        <AlertTriangle className="size-6 text-amber" aria-hidden />
        <h1 className="text-xl font-semibold text-ink">{locale.backend.notRunningTitle}</h1>
        <p className="max-w-prose leading-relaxed text-steel">{locale.backend.notRunningBody}</p>
        {retry}
      </Frame>
    );
  }

  /* The backend refused to start and said why. Its own sentence wins over anything
     this component could compose. */
  const { title, body } =
    status?.state === 'terminal'
      ? { title: locale.backend.terminalTitle, body: locale.backend.terminalBody }
      : status?.state === 'stopped'
        ? { title: locale.backend.stoppedTitle, body: locale.backend.stoppedBody }
        : status?.state === 'failed'
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

      {retry}
    </Frame>
  );
}

/**
 * The full-height shell every state above renders into.
 *
 * ── It scrolls, and that is a fix ────────────────────────────────────────────
 *
 * `body { overflow: hidden }` used to make the document unscrollable, and this frame
 * had no scroll container of its own — so on the minimum window size a state carrying
 * a title, a paragraph, an address form and a button simply had its lower half
 * clipped, unreachably. The body scrolls now (`styles/globals.css`), and `my-auto`
 * rather than `justify-center` is what keeps the content centred when it fits while
 * letting it scroll from the TOP when it does not: a centred flex child taller than
 * its container overflows in both directions, and the half above the fold cannot be
 * scrolled back to.
 */
function Frame({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex min-h-[100dvh] flex-col bg-canvas px-6 py-10">
      <div className="my-auto flex flex-col items-center gap-4 text-center">{children}</div>
    </div>
  );
}
