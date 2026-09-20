import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertOctagon, CheckCircle2, CloudOff, DatabaseBackup, HardDrive, MinusCircle, RotateCcw, Usb } from 'lucide-react';
import { api, ApiRequestError } from '../lib/api';
import { getApiUrl } from '../lib/config';
import { failureSentence } from '../lib/failure';
import { locale, formatDateTime } from '../lib/locale';
import {
  Button,
  Card,
  CardHeader,
  Chip,
  ErrorState,
  Field,
  Input,
  Notice,
  PageHeader,
  Skeleton,
} from '../components/ui';
import { DemoHardwareNotice, DemoResetCard } from '../components/DemoSurfaces';
import { IS_DEMO } from '../lib/demo';
import type {
  BackupOverview,
  HistoryEntry,
  RestoreOutcome,
  StagedRestore,
  VerificationResult,
} from '@loyalty-pro/shared-types';
import { KeyConfirmedSummary } from './KeyCeremony';

/**
 * Backup (docs/legacy/CLAUDE_v3.md §7.3, §12.17–§12.21).
 *
 * §5.1 put every byte this shop owns on one machine, and §7.3 answered that backup is
 * therefore mandatory rather than optional. This screen leads with the risk, and it is
 * built around one question a manager should be able to answer in three seconds:
 * **is this actually working?**
 *
 * Which is why it shows dates and gaps rather than only errors. The failure this product
 * keeps meeting is the quiet one — the agent that captured nothing for days while
 * reporting healthy (§12.15), archives nobody can open (§12.19). A backup that stopped
 * being attempted three months ago produces no error at all; the only thing that reveals
 * it is a date, sitting where a recent one should be.
 */

const dateTime = (iso: string | null): string =>
  iso ? formatDateTime(iso) : '—';

const megabytes = (bytes: number | null): string =>
  bytes === null ? '—' : `${(bytes / 1024 / 1024).toFixed(2)} MB`;

const DESTINATION_ICON: Record<string, typeof HardDrive> = {
  local: HardDrive,
  usb: Usb,
  drive: CloudOff,
};

export function BackupScreen() {
  const queryClient = useQueryClient();

  const overview = useQuery({
    queryKey: ['backup', 'overview'],
    queryFn: () => api.get<BackupOverview>('/backup'),
    // A backup takes seconds and the numbers on this screen are the reason someone is
    // here, so it refreshes rather than sitting on a cached "never".
    staleTime: 0,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['backup'] });
  };

  /*
    Each action resets the other on start, so the screen never carries the refusal of an
    earlier press beside the result of a later one.
  */
  const run = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; destinations: Array<{ kind: string; ok: boolean }> }>('/backup/run'),
    onMutate: (): void => {
      verify.reset();
    },
    onSettled: invalidate,
  });

  const verify = useMutation({
    mutationFn: () => api.post<VerificationResult>('/backup/verify'),
    onMutate: (): void => {
      run.reset();
    },
    onSettled: invalidate,
  });

  const data = overview.data;
  const schedule = data?.schedule;

  return (
    <>
      <PageHeader
        icon={<DatabaseBackup size={24} aria-hidden />}
        title={locale.backup.title}
        subtitle={locale.backup.subtitle}
      />

      <div className="mb-6">
        <Notice tone="danger" title={locale.backup.riskTitle}>
          {locale.backup.riskNotice}
        </Notice>
      </div>

      {/* The failure branch was missing entirely: `{data ? … : null}` below meant a
          dead backend rendered the header, the standing risk notice, and then nothing
          — a screen that looks finished and is empty. */}
      {overview.isError ? (
        <Card>
          <ErrorState
            what={locale.failure.what.backup}
            error={overview.error}
            onRetry={() => void overview.refetch()}
          />
        </Card>
      ) : overview.isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-24" />
          <Skeleton className="h-40" />
        </div>
      ) : null}

      {data ? (
        <div className="space-y-6">
          {/* The encryption key. Shown first because nothing below it means anything
              until this is settled (§12.19). */}
          {data.key.backupsEnabled ? (
            <KeyConfirmedSummary status={data.key} />
          ) : (
            <Notice tone="danger" title={locale.keyCeremony.bannerTitle}>
              {data.key.configured
                ? locale.keyCeremony.bannerUnconfirmed
                : locale.keyCeremony.bannerUnconfigured}
            </Notice>
          )}

          {/* Schedule and the two actions. */}
          <Card>
            <CardHeader
              title={locale.backup.scheduleTitle}
              subtitle={
                schedule?.enabled
                  ? `${locale.backup.scheduleDaily(schedule.dailyAt)} · ${locale.backup.scheduleCounter(schedule.everyTransactions)}`
                  : locale.backup.scheduleOff
              }
              action={
                <Chip tone={schedule?.enabled ? 'success' : 'danger'}>
                  {schedule?.enabled ? locale.common.enabled : locale.backup.scheduleOff}
                </Chip>
              }
            />
            <div className="grid grid-cols-2 gap-6 p-6">
              <div>
                <p className="mb-1 text-sm text-steel">{locale.backup.lastBackup}</p>
                <p className="font-mono text-base text-ink">
                  {schedule?.lastSuccessAt ? dateTime(schedule.lastSuccessAt) : locale.backup.never}
                </p>
                {schedule ? (
                  <p className="mt-1 text-sm text-steel">
                    {locale.backup.sinceLastBackup(schedule.transactionsSinceLastBackup)}
                  </p>
                ) : null}
              </div>
              <div>
                <p className="mb-1 text-sm text-steel">{locale.backup.nextRun}</p>
                <p className="font-mono text-base text-ink">{dateTime(schedule?.nextRunAt ?? null)}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3 border-t border-border p-6">
              <Button
                onClick={() => run.mutate()}
                disabled={run.isPending || verify.isPending || !data.key.backupsEnabled}
              >
                {run.isPending ? locale.backup.running : locale.backup.runNow}
              </Button>
              {!data.key.backupsEnabled ? (
                <p className="text-sm text-danger">{locale.backup.blockedByKey}</p>
              ) : null}
            </div>
            {run.error ? (
              <div className="px-6 pb-6" role="alert">
                <Notice tone="danger">{failureSentence(run.error)}</Notice>
              </div>
            ) : run.data ? (
              <div className="px-6 pb-6" role="status">
                <RunOutcome run={run.data} />
              </div>
            ) : null}
          </Card>

          {/*
            The restore test — §7.3's most commonly skipped step.

            Its button now lives HERE, beside the result it produces. It used to sit in
            the schedule card above, while this card showed only «لم يُجرَ اختبار استعادة
            بعد» — a statement with nothing on it to act on. And the result shown is the
            last one on record, passed or failed, not only what this session happened to
            run: a failed test used to vanish on reload and read as «never tested».
          */}
          <Card>
            <CardHeader
              title={locale.backup.restoreTitle}
              subtitle={locale.backup.restoreHint}
              action={<VerificationChip entry={data.history.lastVerification} />}
            />
            <div className="space-y-4 p-6">
              <LastVerification entry={data.history.lastVerification} />
              <p className="text-sm leading-relaxed text-steel">{locale.backup.verifyExplain}</p>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  onClick={() => verify.mutate()}
                  disabled={run.isPending || verify.isPending || !data.key.backupsEnabled}
                >
                  <RotateCcw size={18} aria-hidden />
                  {verify.isPending ? locale.backup.verifying : locale.backup.verifyNow}
                </Button>
                {!data.key.backupsEnabled ? (
                  <p className="text-sm text-danger">{locale.backup.blockedByKey}</p>
                ) : null}
              </div>
              {verify.error ? (
                <Notice tone="danger">{failureSentence(verify.error)}</Notice>
              ) : null}
            </div>
          </Card>

          <RestoreCard data={data} onChanged={invalidate} />

          {/* 3-2-1: one row per destination, so a manager sees how many copies exist
              rather than a single green tick that hides two failures. */}
          <div className="grid grid-cols-3 gap-6">
            {data.destinations.map((destination) => {
              const Icon = DESTINATION_ICON[destination.kind] ?? HardDrive;
              const newest = destination.backups[0];
              return (
                <Card key={destination.kind}>
                  <CardHeader
                    title={destination.label}
                    action={
                      <Chip tone={destination.available ? 'success' : 'danger'}>
                        {destination.available ? locale.common.enabled : locale.backup.unavailable}
                      </Chip>
                    }
                  />
                  <div className="space-y-2 p-6">
                    <div className="flex items-center gap-3 text-steel">
                      <Icon size={20} aria-hidden />
                      <span className="text-sm">
                        {newest ? dateTime(newest.createdAt) : locale.backup.never}
                      </span>
                    </div>
                    <p className="text-sm text-steel">
                      {destination.backups.length} · {megabytes(newest?.bytes ?? null)}
                    </p>
                  </div>
                </Card>
              );
            })}
            {data.destinations.every((d) => d.kind !== 'drive') ? (
              <Card>
                <CardHeader
                  title={locale.backup.driveTitle}
                  subtitle={locale.backup.driveHint}
                  action={<Chip tone="danger">{locale.backup.driveNotConnected}</Chip>}
                />
                <div className="flex items-center gap-3 p-6 text-steel">
                  <CloudOff size={20} aria-hidden />
                  <span className="text-sm">{locale.backup.never}</span>
                </div>
              </Card>
            ) : null}
          </div>

          {/* Every attempt, including the ones that did nothing. */}
          <Card>
            <CardHeader title={locale.backup.historyTitle} subtitle={locale.backup.historyHint} />
            {data.history.runs.length === 0 ? (
              <p className="p-6 text-sm text-steel">{locale.backup.historyEmpty}</p>
            ) : (
              <ul className="divide-y divide-border">
                {data.history.runs.map((entry) => (
                  <li key={`${entry.at}-${entry.name}`} className="flex items-center gap-4 px-6 py-3">
                    <OutcomeIcon outcome={entry.outcome} />
                    <div className="flex-1">
                      <p className="text-sm text-ink">
                        {dateTime(entry.at)} ·{' '}
                        {entry.actorName ?? locale.backup.scheduledRun}
                      </p>
                      {entry.error ? (
                        <p className="text-sm text-danger">
                          {entry.outOfSpace ? `${locale.backup.outOfSpace} — ` : ''}
                          {entry.error}
                        </p>
                      ) : (
                        <p className="text-sm text-steel">
                          {entry.destinations
                            .map(
                              (d) =>
                                `${locale.backup.destinationShort[d.kind] ?? d.kind}${d.ok ? '' : ' ✕'}`,
                            )
                            .join(' · ')}
                        </p>
                      )}
                    </div>
                    <span className="font-mono text-sm text-steel">
                      {megabytes(entry.archiveBytes)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      ) : null}

      {/* Demo only — absent from a production bundle. The Backup screen is where a
          merchant already comes to think about his data, so "put it back the way it
          was" belongs beside "keep a copy of it" rather than in a settings drawer. */}
      {IS_DEMO ? (
        <div className="mt-6 space-y-6">
          {/* What the suppressed banner would have said, said calmly and in place. */}
          <DemoHardwareNotice />
          <DemoResetCard />
        </div>
      ) : null}
    </>
  );
}

/** What «أخذ نسخة الآن» achieved, named by destination. */
function RunOutcome({ run }: { run: { ok: boolean; destinations: Array<{ kind: string; ok: boolean }> } }) {
  const name = (kind: string) => locale.backup.destinationShort[kind] ?? kind;
  const landed = run.destinations.filter((d) => d.ok).map((d) => name(d.kind));
  const missed = run.destinations.filter((d) => !d.ok).map((d) => name(d.kind));
  if (!run.ok || landed.length === 0) return <Notice tone="danger">{locale.backup.runNowhere}</Notice>;
  if (missed.length > 0) {
    return <Notice tone="warning">{locale.backup.runPartial(landed.join('، '), missed.join('، '))}</Notice>;
  }
  return <Notice tone="accent">{locale.backup.runDone(landed.join('، '))}</Notice>;
}

/* ── Restoring a copy ──────────────────────────────────────────────────────── */

/** How long to wait for the service to come back before reloading anyway. */
const RESTART_WAIT_MS = 120_000;

/**
 * Waits for the service to go down and come back, then reloads into the login screen.
 *
 * The restored database has its own accounts and sessions, so the page must start
 * again rather than carry on with a session the new file has never heard of.
 */
async function reloadWhenBack(): Promise<void> {
  const base = await getApiUrl();
  const started = Date.now();
  let wentDown = false;

  while (Date.now() - started < RESTART_WAIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      const response = await fetch(`${base}/health`, { cache: 'no-store' });
      // Up again after being seen down — or up after long enough that the restart
      // happened between two polls.
      if (response.ok && (wentDown || Date.now() - started > 10_000)) break;
      if (!response.ok) wentDown = true;
    } catch {
      wentDown = true;
    }
  }
  window.location.reload();
}

/**
 * Restoring a copy over the shop's data — from this machine, a USB drive or Google Drive.
 *
 * Two steps, and nothing is replaced in the first: choosing a copy fetches, decrypts and
 * checks it, and shows what it holds against what the program holds now. Only the
 * owner's confirmation replaces anything, and even then the present state is backed up
 * first and appears in this same list.
 */
function RestoreCard({ data, onChanged }: { data: BackupOverview; onChanged: () => void }) {
  const text = locale.backup.restoreCopy;
  const [needsKey, setNeedsKey] = useState<{
    kind: string;
    id: string;
    fingerprint: string | null;
  } | null>(null);
  const [typedKey, setTypedKey] = useState('');
  const [phase, setPhase] = useState<'idle' | 'restarting' | 'next-start'>('idle');

  const stage = useMutation({
    mutationFn: (input: { kind: string; id: string; key?: string }) =>
      api.post<StagedRestore>('/backup/restore/stage', input),
    onMutate: () => {
      apply.reset();
      cancel.reset();
    },
    onSuccess: () => {
      setNeedsKey(null);
      setTypedKey('');
    },
    onError: (error: Error, input) => {
      // A copy made with another key is a question for the owner, not a dead end: ask
      // for the key written on paper, right here.
      const details =
        error instanceof ApiRequestError
          ? (error.details as { reason?: string; fingerprint?: string | null } | undefined)
          : undefined;
      if (details?.reason === 'KEY_MISMATCH' || details?.reason === 'KEY_INVALID') {
        setNeedsKey({
          kind: input.kind,
          id: input.id,
          fingerprint: details.fingerprint ?? needsKey?.fingerprint ?? null,
        });
      }
    },
    onSettled: onChanged,
  });

  const cancel = useMutation({
    mutationFn: () => api.delete('/backup/restore/stage'),
    onMutate: () => {
      stage.reset();
      apply.reset();
    },
    onSettled: onChanged,
  });

  const apply = useMutation({
    mutationFn: () => api.post<{ restarting: boolean }>('/backup/restore/apply', { confirm: true }),
    onMutate: () => {
      stage.reset();
      cancel.reset();
    },
    onSuccess: ({ restarting }) => {
      if (restarting) {
        setPhase('restarting');
        void reloadWhenBack();
      } else {
        setPhase('next-start');
        onChanged();
      }
    },
  });

  const copies = data.destinations
    .flatMap((destination) =>
      destination.backups.map((backup) => ({ ...backup, kind: destination.kind, label: destination.label })),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 12);

  const staged = data.restore.staged;
  const busy = stage.isPending || apply.isPending || cancel.isPending || phase !== 'idle';

  return (
    <Card>
      <CardHeader title={text.title} subtitle={text.subtitle} />
      <div className="space-y-4 p-6">
        {data.restore.last ? <LastRestore outcome={data.restore.last} /> : null}

        {phase === 'restarting' ? (
          <Notice tone="warning" title={text.restartingTitle}>
            {text.restartingBody}
          </Notice>
        ) : null}
        {phase === 'next-start' ? <Notice tone="warning">{text.nextStart}</Notice> : null}

        {staged ? (
          <StagedPreview
            staged={staged}
            busy={busy}
            onConfirm={() => apply.mutate()}
            onCancel={() => cancel.mutate()}
          />
        ) : null}
        {/* One failure at a time — each action clears the others' on start. «إلغاء» failing
            used to say nothing at all. */}
        {apply.error ?? stage.error ?? cancel.error ? (
          <div role="alert">
            <Notice tone="danger">{failureSentence(apply.error ?? stage.error ?? cancel.error)}</Notice>
          </div>
        ) : null}

        {needsKey && !staged ? (
          <div className="space-y-3 rounded-md border border-border p-4">
            <Field label={text.keyLabel} hint={text.keyHint(needsKey.fingerprint)}>
              <Input
                value={typedKey}
                onChange={(event) => setTypedKey(event.target.value)}
                dir="ltr"
                className="font-mono text-start"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <div className="flex flex-wrap gap-3">
              <Button
                onClick={() => stage.mutate({ kind: needsKey.kind, id: needsKey.id, key: typedKey })}
                disabled={busy || !typedKey.trim()}
              >
                {text.openWithKey}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setNeedsKey(null);
                  setTypedKey('');
                  stage.reset();
                }}
              >
                {locale.common.cancel}
              </Button>
            </div>
          </div>
        ) : null}

        {!staged ? (
          copies.length === 0 ? (
            <p className="text-sm text-steel">{text.noCopies}</p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {copies.map((copy) => (
                <li key={`${copy.kind}-${copy.id}`} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="flex-1">
                    <p className="font-mono text-sm text-ink">{dateTime(copy.createdAt)}</p>
                    <p className="text-sm text-steel">
                      {copy.label} · {megabytes(copy.bytes)}
                    </p>
                  </div>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => stage.mutate({ kind: copy.kind, id: copy.id })}
                  >
                    {stage.isPending && stage.variables?.id === copy.id ? text.preparing : text.restoreThis}
                  </Button>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </div>
    </Card>
  );
}

/** What is about to be put back, and what will stop existing — before anything is. */
function StagedPreview({
  staged,
  busy,
  onConfirm,
  onCancel,
}: {
  staged: StagedRestore;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const text = locale.backup.restoreCopy;
  return (
    <Notice tone="warning" title={text.stagedTitle}>
      <div className="space-y-2">
        <p>{text.stagedSource(staged.source.label, dateTime(staged.copyTakenAt))}</p>
        <p>
          {text.stagedCounts(
            staged.copy.customers,
            staged.copy.transactions,
            staged.current.customers,
            staged.current.transactions,
          )}
        </p>
        <p className="font-semibold">
          {staged.latestActivityAt
            ? text.stagedLoss(dateTime(staged.latestActivityAt))
            : text.stagedLossUnknown}
        </p>
        {staged.upgraded ? <p className="text-sm">{text.stagedUpgraded}</p> : null}
        <ul className="list-disc space-y-1 ps-5 text-sm">
          <li>{text.consequenceSafety}</li>
          <li>{text.consequenceStations}</li>
          <li>{text.consequenceLogin}</li>
        </ul>
        {staged.applyRequested ? (
          <p className="text-sm">{text.nextStart}</p>
        ) : (
          <div className="flex flex-wrap gap-3 pt-2">
            <Button onClick={onConfirm} disabled={busy}>
              {text.confirm}
            </Button>
            <Button variant="ghost" onClick={onCancel} disabled={busy}>
              {text.cancel}
            </Button>
          </div>
        )}
      </div>
    </Notice>
  );
}

/** The last restore on record — done, or not done and why. */
function LastRestore({ outcome }: { outcome: RestoreOutcome }) {
  const text = locale.backup.restoreCopy;
  return (
    <Notice
      tone={outcome.ok ? 'accent' : 'danger'}
      title={outcome.ok ? text.lastOkTitle(dateTime(outcome.at)) : text.lastFailedTitle(dateTime(outcome.at))}
    >
      <div className="space-y-1">
        {outcome.ok ? (
          <p>{text.lastOkBody(outcome.source?.label ?? '—', dateTime(outcome.copyTakenAt))}</p>
        ) : (
          <p>{outcome.failure ?? locale.failure.unexpected}</p>
        )}
        {outcome.ok && outcome.safetyBackupName ? <p className="text-sm">{text.lastOkSafety}</p> : null}
        {outcome.requestedByName ? (
          <p className="text-sm text-steel">{text.lastBy(outcome.requestedByName)}</p>
        ) : null}
      </div>
    </Notice>
  );
}

type LastVerificationEntry = BackupOverview['history']['lastVerification'];

function VerificationChip({ entry }: { entry: LastVerificationEntry }) {
  if (!entry) return <Chip tone="warning">{locale.backup.chipNever}</Chip>;
  return (
    <Chip tone={entry.ok ? 'success' : 'danger'}>
      {entry.ok ? locale.backup.chipPassed : locale.backup.chipFailed}
    </Chip>
  );
}

/** The last restore test on record — when, by whom, from where, and what it found. */
function LastVerification({ entry }: { entry: LastVerificationEntry }) {
  if (!entry) {
    return (
      <Notice tone="warning" title={locale.backup.neverVerified}>
        {locale.backup.neverVerifiedBody}
      </Notice>
    );
  }

  const source = entry.verifiedFrom
    ? (locale.backup.sources[entry.verifiedFrom] ?? entry.verifiedFrom)
    : '—';

  return (
    <Notice
      tone={entry.ok ? 'accent' : 'danger'}
      title={
        entry.ok
          ? locale.backup.lastPassedTitle(dateTime(entry.at))
          : locale.backup.lastFailedTitle(dateTime(entry.at))
      }
    >
      <div className="space-y-1">
        <p>{entry.ok ? locale.backup.lastPassedBody(source) : (entry.failure ?? locale.failure.unexpected)}</p>
        {entry.counts ? (
          <p className="text-sm">
            {locale.backup.lastCounts(entry.counts.customers, entry.counts.transactions)}
          </p>
        ) : null}
        <p className="text-sm text-steel">
          {locale.backup.lastBy(entry.actorName ?? locale.backup.scheduledRun)}
        </p>
      </div>
    </Notice>
  );
}

function OutcomeIcon({ outcome }: { outcome: HistoryEntry['outcome'] }) {
  if (outcome === 'COMPLETED') {
    return <CheckCircle2 size={20} className="shrink-0 text-success" aria-hidden />;
  }
  if (outcome === 'SKIPPED') {
    return <MinusCircle size={20} className="shrink-0 text-steel" aria-hidden />;
  }
  return <AlertOctagon size={20} className="shrink-0 text-danger" aria-hidden />;
}
