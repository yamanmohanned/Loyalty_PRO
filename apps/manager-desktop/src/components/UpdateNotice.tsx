import { useState, useSyncExternalStore } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { locale } from '../lib/locale';
import { isTauri } from '../lib/config';
import { Button, Notice } from './ui';

/**
 * The update path, as the merchant experiences it.
 *
 * ── Why the plugin's own dialog is switched off ──────────────────────────────
 *
 * `tauri.conf.json` sets `dialog: false`. The built-in one is an English, unstyled
 * OS modal that appears over whatever the merchant is doing and asks a yes/no question
 * about a "release". This shop owner is not technical, reads Arabic, and has no idea
 * what a release is. So the plugin does the work and this does the asking.
 *
 * ── The shape of it ──────────────────────────────────────────────────────────
 *
 *  1. Check once, a few seconds after launch. Not on a timer: the app is opened and
 *     closed daily, so launch is a natural and sufficient moment, and a background
 *     poller is a thing that can go wrong while nobody is looking.
 *  2. If something is available, **download it in the background immediately** and say
 *     nothing until it is ready. A notice that appears and then makes him wait is
 *     worse than one that appears when there is nothing left to wait for.
 *  3. Then one quiet line: an update is ready, restart to apply. Dismissible. It is
 *     applied on the next start whether or not he presses the button, because the
 *     installer runs on exit — so the button is a convenience, not a requirement.
 *
 * ── Failure is silent, deliberately ──────────────────────────────────────────
 *
 * No feed, no internet, a DNS failure, a corrupt signature — every one of those ends
 * with this component rendering nothing. A merchant who is offline has not done
 * anything wrong and cannot act on the news, and an error bar about an update server
 * on the dashboard of a working shop is pure noise. The failure is logged to the
 * console for a support call and goes no further.
 */

type State =
  | { phase: 'idle' }
  | { phase: 'downloading' }
  | { phase: 'ready'; version: string }
  | { phase: 'restarting' };

/*
  ── The check runs at APP level, the notice renders inside the shell ──────────

  A module-level store rather than component state, because the two happen in
  different places and at different times. Checking does not require a session — an
  update is a property of the machine, not of who is logged into it — so waiting for
  login to start a 34 MB download means the merchant meets the notice later than he
  needed to, and on a shop PC that stays on the login screen it never happens at all.

  Splitting them also makes the path testable: the check fires on launch, so a build
  pointed at a local feed can be observed fetching and downloading without anyone
  typing a password into a webview.
*/
let current: State = { phase: 'idle' };
const listeners = new Set<() => void>();

function setState(next: State): void {
  current = next;
  for (const notify of listeners) notify();
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

let started = false;

/**
 * Starts the one check, once per process. Mounted by `App`, above the session gate.
 */
export function startUpdateCheck(): void {
  // Only inside the desktop shell. In a browser dev session the plugin is not there,
  // and importing it would throw on a screen that has nothing to do with it.
  if (started || !isTauri()) return;
  started = true;

  setTimeout(() => {
    void (async () => {
      try {
        // Imported lazily so a browser dev session never loads the plugin at all.
        const { check } = await import('@tauri-apps/plugin-updater');
        const update = await check();
        if (!update) return;

        setState({ phase: 'downloading' });
        await update.download();
        setState({ phase: 'ready', version: update.version });
      } catch (error) {
        // See the docblock: offline is the common case and is not news.
        console.warn('update check failed', error);
      }
    })();
  }, 4000);
}

export function UpdateNotice() {
  const state = useSyncExternalStore(subscribe, () => current, () => current);
  const [dismissed, setDismissed] = useState(false);

  if (state.phase !== 'ready' || dismissed) return null;

  return (
    <div className="border-b border-border bg-accent-tint/60 px-8 py-2.5">
      <div className="mx-auto flex max-w-content items-center gap-3">
        <Download size={18} className="shrink-0 text-accent" aria-hidden />
        <p className="min-w-0 flex-1 text-sm text-ink">
          {locale.update.ready}{' '}
          <bdi dir="ltr" className="font-mono">
            {state.version}
          </bdi>
        </p>
        <Button
          variant="secondary"
          className="min-h-0 px-3 py-1.5 text-sm"
          onClick={() => {
            void (async () => {
              try {
                const { relaunch } = await import('@tauri-apps/plugin-process');
                await relaunch();
              } catch (error) {
                // It still installs on the next ordinary exit, so doing nothing is a
                // recovery. No error surface for that.
                console.warn('relaunch failed', error);
              }
            })();
          }}
        >
          <RefreshCw size={16} aria-hidden />
          {locale.update.restart}
        </Button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="shrink-0 rounded-md px-2 py-1 text-sm text-steel transition-colors duration-fast hover:text-ink"
        >
          {locale.update.later}
        </button>
      </div>
    </div>
  );
}

/**
 * The same fact, told on the Backup screen where a support call ends up.
 *
 * Not a duplicate of the bar: the bar is transient and dismissible, and «ما هو
 * الإصدار المثبَّت عندك؟» is a question somebody will ask over the phone months later.
 */
export function InstalledVersion() {
  return (
    <Notice tone="neutral">
      {locale.update.installed}{' '}
      <bdi dir="ltr" className="font-mono">
        {__APP_VERSION__}
      </bdi>
    </Notice>
  );
}
