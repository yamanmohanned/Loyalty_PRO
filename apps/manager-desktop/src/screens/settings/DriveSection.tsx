import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cloud, CloudOff, ExternalLink, Link2Off, RefreshCw } from 'lucide-react';
import type {
  DriveConnectProgress,
  DriveConnectStart,
  DriveStatus,
} from '@walaa/shared-types';
import { api } from '../../lib/api';
import { locale } from '../../lib/locale';
import { Button, Card, CardHeader, Chip, Field, Input, Notice } from '../../components/ui';

/**
 * Google Drive, as the merchant sees it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  Additive by construction — this panel can only ever report
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Backing up to Drive is a second destination, not a change of plan. The local backup
 * runs whether or not any of this works, and a Drive failure degrades to «the local
 * copy was written and the upload was not» rather than to a failed backup. Nothing on
 * this panel can stop a backup happening.
 *
 * So the panel's whole job is to say which of four situations the shop is in, and it
 * must never leave the merchant unable to tell:
 *
 *   **not set up**   — no OAuth client on this machine. The most likely state, and the
 *                      one that must not read as a fault: it needs a one-time setup
 *                      from whoever supplied the software, and until then backups are
 *                      local-only, which is a real risk worth naming out loud.
 *   **set up, not connected** — nobody has granted access, or somebody withdrew it.
 *   **connected**    — with the last successful upload's time, which is the one fact
 *                      that tells him the arrangement is actually working.
 *   **connected, failing** — the API classifies why (no network, revoked, expired,
 *                      quota, wrong client, permission) and hands over a sentence and
 *                      a remedy for each. They are rendered verbatim: paraphrasing a
 *                      message written for this reader is how the specificity is lost.
 *
 * ── Why the browser opens rather than a window inside the app ────────────────
 *
 * Google's consent screen refuses to load in an embedded webview, and it is right to:
 * a merchant typing a Google password should be looking at his own browser's address
 * bar. The API starts a loopback listener, hands back the URL, and this polls until
 * the grant comes home.
 */
export function DriveSection() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<number | null>(null);

  const status = useQuery({
    queryKey: ['drive'],
    queryFn: () => api.get<DriveStatus>('/backup/drive'),
  });

  /** Stops the consent poll — on success, on failure, and on unmount. */
  const stopPolling = () => {
    if (pollTimer.current !== null) {
      window.clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  };
  useEffect(() => stopPolling, []);

  const connect = useMutation({
    mutationFn: () => api.post<DriveConnectStart>('/backup/drive/connect', {}),
    onSuccess: (start) => {
      setError(null);
      setNotice(locale.settings.drive.consentOpened);

      /*
        The URL is opened in the merchant's own browser. `window.open` is what the
        Tauri shell turns into a real browser launch; in a plain browser it is a tab.
        Either way the app keeps polling, so a merchant who closes the tab is not left
        with a panel that waits forever — the attempt expires and says so.
      */
      window.open(start.authUrl, '_blank', 'noopener,noreferrer');

      stopPolling();
      pollTimer.current = window.setInterval(() => {
        void api
          .get<DriveConnectProgress>('/backup/drive/connect/status')
          .then((progress) => {
            if (progress.state === 'CONNECTED') {
              stopPolling();
              setNotice(locale.settings.drive.connected);
              void queryClient.invalidateQueries({ queryKey: ['drive'] });
            } else if (progress.state === 'FAILED') {
              stopPolling();
              setNotice(null);
              setError(progress.failure?.message ?? locale.common.error);
            }
          })
          .catch(() => {
            /* A poll that fails is not itself a failure; the next one may answer. */
          });
      }, 1500);
    },
    onError: (caught: Error) => {
      setNotice(null);
      setError(caught.message);
    },
  });

  const disconnect = useMutation({
    mutationFn: () => api.post('/backup/drive/disconnect', {}),
    onSuccess: () => {
      setError(null);
      setNotice(locale.settings.drive.disconnected);
      void queryClient.invalidateQueries({ queryKey: ['drive'] });
    },
    onError: (caught: Error) => setError(caught.message),
  });

  const save = useMutation({
    mutationFn: (update: { enabled?: boolean; keep?: number }) =>
      api.patch('/backup/drive/settings', update),
    onSuccess: () => {
      setError(null);
      setNotice(locale.common.saved);
      void queryClient.invalidateQueries({ queryKey: ['drive'] });
    },
    onError: (caught: Error) => setError(caught.message),
  });

  const data = status.data;

  return (
    <Card>
      <CardHeader title={locale.settings.drive.title} />
      <div className="space-y-5 p-6">
        {status.isLoading || !data ? (
          <p className="text-steel">{locale.common.loading}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <span
                className={
                  data.connected
                    ? 'flex size-10 items-center justify-center rounded-md bg-accent-tint text-accent'
                    : 'flex size-10 items-center justify-center rounded-md bg-canvas text-steel'
                }
              >
                {data.connected ? <Cloud size={20} aria-hidden /> : <CloudOff size={20} aria-hidden />}
              </span>

              <Chip tone={data.connected ? 'success' : data.configured ? 'warning' : 'neutral'}>
                {data.connected
                  ? locale.settings.drive.stateConnected
                  : data.configured
                    ? locale.settings.drive.stateNotConnected
                    : locale.settings.drive.stateNotConfigured}
              </Chip>

              {/* The one fact that says the arrangement is actually working. */}
              {data.lastSuccessAt ? (
                <span className="text-sm text-steel">
                  {locale.settings.drive.lastSuccess}{' '}
                  <bdi>{new Date(data.lastSuccessAt).toLocaleString('ar-IQ')}</bdi>
                </span>
              ) : null}
            </div>

            {/*
              The API's own classification, verbatim. It distinguishes no-network from
              a withdrawn grant from an expired token from a full Drive, and each has
              its own next step — collapsing them into one sentence here would throw
              away the entire point of that work.
            */}
            {data.failure ? (
              <Notice
                tone={data.failure.code === 'NOT_CONFIGURED' ? 'warning' : 'danger'}
                title={data.failure.message}
              >
                {data.failure.remedy}
              </Notice>
            ) : null}

            <p className="text-sm leading-relaxed text-steel">
              {locale.settings.drive.scopeNote}
            </p>

            {data.configured ? (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  {data.connected ? (
                    <Button
                      variant="secondary"
                      onClick={() => disconnect.mutate()}
                      disabled={disconnect.isPending}
                    >
                      <Link2Off size={18} aria-hidden />
                      {locale.settings.drive.disconnect}
                    </Button>
                  ) : (
                    <Button onClick={() => connect.mutate()} disabled={connect.isPending}>
                      <ExternalLink size={18} aria-hidden />
                      {connect.isPending
                        ? locale.settings.drive.connecting
                        : locale.settings.drive.connect}
                    </Button>
                  )}

                  <Button
                    variant="ghost"
                    onClick={() => void status.refetch()}
                    disabled={status.isFetching}
                  >
                    <RefreshCw size={18} aria-hidden />
                    {locale.common.retry}
                  </Button>
                </div>

                {/* Retention: how many copies Drive keeps before the oldest is dropped. */}
                <Field label={locale.settings.drive.keepLabel} hint={locale.settings.drive.keepHint}>
                  <Input
                    type="number"
                    min={1}
                    max={365}
                    defaultValue={data.keep}
                    dir="ltr"
                    className="text-start"
                    onBlur={(e) => {
                      const keep = Number(e.target.value);
                      if (Number.isInteger(keep) && keep >= 1 && keep !== data.keep) {
                        save.mutate({ keep });
                      }
                    }}
                  />
                </Field>
              </>
            ) : null}

            {error ? <Notice tone="danger">{error}</Notice> : null}
            {notice ? <Notice tone="accent">{notice}</Notice> : null}
          </>
        )}
      </div>
    </Card>
  );
}
