import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeftRight,
  CreditCard,
  Download,
  Hash,
  Plus,
  Printer,
} from 'lucide-react';
import type {
  CardBatch,
  CardBatchExportResponse,
  CardBatchListResponse,
} from '@walaa/shared-types';
import { api, ApiRequestError } from '../lib/api';
import { useFormErrors } from '../lib/form';
import { locale, formatDate } from '../lib/locale';
import {
  Button,
  Card,
  CardHeader,
  Chip,
  cn,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Notice,
  PageHeader,
  Skeleton,
} from '../components/ui';

/**
 * Physical card stock (CLAUDE_v3.md §12.25; laid out again 2026-09-02).
 *
 * The screen answers one question the merchant asks out loud — **how many blank
 * cards are left before I have to order more** — and makes the collision he worries
 * about unreachable rather than merely warned against.
 *
 * **There is no field for a starting serial, and that is the feature.** He chooses a
 * quantity; the server computes the range from the highest serial that exists. A
 * number he cannot enter is a number he cannot enter wrongly. The sequence panel
 * states that out loud rather than leaving it to be inferred, because the reassurance
 * is the point of the design and an unstated guarantee reassures nobody.
 *
 * ── Why the table became cards ─────────────────────────────────────────────
 *
 * A batch is not a row of five values. It is a range, five status tallies, a
 * provenance line, two printing actions and one destructive one — and squeezing that
 * into table cells produced the cramped rows this rewrite replaces. Each batch now
 * gets its own panel with room for its own sections, which is also what lets the
 * destructive action sit visually below the others instead of beside them.
 */
export function CardsScreen() {
  const queryClient = useQueryClient();
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  /*
    Rejections land on the box they are about. The quantity field is the one that
    actually gets refused — a batch size over the ceiling, or a zero — and it used to
    answer in a red panel at the top of a screen the field is not even on.
  */
  const errors = useFormErrors();

  const { data, isLoading, isError, refetch, error: loadError } = useQuery({
    queryKey: ['card-batches'],
    queryFn: () => api.get<CardBatchListResponse>('/cards/batches'),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['card-batches'] });

  const generate = useMutation({
    mutationFn: () =>
      api.post<{ batch: CardBatch }>('/cards/batches', {
        quantity: Number(quantity),
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    onSuccess: (response) => {
      setNotice(locale.cards.generated(response.batch.serialRangeFormatted));
      errors.clear();
      setQuantity('');
      setNote('');
      void invalidate();
    },
    onError: (failure: Error) => errors.fail(failure),
  });

  const voidBatch = useMutation({
    mutationFn: (params: { batchId: string; reason: string }) =>
      api.post<{ voided: number }>(`/cards/batches/${params.batchId}/void`, {
        reason: params.reason,
      }),
    onSuccess: (response) => {
      setNotice(locale.cards.voidedCount(response.voided));
      errors.clear();
      void invalidate();
    },
    onError: (failure: Error) => errors.fail(failure),
  });

  const askVoid = (batch: CardBatch): void => {
    if (!window.confirm(locale.cards.voidBatchConfirm(batch.counts.printed))) return;
    const reason = window.prompt(locale.cards.voidBatchReason);
    if (!reason || reason.trim().length < 2) return;
    voidBatch.mutate({ batchId: batch.id, reason: reason.trim() });
  };

  const totalPrinted = data?.batches.reduce((sum, batch) => sum + batch.quantity, 0) ?? 0;
  const highestSerial = data ? data.nextSerial - 1 : 0;

  const header = (
    <PageHeader
      icon={<CreditCard size={24} aria-hidden />}
      title={locale.cards.title}
      subtitle={locale.cards.subtitle}
    />
  );

  /*
    A dead backend renders an error, not a shimmer.

    Every branch below tested `isLoading || !data`, which is true both while the
    request is in flight AND after it has failed — so with the API down this screen
    sat on a skeleton indefinitely and told the merchant nothing. Ordering the error
    check FIRST is what separates the two conditions; `!data` still catches the
    in-flight case underneath it.
  */
  if (isError) {
    return (
      <>
        {header}
        <Card>
          <ErrorState what={locale.failure.what.cards} error={loadError} onRetry={() => void refetch()} />
        </Card>
      </>
    );
  }

  return (
    <>
      {header}

      <div className="space-y-6">
        {notice ? <Notice tone="accent">{notice}</Notice> : null}
        {errors.summary ? <Notice tone="danger">{errors.summary}</Notice> : null}

        {/* ── The reorder signal ──────────────────────────────────────────── */}

        {/* Two cards, not three: §6.5 forbids a row of three equal columns, and these
            two are not equal anyway. The narrower one carries a single number; the
            wider one carries three rows, and sizing them the other way round is what
            left the big figure stranded in an empty half-screen. */}
        <div className="grid items-stretch gap-6 lg:grid-cols-[2fr_3fr]">
          <Card className="flex flex-col">
            <CardHeader
              title={locale.cards.blanksRemaining}
              subtitle={locale.cards.blanksRemainingHint}
            />
            {/* Centred in whatever height the row settles at, so the figure never
                sits in a corner of its own card. */}
            <div className="flex flex-1 items-center gap-4 p-6">
              {isLoading || !data ? (
                <Skeleton className="h-14 w-32" />
              ) : (
                <>
                  {/* The reference's tinted icon square, at the scale this figure
                      asks for — the same treatment `StatTile` carries, so the one
                      headline number on this screen belongs to the same family as
                      the ones on Overview and Reports. */}
                  <span
                    className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-accent-tint text-accent"
                    aria-hidden
                  >
                    <CreditCard size={28} />
                  </span>
                  <span className="amount text-5xl leading-none text-accent">
                    {data.blanksRemaining}
                  </span>
                  <span className="text-base text-steel">{locale.cards.countPrinted}</span>
                </>
              )}
            </div>
          </Card>

          {/* The whole answer to "could two batches overlap?", stated rather than
              implied. §12.25 removed the choice; this says so. */}
          <Card>
            <CardHeader title={locale.cards.sequenceTitle} subtitle={locale.cards.sequenceHint} />
            <dl className="divide-y divide-border">
              <SequenceRow
                label={locale.cards.sequenceReached}
                value={
                  isLoading || !data
                    ? null
                    : highestSerial > 0
                      ? formatSerial(highestSerial)
                      : locale.cards.sequenceReachedNone
                }
                mono={highestSerial > 0}
              />
              <SequenceRow
                label={locale.cards.sequenceNext}
                value={isLoading || !data ? null : formatSerial(data.nextSerial)}
                mono
                emphasis
              />
              <SequenceRow
                label={locale.cards.sequenceTotal}
                value={
                  isLoading || !data
                    ? null
                    : `${totalPrinted} · ${locale.cards.sequenceBatches(data.batches.length)}`
                }
              />
            </dl>
          </Card>
        </div>

        {/* ── Ordering more ───────────────────────────────────────────────── */}

        <Card>
          <CardHeader title={locale.cards.generate} subtitle={locale.cards.quantityHint} />
          <div className="grid gap-5 p-6 md:grid-cols-[10rem_1fr_auto] md:items-end">
            <Field label={locale.cards.quantity} error={errors.fields.quantity} required>
              <Input
                value={quantity}
                onChange={(event) => setQuantity(event.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                dir="ltr"
                className="text-center font-mono text-xl"
              />
            </Field>

            <Field label={locale.cards.note} error={errors.fields.note}>
              <Input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder={locale.cards.notePlaceholder}
              />
            </Field>

            <Button
              onClick={() => generate.mutate()}
              disabled={generate.isPending || !quantity || Number(quantity) < 1}
            >
              <Plus size={18} aria-hidden />
              {generate.isPending ? locale.cards.generating : locale.cards.generate}
            </Button>
          </div>

          {/* Below the controls, and shown before anything is downloaded rather than
              after: the person who pulls the file is the one who has to delete it. */}
          <div className="border-t border-border p-6 pt-5">
            <Notice tone="warning">{locale.cards.exportWarning}</Notice>
          </div>
        </Card>

        {/* ── History ─────────────────────────────────────────────────────── */}

        {isLoading || !data ? (
          <div className="space-y-6">
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : data.batches.length === 0 ? (
          <Card>
            <EmptyState
              icon={<CreditCard size={22} aria-hidden />}
              title={locale.cards.empty}
              body={locale.cards.emptyBody}
            />
          </Card>
        ) : (
          <div className="space-y-6">
            {data.batches.map((batch) => (
              <BatchPanel
                key={batch.id}
                batch={batch}
                onVoid={() => askVoid(batch)}
                voidPending={voidBatch.isPending}
                onNotice={(message) => {
                  setNotice(message);
                  errors.clear();
                }}
                onError={(message: string) => errors.rejectForm(message)}
                onExported={() => void invalidate()}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/* ── The sequence panel ────────────────────────────────────────────────────── */

function SequenceRow({
  label,
  value,
  mono = false,
  emphasis = false,
}: {
  label: string;
  /** Null while loading. */
  value: string | null;
  mono?: boolean;
  emphasis?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-6 py-4">
      <dt className="text-sm text-steel">{label}</dt>
      <dd className={cn(mono && 'amount', emphasis ? 'text-2xl text-accent' : 'text-lg text-ink')}>
        {value === null ? <Skeleton className="h-6 w-20" /> : value}
      </dd>
    </div>
  );
}

/* ── One batch ─────────────────────────────────────────────────────────────── */

const formatSerial = (serial: number): string => String(serial).padStart(6, '0');

function BatchPanel({
  batch,
  onVoid,
  voidPending,
  onNotice,
  onError,
  onExported,
}: {
  batch: CardBatch;
  onVoid: () => void;
  voidPending: boolean;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  onExported: () => void;
}) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  /*
    Its own, because this panel is repeated once per batch. A rejection about the
    reprint range in batch three belongs beside batch three's boxes, not in a panel at
    the top of the page next to a different batch's.
  */
  const errors = useFormErrors();

  /**
   * Downloads go through a Blob rather than a link to the API.
   *
   * The export is a POST — it is audited, and a GET that quietly records who read
   * every card number in a batch would be a GET with side effects. A Blob also keeps
   * the file out of the browser's history and off any proxy's access log.
   */
  const download = (filename: string, body: string, type: string): void => {
    const url = URL.createObjectURL(new Blob([body], { type: `${type};charset=utf-8` }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const exportBatch = useMutation({
    mutationFn: (range: { serialFrom: number; serialTo: number } | null) =>
      api.post<CardBatchExportResponse>(`/cards/batches/${batch.id}/export`, range ?? {}),
    onSuccess: (response) => {
      // The filename says which file this is. A reprint slice and a whole batch
      // landing in the same downloads folder with the same name is how the wrong one
      // gets sent to the printer.
      const stem = response.exportedRangeFormatted
        ? `walaa-batch-${response.batch.batchNumber}-reprint-${from}-${to}`
        : `walaa-batch-${response.batch.batchNumber}`;

      download(`${stem}.csv`, response.csv, 'text/csv');
      download(`${stem}-manifest.txt`, response.manifest, 'text/plain');

      onNotice(
        response.exportedRangeFormatted
          ? locale.cards.reprintedRange(response.exportedRangeFormatted, response.rows.length)
          : locale.cards.exportWarning,
      );
      setFrom('');
      setTo('');
      onExported();
    },
    /*
      Marked on this panel's own boxes when the API names a field — the export range
      is refused by `serialFrom`/`serialTo` — and passed up as a sentence when it
      does not, so a failure with nothing to point at still reaches the screen.
    */
    onError: (failure: Error) => {
      errors.fail(failure);
      if (!(failure instanceof ApiRequestError) || !failure.fields?.length) {
        onError(failure.message);
      }
    },
  });

  const fromNumber = Number(from);
  const toNumber = Number(to);
  const rangeValid =
    from !== '' &&
    to !== '' &&
    Number.isFinite(fromNumber) &&
    Number.isFinite(toNumber) &&
    fromNumber <= toNumber &&
    toNumber >= batch.serialStart &&
    fromNumber <= batch.serialEnd;

  return (
    <Card>
      <CardHeader
        title={locale.cards.batchLabel(batch.batchNumber)}
        subtitle={locale.cards.batchDetails}
        action={<Chip tone="neutral">{locale.cards.batchStatus[batch.status]}</Chip>}
      />

      {/* ── Facts ─────────────────────────────────────────────────────────── */}
      <dl className="grid gap-x-6 gap-y-5 p-6 sm:grid-cols-2 lg:grid-cols-4">
        <Fact
          label={locale.cards.colRange}
          value={
            <span className="amount text-lg" dir="ltr">
              {batch.serialRangeFormatted}
            </span>
          }
        />
        <Fact
          label={locale.cards.colQuantity}
          value={<span className="amount text-lg">{batch.quantity}</span>}
        />
        <Fact
          label={locale.cards.colGeneratedBy}
          value={
            <span className="text-base text-ink">
              {batch.generatedByName ?? locale.common.none}
            </span>
          }
          hint={formatDate(batch.generatedAt)}
        />
        <Fact
          label={locale.cards.exportedAt}
          value={
            <span className="text-base text-ink">
              {batch.exportedAt
                ? formatDate(batch.exportedAt)
                : locale.cards.exportedNever}
            </span>
          }
          hint={batch.note ? `${locale.cards.batchNote}: ${batch.note}` : undefined}
        />
      </dl>

      {/* ── Tallies ───────────────────────────────────────────────────────── */}

      {/* "How many are left" is not one number for the shop — it is one per batch,
          and a batch losing cards faster than the others is worth seeing. Every
          state is shown even at zero: a row that appears only when non-zero makes
          the reader wonder whether it is missing or absent. */}
      <section className="border-t border-border p-6">
        <h3 className="mb-4 text-sm font-medium text-steel">{locale.cards.countsTitle}</h3>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <Tally label={locale.cards.countPrinted} value={batch.counts.printed} tone="accent" />
          <Tally label={locale.cards.countAssigned} value={batch.counts.assigned} tone="success" />
          <Tally label={locale.cards.countLost} value={batch.counts.lost} tone="warning" />
          <Tally label={locale.cards.countReplaced} value={batch.counts.replaced} />
          <Tally label={locale.cards.countVoid} value={batch.counts.void} tone="danger" />
        </div>
      </section>

      {/* ── Printing ──────────────────────────────────────────────────────── */}

      <section className="border-t border-border p-6">
        <h3 className="mb-1 flex items-center gap-2 text-base font-semibold text-ink">
          <Printer size={18} aria-hidden className="text-steel" />
          {locale.cards.exportSection}
        </h3>
        <p className="mb-5 text-sm leading-relaxed text-steel">{locale.cards.exportWholeHint}</p>

        <Button
          variant="ghost"
          onClick={() => exportBatch.mutate(null)}
          disabled={exportBatch.isPending}
        >
          <Download size={16} aria-hidden />
          {exportBatch.isPending ? locale.cards.exporting : locale.cards.exportWhole}
        </Button>

        {/* The reprint slice. Its own sub-panel because it is a different act with a
            different consequence: a smaller file, and an audit entry that records
            exactly which numbers were read. */}
        <div className="mt-5 rounded-md border border-border bg-canvas p-5">
          <h4 className="flex items-center gap-2 text-base font-semibold text-ink">
            <ArrowLeftRight size={16} aria-hidden className="text-steel" />
            {locale.cards.reprint}
          </h4>
          <p className="mt-1 text-sm leading-relaxed text-steel">{locale.cards.reprintHint}</p>

          <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Field label={locale.cards.reprintFrom} error={errors.fields.serialFrom}>
              <Input
                value={from}
                onChange={(event) => setFrom(event.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                dir="ltr"
                placeholder={formatSerial(batch.serialStart)}
                className="text-center font-mono"
              />
            </Field>

            <Field label={locale.cards.reprintTo} error={errors.fields.serialTo}>
              <Input
                value={to}
                onChange={(event) => setTo(event.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                dir="ltr"
                placeholder={formatSerial(batch.serialEnd)}
                className="text-center font-mono"
              />
            </Field>

            <Button
              variant="ghost"
              onClick={() => exportBatch.mutate({ serialFrom: fromNumber, serialTo: toNumber })}
              disabled={exportBatch.isPending || !rangeValid}
            >
              <Download size={16} aria-hidden />
              {locale.cards.reprintSubmit}
            </Button>
          </div>

          {/* Only once they have typed something wrong — an error shown against an
              empty pair of fields is a scold, not a hint. */}
          {(from !== '' || to !== '') && !rangeValid ? (
            <p className="mt-3 text-sm text-danger">{locale.cards.reprintRangeError}</p>
          ) : (
            <p className="mt-3 flex items-center gap-1.5 text-sm text-steel">
              <Hash size={14} aria-hidden />
              <span dir="ltr" className="font-mono">
                {batch.serialRangeFormatted}
              </span>
            </p>
          )}
        </div>
      </section>

      {/* ── The destructive one ───────────────────────────────────────────── */}

      {/* Last, quieter, and behind its own heading. It used to sit beside the export
          button at the same weight, which is the wrong shape for an action that
          destroys stock somebody paid for. It stays reachable in one click, because a
          merchant told to void a thousand cards one at a time will not do it, and a
          remedy nobody performs is not a remedy. */}
      {batch.counts.printed > 0 ? (
        <section className="border-t border-border bg-canvas/60 px-6 py-5">
          <p className="mb-1 text-sm font-medium text-steel">{locale.cards.dangerZone}</p>
          <p className="mb-4 text-sm leading-relaxed text-steel">{locale.cards.voidBatchHint}</p>
          <Button
            variant="ghost"
            className="border-danger/25 text-danger hover:bg-danger-tint"
            onClick={onVoid}
            disabled={voidPending}
          >
            <AlertTriangle size={16} aria-hidden />
            {locale.cards.voidBatch}
          </Button>
        </section>
      ) : null}
    </Card>
  );
}

function Fact({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div>
      <dt className="mb-1 text-sm text-steel">{label}</dt>
      <dd>{value}</dd>
      {hint ? <p className="mt-1 text-sm text-steel">{hint}</p> : null}
    </div>
  );
}

function Tally({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'accent' | 'success' | 'warning' | 'danger';
}) {
  return (
    <div
      className={cn(
        'rounded-md border px-4 py-3',
        // Zero is drawn plainly whatever the tone: colouring a nought amber says a
        // batch has losses when it has none.
        value === 0 && 'border-border bg-canvas',
        value > 0 && tone === 'accent' && 'border-accent/20 bg-accent-tint',
        value > 0 && tone === 'success' && 'border-success/20 bg-success-tint',
        value > 0 && tone === 'warning' && 'border-amber/20 bg-amber-tint',
        value > 0 && tone === 'danger' && 'border-danger/20 bg-danger-tint',
        value > 0 && !tone && 'border-border bg-canvas',
      )}
    >
      {/* Ink, not steel. These labels sit on four different tinted grounds, where
          steel measures 4.15–4.40 against a 4.5 floor — and 4.55 even on the plain
          canvas, which is passing by a rounding error. The number beside it carries
          the tone; the label only has to be readable (§12.34, §2.3). */}
      <p className="text-sm text-ink">{label}</p>
      <p
        className={cn(
          'amount mt-1 text-2xl',
          value === 0 && 'text-steel',
          value > 0 && tone === 'accent' && 'text-accent',
          value > 0 && tone === 'success' && 'text-success',
          value > 0 && tone === 'warning' && 'text-amber',
          value > 0 && tone === 'danger' && 'text-danger',
          value > 0 && !tone && 'text-ink',
        )}
      >
        {value}
      </p>
    </div>
  );
}
