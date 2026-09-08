import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertOctagon, CheckCircle2, CloudOff, DatabaseBackup, HardDrive, MinusCircle, RotateCcw, Usb } from 'lucide-react';
import { api, ApiRequestError } from '../lib/api';
import { locale, formatDateTime } from '../lib/locale';
import {
  Button,
  Card,
  CardHeader,
  Chip,
  ErrorState,
  Notice,
  PageHeader,
  Skeleton,
} from '../components/ui';
import { DemoHardwareNotice, DemoResetCard } from '../components/DemoSurfaces';
import { IS_DEMO } from '../lib/demo';
import type {
  BackupOverview,
  HistoryEntry,
  VerificationResult,
} from '@walaa/shared-types';
import { KeyConfirmedSummary } from './KeyCeremony';

/**
 * Backup (CLAUDE_v3.md §7.3, §12.17–§12.21).
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

  const run = useMutation({
    mutationFn: () => api.post<unknown>('/backup/run'),
    onSettled: invalidate,
  });

  const verify = useMutation({
    mutationFn: () => api.post<VerificationResult>('/backup/verify'),
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
          <ErrorState onRetry={() => void overview.refetch()} />
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
            <div className="flex gap-3 border-t border-border p-6">
              <Button
                onClick={() => run.mutate()}
                disabled={run.isPending || verify.isPending || !data.key.backupsEnabled}
              >
                {run.isPending ? locale.backup.running : locale.backup.runNow}
              </Button>
              <Button
                variant="secondary"
                onClick={() => verify.mutate()}
                disabled={run.isPending || verify.isPending || !data.key.backupsEnabled}
              >
                <RotateCcw size={18} aria-hidden />
                {verify.isPending ? locale.backup.verifying : locale.backup.verifyNow}
              </Button>
            </div>
            {run.error ? (
              <div className="px-6 pb-6">
                <Notice tone="danger">
                  {run.error instanceof ApiRequestError ? run.error.message : locale.common.error}
                </Notice>
              </div>
            ) : null}
          </Card>

          {/* The restore test — §7.3's most commonly skipped step. */}
          <Card>
            <CardHeader
              title={locale.backup.restoreTitle}
              subtitle={locale.backup.restoreHint}
            />
            <div className="space-y-3 p-6">
              <p className="text-sm text-steel">
                {locale.backup.verifiedAt}:{' '}
                <span className="font-mono text-ink">
                  {data.history.lastVerification
                    ? dateTime(data.history.lastVerification.at)
                    : locale.backup.neverVerified}
                </span>
              </p>

              {verify.data ? (
                <Notice tone={verify.data.ok ? 'accent' : 'danger'}>
                  <div className="space-y-1">
                    <p className="font-semibold">
                      {verify.data.ok ? locale.backup.verifyPassed : locale.backup.verifyFailed}
                    </p>
                    {/* Named explicitly. "The file opened" would pass against a backup
                        missing the most recent day of sales, which is the whole of
                        §12.17. */}
                    {verify.data.recencyProven ? <p>{locale.backup.recencyProven}</p> : null}
                    <p className="text-sm">
                      {locale.backup.integrity}: {verify.data.restore.integrity}
                    </p>
                    {verify.data.failure ? <p className="text-sm">{verify.data.failure}</p> : null}
                  </div>
                </Notice>
              ) : null}

              {verify.error ? (
                <Notice tone="danger">
                  {verify.error instanceof ApiRequestError
                    ? verify.error.message
                    : locale.common.error}
                </Notice>
              ) : null}
            </div>
          </Card>

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
                        {destination.available ? locale.common.enabled : locale.backup.never}
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
                          {entry.destinations.map((d) => `${d.kind}${d.ok ? '' : ' ✕'}`).join(' · ')}
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

function OutcomeIcon({ outcome }: { outcome: HistoryEntry['outcome'] }) {
  if (outcome === 'COMPLETED') {
    return <CheckCircle2 size={20} className="shrink-0 text-success" aria-hidden />;
  }
  if (outcome === 'SKIPPED') {
    return <MinusCircle size={20} className="shrink-0 text-steel" aria-hidden />;
  }
  return <AlertOctagon size={20} className="shrink-0 text-danger" aria-hidden />;
}
