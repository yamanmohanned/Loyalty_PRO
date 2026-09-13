import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  AlertOctagon,
  CheckCircle2,
  Cloud,
  CloudOff,
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
  type DriveStatus,
  type DriveTestResult,
} from '@walaa/shared-types';
import { api } from '../../lib/api';
import { useFormErrors } from '../../lib/form';
import { formatDateTime, locale } from '../../lib/locale';
import {
  Button,
  Card,
  CardHeader,
  Chip,
  Field,
  InlineFailure,
  Input,
  Notice,
} from '../../components/ui';

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
 * Top to bottom, in the order a person setting it up actually goes:
 *
 *   1. **The OAuth client** — two values from the owner's Google Cloud project, typed
 *      here once. The secret is stored encrypted by the service and never shown again;
 *      it is never in `walaa.env`, never in a log, never in a response.
 *   2. **The account** — «ربط حساب Google» opens Google's consent page in the browser;
 *      once granted, the panel shows WHICH account holds the backups.
 *   3. **Is it working** — the last successful upload, the next scheduled one, how many
 *      copies Drive holds, «ارفع نسخة الآن», and «اختبار الاتصال», which proves the
 *      whole chain: authorise, upload, read back, delete.
 *
 * Every failure the API classifies is rendered verbatim — its sentence and its remedy.
 *
 * ── Why the browser opens rather than a window inside the app ────────────────
 *
 * Google's consent screen refuses to load in an embedded webview, and it is right to:
 * a merchant typing a Google password should be looking at his own browser's address
 * bar. The API starts a loopback listener, hands back the URL, and this polls until
 * the grant comes home.
 */
export function DriveSection() {
  const text = locale.settings.drive;
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [uploadProblem, setUploadProblem] = useState<string | null>(null);
  const [test, setTest] = useState<DriveTestResult | null>(null);
  const [editingClient, setEditingClient] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  /* Two forms on one card: a refusal about the client belongs under the client fields,
     one about retention under the retention box. */
  const errors = useFormErrors();
  const clientErrors = useFormErrors();
  const pollTimer = useRef<number | null>(null);

  const status = useQuery({
    queryKey: ['drive'],
    queryFn: () => api.get<DriveStatus>('/backup/drive'),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['drive'] });

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
      errors.clear();
      setNotice(text.consentOpened);

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
              setNotice(text.connected);
              refresh();
            } else if (progress.state === 'FAILED') {
              stopPolling();
              setNotice(null);
              errors.rejectForm(
                progress.failure
                  ? `${progress.failure.message} ${progress.failure.remedy}`
                  : locale.failure.unexpected,
              );
            }
          })
          .catch(() => {
            /* A poll that fails is not itself a failure; the next one may answer. */
          });
      }, 1500);
    },
    onError: (caught: Error) => {
      setNotice(null);
      errors.fail(caught);
    },
  });

  const disconnect = useMutation({
    mutationFn: () => api.post('/backup/drive/disconnect', {}),
    onSuccess: () => {
      errors.clear();
      setTest(null);
      setNotice(text.disconnected);
      refresh();
    },
    onError: (caught: Error) => errors.fail(caught),
  });

  const save = useMutation({
    mutationFn: (update: { enabled?: boolean; keep?: number }) =>
      api.patch('/backup/drive/settings', update),
    onSuccess: () => {
      errors.clear();
      setNotice(locale.common.saved);
      refresh();
    },
    onError: (caught: Error) => errors.fail(caught),
  });

  const saveClient = useMutation({
    mutationFn: (update: DriveClientUpdate) => api.put<DriveStatus>('/backup/drive/client', update),
    onSuccess: () => {
      clientErrors.clear();
      setEditingClient(false);
      setClientId('');
      // The secret is dropped from memory the moment the service has it.
      setClientSecret('');
      setNotice(text.clientSaved);
      refresh();
    },
    onError: (caught: Error) => clientErrors.fail(caught),
  });

  const clearClient = useMutation({
    mutationFn: () => api.delete<DriveStatus>('/backup/drive/client'),
    onSuccess: () => {
      clientErrors.clear();
      setNotice(text.clientCleared);
      refresh();
    },
    onError: (caught: Error) => clientErrors.fail(caught),
  });

  const runTest = useMutation({
    mutationFn: () => api.post<DriveTestResult>('/backup/drive/test'),
    onSuccess: (result) => {
      errors.clear();
      setTest(result);
      refresh();
    },
    onError: (caught: Error) => errors.fail(caught),
  });

  const uploadNow = useMutation({
    mutationFn: () => api.post<{ destinations: Array<{ kind: string; ok: boolean }> }>('/backup/run'),
    onSuccess: (run) => {
      errors.clear();
      const drive = run.destinations.find((destination) => destination.kind === 'drive');
      if (drive?.ok) {
        setUploadProblem(null);
        setNotice(text.uploadedNow);
      } else {
        setNotice(null);
        // The classified reason arrives with the refreshed status, above.
        setUploadProblem(drive ? text.uploadFailed : text.uploadNotRegistered);
      }
      refresh();
    },
    onError: (caught: Error) => {
      setNotice(null);
      errors.fail(caught);
    },
  });

  const submitClient = () => {
    const parsed = clientErrors.validate(DriveClientUpdateSchema, { clientId, clientSecret });
    if (parsed) saveClient.mutate(parsed);
  };

  const data = status.data;

  return (
    <Card>
      <CardHeader
        title={text.title}
        action={
          data ? (
            <Chip tone={data.connected ? 'success' : data.configured ? 'warning' : 'neutral'}>
              {data.connected
                ? text.stateConnected
                : data.configured
                  ? text.stateNotConnected
                  : text.stateNotConfigured}
            </Chip>
          ) : undefined
        }
      />
      <div className="space-y-6 p-6">
        {status.isError ? (
          <InlineFailure
            what={locale.failure.what.drive}
            error={status.error}
            onRetry={() => void status.refetch()}
          />
        ) : status.isLoading || !data ? (
          <p className="text-steel">{locale.common.loading}</p>
        ) : (
          <>
            {/* 1 ── The OAuth client ─────────────────────────────────────── */}
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
                      onClick={() => {
                        setEditingClient(true);
                        setClientId(data.client?.clientId ?? '');
                        setClientSecret('');
                      }}
                    >
                      {text.clientChange}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={data.connected || clearClient.isPending}
                      onClick={() => clearClient.mutate()}
                    >
                      {text.clientClear}
                    </Button>
                  </div>
                  {data.connected ? <p className="text-sm text-steel">{text.clientClearBlocked}</p> : null}
                </>
              ) : (
                <form
                  className="space-y-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    submitClient();
                  }}
                >
                  <Field label={text.clientIdLabel} hint={text.clientIdHint} error={clientErrors.fields.clientId}>
                    <Input
                      name="clientId"
                      value={clientId}
                      onChange={(event) => {
                        setClientId(event.target.value);
                        clientErrors.clearField('clientId');
                      }}
                      dir="ltr"
                      className="font-mono text-start"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </Field>
                  <Field
                    label={text.clientSecretLabel}
                    hint={text.clientSecretHint}
                    error={clientErrors.fields.clientSecret}
                  >
                    <Input
                      name="clientSecret"
                      type="password"
                      value={clientSecret}
                      onChange={(event) => {
                        setClientSecret(event.target.value);
                        clientErrors.clearField('clientSecret');
                      }}
                      dir="ltr"
                      className="font-mono text-start"
                      autoComplete="new-password"
                      spellCheck={false}
                    />
                  </Field>
                  <div className="flex flex-wrap gap-3">
                    <Button type="submit" disabled={saveClient.isPending}>
                      {text.clientSave}
                    </Button>
                    {data.client ? (
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => {
                          setEditingClient(false);
                          setClientSecret('');
                          clientErrors.clear();
                        }}
                      >
                        {locale.common.cancel}
                      </Button>
                    ) : null}
                  </div>
                  <p className="text-sm text-steel">{text.clientStoredNote}</p>
                </form>
              )}
              {clientErrors.summary ? <Notice tone="danger">{clientErrors.summary}</Notice> : null}
            </section>

            {/* The API's own classification, verbatim: what happened, then what to do. */}
            {data.failure ? (
              <Notice
                tone={data.failure.code === 'NOT_CONFIGURED' ? 'warning' : 'danger'}
                title={data.failure.message}
              >
                {data.failure.remedy}
              </Notice>
            ) : null}

            {/* 2 ── The Google account ───────────────────────────────────── */}
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
                    <Button
                      variant="secondary"
                      onClick={() => disconnect.mutate()}
                      disabled={disconnect.isPending}
                    >
                      <Link2Off size={18} aria-hidden />
                      {text.disconnect}
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="flex size-10 items-center justify-center rounded-md bg-canvas text-steel">
                      <CloudOff size={20} aria-hidden />
                    </span>
                    <Button onClick={() => connect.mutate()} disabled={connect.isPending}>
                      <ExternalLink size={18} aria-hidden />
                      {connect.isPending ? text.connecting : text.connect}
                    </Button>
                  </div>
                )}
                <p className="text-sm leading-relaxed text-steel">{text.scopeNote}</p>
              </section>
            ) : null}

            {/* 3 ── Is it working ────────────────────────────────────────── */}
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
                <Field label={text.keepLabel} hint={text.keepHint} error={errors.fields.keep}>
                  <Input
                    type="number"
                    min={1}
                    max={365}
                    defaultValue={data.keep}
                    dir="ltr"
                    className="text-start"
                    onBlur={(event) => {
                      const keep = Number(event.target.value);
                      if (Number.isInteger(keep) && keep >= 1 && keep !== data.keep) {
                        save.mutate({ keep });
                      }
                    }}
                  />
                </Field>

                <div className="flex flex-wrap items-center gap-3">
                  <Button onClick={() => uploadNow.mutate()} disabled={uploadNow.isPending || !data.enabled}>
                    {uploadNow.isPending ? text.uploading : text.uploadNow}
                  </Button>
                  <Button variant="secondary" onClick={() => runTest.mutate()} disabled={runTest.isPending}>
                    {runTest.isPending ? text.testing : text.test}
                  </Button>
                  <Button variant="ghost" onClick={() => void status.refetch()} disabled={status.isFetching}>
                    <RefreshCw size={18} aria-hidden />
                    {locale.common.retry}
                  </Button>
                </div>

                {uploadProblem ? <Notice tone="danger">{uploadProblem}</Notice> : null}
                {test ? <TestResult result={test} /> : null}

                <p className="text-sm text-steel">
                  {text.restoreHint}{' '}
                  <Link to="/backup" className="text-accent underline">
                    {text.restoreLink}
                  </Link>
                </p>
              </section>
            ) : null}

            {errors.summary ? <Notice tone="danger">{errors.summary}</Notice> : null}
            {notice ? <Notice tone="accent">{notice}</Notice> : null}
          </>
        )}
      </div>
    </Card>
  );
}

/** «اختبار الاتصال», step by step — a step not reached says so instead of passing. */
function TestResult({ result }: { result: DriveTestResult }) {
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
      {failed?.failure ? (
        <Notice tone="danger" title={failed.failure.message}>
          {failed.failure.remedy}
        </Notice>
      ) : null}
      {result.ok && result.account?.email ? (
        <p className="text-sm text-steel" dir="auto">
          {text.testAccount(result.account.email)}
        </p>
      ) : null}
    </div>
  );
}
