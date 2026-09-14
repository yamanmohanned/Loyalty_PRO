import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, PhoneCall } from 'lucide-react';
import type {
  ActivateLicenseResponse,
  EnterUnlockResponse,
  LicenseEvent,
  LicenseEventsResponse,
  LicenseOverview,
  LicenseState,
} from '@walaa/shared-types';
import { api, ApiRequestError } from '../../lib/api';
import { formatDate, formatDateTime, locale } from '../../lib/locale';
import { LICENSE_QUERY_KEY, licenseNotice, useLicense } from '../../components/LicenseBanner';
import {
  Button,
  Card,
  CardHeader,
  Chip,
  cn,
  ErrorState,
  Field,
  Notice,
  Skeleton,
  tableHeadRow,
  tableRow,
  td,
  th,
} from '../../components/ui';

/**
 * «الإعدادات ← الترخيص» (packaging/LICENSING.md).
 *
 * The screen a merchant uses with the provider on the phone. Two ways in:
 *
 *  - **a licence code** (long, by message) pasted into the big field — permanent;
 *  - **an emergency code** (fifteen symbols, read aloud) — full operation at once for
 *    a few days, for when no message can reach this PC.
 *
 * Both take effect with the request that enters them: the service re-evaluates on
 * every request, and this refetches on success. Nothing is decided here — every code
 * goes to the service, which checks it in Rust, and every attempt is recorded.
 *
 * The event log at the bottom is the provider's: it is where the provider reads, at the
 * shop, whether a stopped clock was a battery or a hand.
 */

const t = locale.settings.license;
const DAY_MS = 86_400_000;

const TONE: Record<LicenseState['status'], 'success' | 'accent' | 'warning' | 'danger'> = {
  PERPETUAL: 'success',
  TRIAL: 'accent',
  EMERGENCY: 'warning',
  GRACE: 'danger',
  UNLICENSED: 'warning',
  EXPIRED: 'danger',
  TAMPERED: 'danger',
};

const OVERVIEW_KEY = [...LICENSE_QUERY_KEY, 'overview'] as const;
const EVENTS_KEY = [...LICENSE_QUERY_KEY, 'events'] as const;

const refusal = (error: unknown): string | null =>
  error instanceof ApiRequestError && error.status > 0 ? error.message : error ? locale.failure.unexpected : null;

function DeviceNumber({ deviceId }: { deviceId: string }) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(deviceId);
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  };

  return (
    <div>
      <p className="mb-2 text-sm font-medium text-ink">{t.deviceLabel}</p>
      <div className="flex flex-wrap items-center gap-4">
        {/* Latin in an RTL line: isolated, so the dashes do not reorder the groups. */}
        <bdi
          dir="ltr"
          className="selectable select-all rounded-md border border-border-strong bg-canvas px-5 py-3 font-mono text-3xl font-bold tracking-wider text-ink"
        >
          {deviceId}
        </bdi>
        <Button variant="secondary" onClick={() => void onCopy()}>
          {copy === 'copied' ? <Check size={18} aria-hidden /> : <Copy size={18} aria-hidden />}
          {copy === 'copied' ? t.copied : t.copy}
        </Button>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-steel" role="status">
        {copy === 'failed' ? t.copyFailed : t.deviceHint}
      </p>
    </div>
  );
}

function StatusDetails({ state }: { state: LicenseState }) {
  const rows: Array<[string, React.ReactNode]> = [
    [
      t.statusLabel,
      <span className="flex flex-wrap items-center gap-2">
        <Chip tone={TONE[state.status]} dot>
          {t.status[state.status]}
        </Chip>
        {state.degraded ? <Chip tone="warning">{t.degraded}</Chip> : null}
      </span>,
    ],
    [t.kindLabel, state.basis ? t.kind[state.basis] : state.kind ? t.kind[state.kind] : t.none],
    [
      t.expiresLabel,
      state.basis === 'perpetual' || (state.kind === 'perpetual' && !state.basis)
        ? t.perpetual
        : state.expiresAt
          ? formatDate(state.expiresAt)
          : t.none,
    ],
  ];
  if (state.status === 'GRACE' && state.graceEndsAt) rows.push([t.graceEndsLabel, formatDate(state.graceEndsAt)]);
  if (state.features.length > 0) {
    rows.push([t.featuresLabel, state.features.map((f) => t.feature[f] ?? f).join('، ')]);
  }
  if (state.note) rows.push([t.noteLabel, state.note]);

  return (
    <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-[max-content_1fr]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-sm text-steel">{label}</dt>
          <dd className="text-base text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function successSentence(response: ActivateLicenseResponse): string {
  if (response.alreadyActive) return t.alreadyActive;
  const { activation } = response;
  if (activation.kind === 'perpetual' || !activation.expiresAt) return t.activatedPerpetual;
  const days = Math.round((Date.parse(activation.expiresAt) - Date.parse(activation.issuedAt)) / DAY_MS);
  return t.activatedTrial(locale.license.days(days), formatDate(activation.expiresAt));
}

/** After either kind of code: the new verdict at once, and everything that reads it. */
function useApplied() {
  const queryClient = useQueryClient();
  return (state: LicenseState) => {
    queryClient.setQueryData(LICENSE_QUERY_KEY, state);
    void queryClient.invalidateQueries({ queryKey: LICENSE_QUERY_KEY });
    // Drive's panel says whether uploads are licensed; it must not keep the old answer.
    void queryClient.invalidateQueries({ queryKey: ['backup'] });
  };
}

const codeFieldClass = (invalid: boolean) =>
  cn(
    'selectable w-full rounded-md border bg-surface px-[18px] py-3 font-mono text-ink',
    'transition-[border-color,box-shadow] duration-fast ease-native focus:outline-none',
    invalid
      ? 'border-danger focus-visible:ring-4 focus-visible:ring-danger/20'
      : 'border-border-strong focus:border-accent focus-visible:ring-4 focus-visible:ring-accent/20',
  );

function ActivationForm() {
  const applied = useApplied();
  const [code, setCode] = useState('');
  const [done, setDone] = useState<string | null>(null);

  const activate = useMutation({
    mutationFn: (value: string) => api.post<ActivateLicenseResponse>('/license/activate', { code: value }),
    onSuccess: (response) => {
      applied(response.state);
      setDone(successSentence(response));
      setCode('');
    },
    onMutate: () => setDone(null),
  });
  const error = refusal(activate.error);

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (code.trim()) activate.mutate(code);
      }}
    >
      <Field label={t.codeLabel} hint={t.codeHint} error={error ?? undefined}>
        <textarea
          value={code}
          onChange={(event) => setCode(event.target.value)}
          dir="ltr"
          rows={6}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          className={cn(codeFieldClass(Boolean(error)), 'min-h-[160px] text-sm leading-relaxed')}
        />
      </Field>
      <Button type="submit" disabled={activate.isPending || !code.trim()}>
        <KeyRound size={18} aria-hidden />
        {activate.isPending ? t.activating : t.activate}
      </Button>
      {done ? <Notice tone="accent" title={done}>{null}</Notice> : null}
    </form>
  );
}

function EmergencyForm() {
  const applied = useApplied();
  const [code, setCode] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const e = t.emergency;

  const enter = useMutation({
    mutationFn: (value: string) => api.post<EnterUnlockResponse>('/license/unlock', { code: value }),
    onSuccess: (response) => {
      applied(response.state);
      setDone(response.alreadyEntered ? e.already : e.done(formatDateTime(response.validUntil)));
      setCode('');
    },
    onMutate: () => setDone(null),
  });
  const error = refusal(enter.error);

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (code.trim()) enter.mutate(code);
      }}
    >
      <Field label={e.label} hint={e.hint} error={error ?? undefined}>
        <input
          value={code}
          onChange={(event) => setCode(event.target.value.toUpperCase())}
          dir="ltr"
          maxLength={32}
          spellCheck={false}
          autoComplete="off"
          placeholder={e.placeholder}
          aria-invalid={error ? true : undefined}
          className={cn(codeFieldClass(Boolean(error)), 'min-h-field text-2xl tracking-[0.15em]')}
        />
      </Field>
      <Button type="submit" disabled={enter.isPending || !code.trim()}>
        <PhoneCall size={18} aria-hidden />
        {enter.isPending ? e.submitting : e.submit}
      </Button>
      {done ? <Notice tone="accent" title={done}>{null}</Notice> : null}
    </form>
  );
}

function History() {
  const overview = useQuery({
    queryKey: OVERVIEW_KEY,
    queryFn: () => api.get<LicenseOverview>('/license/activations'),
  });

  if (overview.isPending) return <Skeleton className="m-6 h-24" />;
  if (overview.isError) {
    return (
      <div className="p-6">
        <ErrorState what={t.historyTitle} error={overview.error} onRetry={() => void overview.refetch()} />
      </div>
    );
  }
  if (overview.data.activations.length === 0) {
    return <p className="p-6 text-steel">{t.historyEmpty}</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className={tableHeadRow}>
            <th className={th}>{t.historyActivatedAt}</th>
            <th className={th}>{t.historyKind}</th>
            <th className={th}>{t.historyExpires}</th>
            <th className={th}>{t.historyBy}</th>
          </tr>
        </thead>
        <tbody>
          {overview.data.activations.map((entry) => (
            <tr key={entry.licenseId} className={tableRow}>
              <td className={td}>{formatDateTime(entry.activatedAt)}</td>
              <td className={td}>{t.kind[entry.kind]}</td>
              <td className={td}>{entry.expiresAt ? formatDate(entry.expiresAt) : t.perpetual}</td>
              <td className={td}>{entry.activatedByName ?? t.none}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One line of evidence per event, in the words the provider needs at the shop. */
function eventDetail(event: LicenseEvent): string[] {
  const d = event.details;
  const lines: string[] = [];
  const text = (key: string) => (typeof d[key] === 'string' ? (d[key] as string) : null);
  const number = (key: string) => (typeof d[key] === 'number' ? (d[key] as number) : null);

  switch (event.type) {
    case 'CLOCK_ROLLBACK': {
      const cause = text('cause');
      if (cause) lines.push(t.events.cause[cause] ?? cause);
      const behind = number('behindMinutes');
      if (behind !== null) lines.push(t.events.behind(locale.license.minutes(behind)));
      const system = text('systemTime');
      if (system) lines.push(`${t.events.systemTime} ${formatDateTime(system)}`);
      lines.push(d.stoppedSales ? t.events.stoppedSales : t.events.notStopped);
      break;
    }
    case 'CLOCK_RESTORED': {
      const duration = number('durationMinutes');
      if (duration !== null) lines.push(t.events.restoredAfter(locale.license.minutes(duration)));
      lines.push(t.events.refusedDuring(number('refusedDuring') ?? 0));
      break;
    }
    case 'LOST':
      lines.push(t.events.lost);
      break;
    case 'UNLOCK_ENTERED': {
      const until = text('validUntil');
      if (until) lines.push(t.events.until(formatDateTime(until)));
      break;
    }
    case 'ACTIVATION_FAILED':
    case 'UNLOCK_FAILED': {
      const reason = text('reason');
      if (reason) lines.push(t.events.reason(reason));
      break;
    }
    default:
      break;
  }
  if (d.restoredFromFile) lines.push(t.events.fromFile);
  return lines;
}

function EventLog() {
  const events = useQuery({
    queryKey: EVENTS_KEY,
    queryFn: () => api.get<LicenseEventsResponse>('/license/events'),
  });

  if (events.isPending) return <Skeleton className="m-6 h-24" />;
  if (events.isError) {
    return (
      <div className="p-6">
        <ErrorState what={t.events.title} error={events.error} onRetry={() => void events.refetch()} />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-6">
      <p className="text-base font-medium text-ink">{t.events.rollbacks(events.data.clockRollbacks)}</p>
      {events.data.events.length === 0 ? (
        <p className="text-steel">{t.events.empty}</p>
      ) : (
        <ol className="divide-y divide-border rounded-md border border-border">
          {events.data.events.map((event) => {
            const clock = event.type === 'CLOCK_ROLLBACK';
            return (
              <li key={event.id} className="flex flex-wrap items-start justify-between gap-x-6 gap-y-1 px-4 py-3">
                <div className="min-w-0 space-y-1">
                  <p className={cn('text-sm font-semibold', clock ? 'text-danger' : 'text-ink')}>
                    {t.events.type[event.type] ?? event.type}
                  </p>
                  {eventDetail(event).map((line) => (
                    <p key={line} className="text-sm leading-relaxed text-steel">
                      {line}
                    </p>
                  ))}
                </div>
                <p className="shrink-0 text-sm text-steel">
                  {formatDateTime(event.at)}
                  {event.actorName ? ` — ${event.actorName}` : ''}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

export function LicenseSection() {
  const license = useLicense();

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title={t.title} subtitle={t.subtitle} />
        <div className="space-y-6 p-6">
          {license.isPending ? (
            <Skeleton className="h-40" />
          ) : license.isError ? (
            <ErrorState what={t.title} error={license.error} onRetry={() => void license.refetch()} />
          ) : (
            <>
              {(() => {
                const notice = licenseNotice(license.data);
                return notice ? (
                  <Notice tone={notice.tone === 'danger' ? 'danger' : 'warning'} title={notice.title}>
                    {notice.body}
                  </Notice>
                ) : null;
              })()}
              <StatusDetails state={license.data} />
              <DeviceNumber deviceId={license.data.deviceId} />
            </>
          )}
          <ActivationForm />
        </div>
      </Card>

      <Card>
        <CardHeader title={t.emergency.title} subtitle={t.emergency.subtitle} />
        <div className="p-6">
          <EmergencyForm />
        </div>
      </Card>

      <Card>
        <CardHeader title={t.historyTitle} />
        <History />
      </Card>

      <Card>
        <CardHeader title={t.events.title} subtitle={t.events.subtitle} />
        <EventLog />
      </Card>
    </div>
  );
}
