import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  AlertOctagon,
  CheckCircle2,
  Cloud,
  CloudOff,
  Copy,
  ExternalLink,
  KeyRound,
  Link2Off,
  MinusCircle,
  RefreshCw,
} from 'lucide-react';
import {
  DriveClientUpdateSchema,
  type DriveClientUpdate,
  type DriveConnectProgress,
  type DriveConnectStart,
  type DriveFailure,
  type DriveStatus,
  type DriveTestResult,
} from '@walaa/shared-types';
import { api } from '../../lib/api';
import { openInBrowser } from '../../lib/external';
import { useFormErrors } from '../../lib/form';
import { formatDateTime, locale } from '../../lib/locale';
import {
  Button,
  Card,
  CardHeader,
  Chip,
  Field,
  FormOutcome,
  InlineFailure,
  Input,
  Notice,
  Skeleton,
} from '../../components/ui';

/**
 * Google Drive, as the merchant sees it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  One status, one outcome, a pending label on every button
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * On 2026-09-16 this card showed a red refusal, a green «فُتحت صفحة الموافقة» and a red
 * «عدد كبير من المحاولات» at once — three independent pieces of state, each true when it
 * was set and never cleared by the next. And the button that produced them did nothing
 * visible. So the card is now built from two things only:
 *
 *   1. **The status** — exactly one of: not configured · configured but not linked ·
 *      linked (with the account) · error (with the reason and what to do). Derived from
 *      the service's answer and the last consent attempt, never stored beside them, so it
 *      cannot go stale. Every Drive failure is described HERE and nowhere else.
 *   2. **The outcome of the last action** — its success or its failure, one or the other
 *      (`useFormErrors`), cleared when the next action starts. A success is never shown
 *      while the status is an error.
 *
 * Backing up to Drive is additive: the local backup runs whether or not any of this works,
 * and nothing on this card can stop it.
 *
 * ── Why the browser opens rather than a window inside the app ────────────────
 *
 * Google's consent screen refuses to load in an embedded webview, and it is right to: a
 * merchant typing a Google password should be looking at his own browser's address bar.
 * The service opens a loopback listener on 127.0.0.1 and hands back the URL; the shell
 * gives it to Windows (`openInBrowser`, the opener plugin); this card polls until the grant
 * comes home. If the browser cannot be opened the card says why, and shows the link to copy.
 */

type Status =
  | { kind: 'not-configured' }
  | { kind: 'not-linked' }
  | { kind: 'linked' }
  | { kind: 'error'; title: string; remedy: string };

/** Failures that describe a state the other three statuses already name. */
const NOT_AN_ERROR = new Set(['NOT_CONFIGURED', 'NOT_CONNECTED']);

function statusOf(data: DriveStatus, consentFailure: DriveFailure | null): Status {
  const text = locale.settings.drive.status;
  if (consentFailure && !data.connected) {
    return { kind: 'error', title: text.connectFailedTitle, remedy: `${consentFailure.message} ${consentFailure.remedy}` };
  }
  if (data.failure && !NOT_AN_ERROR.has(data.failure.code)) {
    return { kind: 'error', title: data.failure.message, remedy: data.failure.remedy };
  }
  if (!data.configured) return { kind: 'not-configured' };
  if (!data.connected) return { kind: 'not-linked' };
  return { kind: 'linked' };
}

/** A consent page waiting for the merchant, and whether his browser actually got it. */
interface Waiting {
  authUrl: string;
  refusal: 'blocked' | 'failed' | null;
}

export function DriveSection() {
  const text = locale.settings.drive;
  const queryClient = useQueryClient();
  /* The one outcome slot for the whole card — field marks included (client id, secret,
     retention), so a refusal and a success can never both be on screen. */
  const outcome = useFormErrors();
  const [test, setTest] = useState<DriveTestResult | null>(null);
  const [editingClient, setEditingClient] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [consentFailure, setConsentFailure] = useState<DriveFailure | null>(null);
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const pollTimer = useRef<number | null>(null);

  const status = useQuery({
    queryKey: ['drive'],
    queryFn: () => api.get<DriveStatus>('/backup/drive'),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['drive'] });

  const stopPolling = () => {
    if (pollTimer.current !== null) {
      window.clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  };
  useEffect(() => stopPolling, []);

  /** Every action starts from a clean slate: no earlier outcome, test or copy note. */
  const begin = () => {
    outcome.clear();
    setCopied('idle');
  };

  const poll = () => {
    stopPolling();
    pollTimer.current = window.setInterval(() => {
      api
        .get<DriveConnectProgress>('/backup/drive/connect/status')
        .then((progress) => {
          if (progress.state === 'CONNECTED') {
            stopPolling();
            setWaiting(null);
            void refresh();
          } else if (progress.state === 'FAILED' || progress.state === 'IDLE') {
            // IDLE while we wait means the service restarted and the attempt is gone.
            stopPolling();
            setWaiting(null);
            setConsentFailure(
              progress.failure ?? {
                code: 'NOT_CONNECTED',
                message: text.status.connectFailedTitle,
                remedy: locale.failure.unexpected,
                at: new Date().toISOString(),
              },
            );
          }
        })
        .catch(() => {
          /* One unanswered poll is not a failure; the next one may answer. The attempt
             itself expires on the service and says so. */
        });
    }, 1500);
  };

  const connect = useMutation({
    mutationFn: () => api.post<DriveConnectStart>('/backup/drive/connect', {}),
    onMutate: () => {
      begin();
      setConsentFailure(null);
    },
    onSuccess: async (start) => {
      const result = await openInBrowser(start.authUrl);
      setWaiting({ authUrl: start.authUrl, refusal: result.opened ? null : result.reason });
      poll();
    },
    onError: (caught: Error) => outcome.fail(caught),
  });

  const reopen = async () => {
    if (!waiting) return;
    setCopied('idle');
    const result = await openInBrowser(waiting.authUrl);
    setWaiting({ ...waiting, refusal: result.opened ? null : result.reason });
  };

  const copyLink = async () => {
    if (!waiting) return;
    try {
      await navigator.clipboard.writeText(waiting.authUrl);
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
  };

  const cancelWaiting = () => {
    stopPolling();
    setWaiting(null);
    setCopied('idle');
  };

  const disconnect = useMutation({
    mutationFn: () => api.post('/backup/drive/disconnect', {}),
    onMutate: () => {
      begin();
      setTest(null);
      setConsentFailure(null);
    },
    onSuccess: () => refresh(),
    onError: (caught: Error) => outcome.fail(caught),
  });

  const saveKeep = useMutation({
    mutationFn: (update: { enabled?: boolean; keep?: number }) => api.patch('/backup/drive/settings', update),
    onMutate: begin,
    onSuccess: async () => {
      await refresh();
      outcome.succeed(text.keepSaved);
    },
    onError: (caught: Error) => outcome.fail(caught),
  });

  const saveClient = useMutation({
    mutationFn: (update: DriveClientUpdate) => api.put<DriveStatus>('/backup/drive/client', update),
    onSuccess: () => {
      setEditingClient(false);
      setClientId('');
      // The secret is dropped from memory the moment the service has it.
      setClientSecret('');
      setConsentFailure(null);
      void refresh();
    },
    onError: (caught: Error) => outcome.fail(caught),
  });

  const clearClient = useMutation({
    mutationFn: () => api.delete<DriveStatus>('/backup/drive/client'),
    onMutate: () => {
      begin();
      setConsentFailure(null);
    },
    onSuccess: () => refresh(),
    onError: (caught: Error) => outcome.fail(caught),
  });

  const runTest = useMutation({
    mutationFn: () => api.post<DriveTestResult>('/backup/drive/test'),
    onMutate: () => {
      begin();
      setTest(null);
    },
    onSuccess: (result) => {
      setTest(result);
      void refresh();
    },
    onError: (caught: Error) => outcome.fail(caught),
  });

  const uploadNow = useMutation({
    mutationFn: () => api.post<{ destinations: Array<{ kind: string; ok: boolean }> }>('/backup/run'),
    onMutate: () => {
      begin();
      setTest(null);
    },
    onSuccess: async (run) => {
      const fresh = await status.refetch();
      const drive = run.destinations.find((destination) => destination.kind === 'drive');
      if (drive?.ok) {
        outcome.succeed(text.uploadedNow);
        return;
      }
      // A classified reason is the status's to show; say something here only if it has none.
      if (!fresh.data || statusOf(fresh.data, null).kind !== 'error') {
        outcome.rejectForm(drive ? text.uploadFailedNoReason : text.uploadNotRegistered);
      }
    },
    onError: (caught: Error) => outcome.fail(caught),
  });

  const submitClient = () => {
    begin();
    const parsed = outcome.validate(DriveClientUpdateSchema, { clientId, clientSecret });
    if (parsed) saveClient.mutate(parsed);
  };

  const data = status.data;

  if (status.isError) {
    return (
      <Card>
        <CardHeader title={text.title} />
        <div className="p-6">
          <InlineFailure what={locale.failure.what.drive} error={status.error} onRetry={() => void status.refetch()} />
        </div>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card>
        <CardHeader title={text.title} />
        <div className="space-y-3 p-6" aria-busy="true">
          <Skeleton className="h-16" />
          <Skeleton className="h-24" />
        </div>
      </Card>
    );
  }

  const current = statusOf(data, consentFailure);
  const busy =
    connect.isPending ||
    disconnect.isPending ||
    saveClient.isPending ||
    clearClient.isPending ||
    runTest.isPending ||
    uploadNow.isPending ||
    saveKeep.isPending;

  return (
    <Card>
      <CardHeader
        title={text.title}
        action={
          <Chip
            tone={
              current.kind === 'linked'
                ? 'success'
                : current.kind === 'error'
                  ? 'danger'
                  : current.kind === 'not-linked'
                    ? 'warning'
                    : 'neutral'
            }
          >
            {current.kind === 'linked'
              ? text.stateConnected
              : current.kind === 'error'
                ? text.stateError
                : current.kind === 'not-linked'
                  ? text.stateNotConnected
                  : text.stateNotConfigured}
          </Chip>
        }
      />
      <div className="space-y-6 p-6">
        {/* ── The one status ─────────────────────────────────────────────── */}
        <StatusPanel status={current} data={data} />

        {/* 1 ── The OAuth client ─────────────────────────────────────────── */}
        <section className="space-y-3">
          <h3 className="text-base font-semibold text-ink">{text.clientTitle}</h3>
          <p className="text-sm leading-relaxed text-steel">{text.clientIntro}</p>

          {data.client && !editingClient ? (
            <>
              <div className="flex flex-wrap items-center gap-3 rounded-md border border-border p-4">
                <KeyRound size={20} className="shrink-0 text-accent" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-steel">{text.clientIdLabel}</p>
                  <p className="break-all font-mono text-sm text-ink" dir="ltr">
                    {data.client.clientId}
                  </p>
                  <p className="text-sm text-steel">
                    {data.client.source === 'settings'
                      ? text.secretStored(data.client.savedAt ? formatDateTime(data.client.savedAt) : '—')
                      : text.clientFromEnvironment}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  disabled={busy || data.connected}
                  onClick={() => {
                    begin();
                    setEditingClient(true);
                    setClientId(data.client?.clientId ?? '');
                    setClientSecret('');
                  }}
                >
                  {text.clientChange}
                </Button>
                <Button variant="ghost" disabled={busy || data.connected} onClick={() => clearClient.mutate()}>
                  {clearClient.isPending ? text.clearing : text.clientClear}
                </Button>
              </div>
              {data.connected ? <p className="text-sm text-steel">{text.clientClearBlocked}</p> : null}
            </>
          ) : (
            <form
              ref={outcome.ref}
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                submitClient();
              }}
            >
              <Field label={text.clientIdLabel} hint={text.clientIdHint} error={outcome.fields.clientId}>
                <Input
                  name="clientId"
                  value={clientId}
                  onChange={(event) => {
                    setClientId(event.target.value);
                    outcome.clearField('clientId');
                  }}
                  dir="ltr"
                  className="font-mono text-start"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <Field label={text.clientSecretLabel} hint={text.clientSecretHint} error={outcome.fields.clientSecret}>
                <Input
                  name="clientSecret"
                  type="password"
                  value={clientSecret}
                  onChange={(event) => {
                    setClientSecret(event.target.value);
                    outcome.clearField('clientSecret');
                  }}
                  dir="ltr"
                  className="font-mono text-start"
                  autoComplete="new-password"
                  spellCheck={false}
                />
              </Field>
              <div className="flex flex-wrap gap-3">
                <Button type="submit" disabled={busy}>
                  {saveClient.isPending ? text.saving : text.clientSave}
                </Button>
                {data.client ? (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={saveClient.isPending}
                    onClick={() => {
                      setEditingClient(false);
                      setClientSecret('');
                      outcome.clear();
                    }}
                  >
                    {locale.common.cancel}
                  </Button>
                ) : null}
              </div>
              <p className="text-sm text-steel">{text.clientStoredNote}</p>
            </form>
          )}
        </section>

        {/* 2 ── The Google account ───────────────────────────────────────── */}
        {data.configured ? (
          <section className="space-y-3 border-t border-border pt-6">
            <h3 className="text-base font-semibold text-ink">{text.accountTitle}</h3>
            {data.connected ? (
              <div className="flex flex-wrap items-center gap-3 rounded-md border border-border p-4">
                <span className="flex size-10 items-center justify-center rounded-md bg-accent-tint text-accent">
                  <Cloud size={20} aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-steel">{text.accountLinked}</p>
                  {data.account?.email ? (
                    <p className="break-all font-mono text-sm text-ink" dir="ltr">
                      {data.account.email}
                    </p>
                  ) : (
                    <p className="text-sm text-ink">{text.accountUnknown}</p>
                  )}
                  {data.account?.name ? <p className="text-sm text-ink">{data.account.name}</p> : null}
                  {data.connectedAt ? (
                    <p className="text-sm text-steel">{text.connectedSince(formatDateTime(data.connectedAt))}</p>
                  ) : null}
                </div>
                <Button variant="secondary" onClick={() => disconnect.mutate()} disabled={busy}>
                  <Link2Off size={18} aria-hidden />
                  {disconnect.isPending ? text.disconnecting : text.disconnect}
                </Button>
              </div>
            ) : waiting ? (
              <WaitingPanel
                waiting={waiting}
                copied={copied}
                onReopen={() => void reopen()}
                onCopy={() => void copyLink()}
                onCancel={cancelWaiting}
              />
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <span className="flex size-10 items-center justify-center rounded-md bg-canvas text-steel">
                  <CloudOff size={20} aria-hidden />
                </span>
                <Button onClick={() => connect.mutate()} disabled={busy}>
                  <ExternalLink size={18} aria-hidden />
                  {connect.isPending ? text.connecting : text.connect}
                </Button>
              </div>
            )}
            <p className="text-sm leading-relaxed text-steel">{text.scopeNote}</p>
          </section>
        ) : null}

        {/* 3 ── Is it working ────────────────────────────────────────────── */}
        {data.connected ? (
          <section className="space-y-4 border-t border-border pt-6">
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <dt className="text-sm text-steel">{text.lastSuccess}</dt>
                <dd className="font-mono text-sm text-ink">
                  {data.lastSuccessAt ? formatDateTime(data.lastSuccessAt) : text.never}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-steel">{text.nextUpload}</dt>
                <dd className="font-mono text-sm text-ink">
                  {data.enabled && data.schedule.enabled && data.schedule.nextRunAt
                    ? formatDateTime(data.schedule.nextRunAt)
                    : text.noSchedule}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-steel">{text.copiesInDrive}</dt>
                <dd className="font-mono text-sm text-ink">{text.copiesCount(data.backups.length, data.keep)}</dd>
              </div>
            </dl>

            {/* Retention: how many copies Drive keeps before the oldest is dropped. */}
            <Field
              label={text.keepLabel}
              hint={saveKeep.isPending ? text.saving : text.keepHint}
              error={outcome.fields.keep}
            >
              <Input
                type="number"
                min={1}
                max={365}
                defaultValue={data.keep}
                dir="ltr"
                className="text-start"
                disabled={saveKeep.isPending}
                onBlur={(event) => {
                  const keep = Number(event.target.value);
                  if (Number.isInteger(keep) && keep >= 1 && keep !== data.keep) saveKeep.mutate({ keep });
                }}
              />
            </Field>

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => uploadNow.mutate()} disabled={busy || !data.enabled}>
                {uploadNow.isPending ? text.uploading : text.uploadNow}
              </Button>
              <Button variant="secondary" onClick={() => runTest.mutate()} disabled={busy}>
                {runTest.isPending ? text.testing : text.test}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  begin();
                  void status.refetch();
                }}
                disabled={busy || status.isFetching}
              >
                <RefreshCw size={18} aria-hidden />
                {status.isFetching ? text.refreshing : locale.common.retry}
              </Button>
            </div>

            {test ? <TestResult result={test} statusShowsError={current.kind === 'error'} /> : null}

            <p className="text-sm text-steel">
              {text.restoreHint}{' '}
              <Link to="/backup" className="text-accent underline">
                {text.restoreLink}
              </Link>
            </p>
          </section>
        ) : null}

        {/* The last action's outcome — one or none; never a success beside an error status. */}
        <FormOutcome form={{ summary: outcome.summary, success: current.kind === 'error' ? null : outcome.success }} />
      </div>
    </Card>
  );
}

function StatusPanel({ status, data }: { status: Status; data: DriveStatus }) {
  const text = locale.settings.drive.status;
  switch (status.kind) {
    case 'error':
      return (
        <div role="alert">
          <Notice tone="danger" title={status.title}>
            {status.remedy}
          </Notice>
        </div>
      );
    case 'not-configured':
      return (
        <Notice tone="neutral" title={text.notConfiguredTitle}>
          {text.notConfiguredBody}
        </Notice>
      );
    case 'not-linked':
      return (
        <Notice tone="warning" title={text.notLinkedTitle}>
          {text.notLinkedBody}
        </Notice>
      );
    case 'linked':
      return (
        <Notice tone="accent" title={text.linkedTitle(data.account?.email ?? null)}>
          {data.enabled
            ? data.connectedAt
              ? locale.settings.drive.connectedSince(formatDateTime(data.connectedAt))
              : null
            : text.linkedPaused}
        </Notice>
      );
  }
}

/** A consent page is open (or could not be): what to do, and the link to use by hand. */
function WaitingPanel({
  waiting,
  copied,
  onReopen,
  onCopy,
  onCancel,
}: {
  waiting: Waiting;
  copied: 'idle' | 'copied' | 'failed';
  onReopen: () => void;
  onCopy: () => void;
  onCancel: () => void;
}) {
  const text = locale.settings.drive;
  const refused = waiting.refusal !== null;
  return (
    <div className="space-y-3 rounded-md border border-border p-4" aria-live="polite">
      {refused ? (
        <div role="alert">
          <Notice tone="danger">{waiting.refusal === 'blocked' ? text.browserBlocked : text.browserFailed}</Notice>
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <Skeleton className="mt-1 size-4 shrink-0 rounded-full" />
          <div>
            <p className="font-semibold text-ink">{text.waitingTitle}</p>
            <p className="text-sm leading-relaxed text-steel">{text.waitingBody}</p>
          </div>
        </div>
      )}
      <p className="text-sm text-steel">{text.manualLinkLabel}</p>
      <p className="max-h-20 overflow-y-auto break-all rounded-md bg-canvas p-2 font-mono text-xs text-ink select-all" dir="ltr">
        {waiting.authUrl}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" onClick={onReopen}>
          <ExternalLink size={18} aria-hidden />
          {text.reopen}
        </Button>
        <Button variant="ghost" onClick={onCopy}>
          <Copy size={18} aria-hidden />
          {text.copyLink}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {text.stopWaiting}
        </Button>
        {copied !== 'idle' ? (
          <span className="text-sm text-steel" role="status">
            {copied === 'copied' ? text.linkCopied : text.linkCopyFailed}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** «اختبار الاتصال», step by step — a step not reached says so instead of passing. */
function TestResult({ result, statusShowsError }: { result: DriveTestResult; statusShowsError: boolean }) {
  const text = locale.settings.drive;
  const failed = result.steps.find((step) => step.ok === false);
  return (
    <div className="space-y-3 rounded-md border border-border p-4">
      <p className="font-semibold text-ink">{result.ok ? text.testPassed : text.testFailed}</p>
      <ol className="space-y-1">
        {result.steps.map((step) => (
          <li key={step.step} className="flex items-center gap-2 text-sm text-ink">
            {step.ok === true ? (
              <CheckCircle2 size={18} className="shrink-0 text-success" aria-hidden />
            ) : step.ok === false ? (
              <AlertOctagon size={18} className="shrink-0 text-danger" aria-hidden />
            ) : (
              <MinusCircle size={18} className="shrink-0 text-steel" aria-hidden />
            )}
            <span>{text.steps[step.step] ?? step.step}</span>
            {step.ok === null ? <span className="text-steel">— {text.stepNotReached}</span> : null}
          </li>
        ))}
      </ol>
      {/* The reason is the status panel's when it is showing one; said here only if not. */}
      {failed?.failure && !statusShowsError ? (
        <p className="text-sm text-ink">
          {failed.failure.message} {failed.failure.remedy}
        </p>
      ) : null}
      {result.ok && result.account?.email ? (
        <p className="text-sm text-steel" dir="auto">
          {text.testAccount(result.account.email)}
        </p>
      ) : null}
    </div>
  );
}

