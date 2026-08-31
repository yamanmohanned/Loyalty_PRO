import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CreditCard, Download, Plus } from 'lucide-react';
import type {
  CardBatch,
  CardBatchExportResponse,
  CardBatchListResponse,
} from '@walaa/shared-types';
import { api } from '../lib/api';
import { locale } from '../lib/locale';
import {
  Button,
  Card,
  CardHeader,
  Chip,
  EmptyState,
  Field,
  Input,
  Notice,
  PageHeader,
  SkeletonTable,
} from '../components/ui';

/**
 * Physical card stock (CLAUDE_v3.md §12.25).
 *
 * The screen exists to answer one question the merchant asks out loud — **how many
 * blank cards are left before I have to order more** — and to make the collision he
 * worries about unreachable rather than merely warned against.
 *
 * **There is no field for a starting serial, and that is the feature.** He chooses a
 * quantity; the server computes the range from the highest serial that exists. A
 * number he cannot enter is a number he cannot enter wrongly.
 */
export function CardsScreen() {
  const queryClient = useQueryClient();
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
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
      setError(null);
      setQuantity('');
      setNote('');
      void invalidate();
    },
    onError: (failure: Error) => setError(failure.message),
  });

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
    mutationFn: (batchId: string) =>
      api.post<CardBatchExportResponse>(`/cards/batches/${batchId}/export`, {}),
    onSuccess: (response) => {
      const stem = `walaa-batch-${response.batch.batchNumber}`;
      download(`${stem}.csv`, response.csv, 'text/csv');
      download(`${stem}-manifest.txt`, response.manifest, 'text/plain');
      setNotice(locale.cards.exportWarning);
      setError(null);
      void invalidate();
    },
    onError: (failure: Error) => setError(failure.message),
  });

  const voidBatch = useMutation({
    mutationFn: (params: { batchId: string; reason: string }) =>
      api.post<{ voided: number }>(`/cards/batches/${params.batchId}/void`, {
        reason: params.reason,
      }),
    onSuccess: (response) => {
      setNotice(locale.cards.voidedCount(response.voided));
      setError(null);
      void invalidate();
    },
    onError: (failure: Error) => setError(failure.message),
  });

  const askVoid = (batch: CardBatch): void => {
    if (!window.confirm(locale.cards.voidBatchConfirm(batch.counts.printed))) return;
    const reason = window.prompt(locale.cards.voidBatchReason);
    if (!reason || reason.trim().length < 2) return;
    voidBatch.mutate({ batchId: batch.id, reason: reason.trim() });
  };

  return (
    <>
      <PageHeader title={locale.cards.title} subtitle={locale.cards.subtitle} />

      {notice ? <Notice tone="accent">{notice}</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}

      {/* The reorder signal, given the most room on the screen. Everything else here
          is history; this is the only number that asks for an action. */}
      <div className="mb-4 grid gap-4 md:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader title={locale.cards.blanksRemaining} subtitle={locale.cards.blanksRemainingHint} />
          <p className="font-mono text-5xl font-bold text-accent">
            {isLoading || !data ? '—' : data.blanksRemaining}
          </p>
        </Card>

        <Card>
          <CardHeader title={locale.cards.nextSerial} />
          <p className="font-mono text-3xl font-bold">
            {isLoading || !data ? '—' : String(data.nextSerial).padStart(6, '0')}
          </p>
        </Card>
      </div>

      <Card className="mb-4">
        <CardHeader title={locale.cards.generate} subtitle={locale.cards.quantityHint} />

        <div className="flex flex-wrap items-end gap-4">
          <Field label={locale.cards.quantity} className="w-40">
            <Input
              value={quantity}
              onChange={(event) => setQuantity(event.target.value.replace(/\D/g, ''))}
              inputMode="numeric"
              dir="ltr"
              className="text-center font-mono text-xl"
            />
          </Field>

          <Field label={locale.cards.note} className="min-w-64 flex-1">
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
      </Card>

      <Card>
        <CardHeader title={locale.cards.title} />

        {isLoading || !data ? (
          <SkeletonTable rows={4} columns={5} />
        ) : data.batches.length === 0 ? (
          <EmptyState
            icon={CreditCard}
            title={locale.cards.empty}
            body={locale.cards.emptyBody}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start">
              <thead>
                <tr className="border-b border-border text-sm text-steel">
                  <th className="py-3 text-start font-medium">{locale.cards.colBatch}</th>
                  <th className="py-3 text-start font-medium">{locale.cards.colRange}</th>
                  <th className="py-3 text-start font-medium">{locale.cards.colStatus}</th>
                  <th className="py-3 text-start font-medium">{locale.cards.colGeneratedBy}</th>
                  <th className="py-3 text-start font-medium" />
                </tr>
              </thead>
              <tbody>
                {data.batches.map((batch) => (
                  <tr key={batch.id} className="border-b border-border last:border-0 align-top">
                    <td className="py-4 font-mono text-lg font-bold">{batch.batchNumber}</td>

                    <td className="py-4">
                      <span className="font-mono text-base" dir="ltr">
                        {batch.serialRangeFormatted}
                      </span>
                      <span className="block text-sm text-steel">
                        {locale.cards.colQuantity}: {batch.quantity}
                      </span>
                    </td>

                    <td className="py-4">
                      <Chip tone="neutral">{locale.cards.batchStatus[batch.status]}</Chip>
                      {/* Per-status tallies, because "how many are left" is not one
                          number for the whole shop — it is one per batch, and a batch
                          losing cards faster than the others is worth seeing. */}
                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm text-steel">
                        <span>
                          {locale.cards.countPrinted}: <b className="text-ink">{batch.counts.printed}</b>
                        </span>
                        <span>
                          {locale.cards.countAssigned}: {batch.counts.assigned}
                        </span>
                        {batch.counts.lost > 0 ? (
                          <span>
                            {locale.cards.countLost}: {batch.counts.lost}
                          </span>
                        ) : null}
                        {batch.counts.replaced > 0 ? (
                          <span>
                            {locale.cards.countReplaced}: {batch.counts.replaced}
                          </span>
                        ) : null}
                        {batch.counts.void > 0 ? (
                          <span>
                            {locale.cards.countVoid}: {batch.counts.void}
                          </span>
                        ) : null}
                      </div>
                    </td>

                    <td className="py-4 text-base">
                      {batch.generatedByName ?? '—'}
                      <span className="block text-sm text-steel">
                        {new Date(batch.generatedAt).toLocaleDateString('ar-IQ')}
                      </span>
                      {batch.note ? (
                        <span className="block text-sm text-steel">{batch.note}</span>
                      ) : null}
                    </td>

                    <td className="py-4">
                      <div className="flex flex-col items-stretch gap-2">
                        <Button
                          variant="ghost"
                          onClick={() => exportBatch.mutate(batch.id)}
                          disabled={exportBatch.isPending}
                        >
                          <Download size={16} aria-hidden />
                          {exportBatch.isPending ? locale.cards.exporting : locale.cards.export}
                        </Button>

                        {/* The remedy for a leaked export file, and it has to be one
                            action: a merchant told to void a thousand cards one at a
                            time will not do it, and a remedy nobody performs is not
                            a remedy. */}
                        {batch.counts.printed > 0 ? (
                          <Button
                            variant="ghost"
                            className="text-danger"
                            onClick={() => askVoid(batch)}
                            disabled={voidBatch.isPending}
                          >
                            <AlertTriangle size={16} aria-hidden />
                            {locale.cards.voidBatch}
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <Notice tone="warning">
          <div className="space-y-1">
            <p className="font-semibold">{locale.cards.exportWarning}</p>
            <p className="text-sm">{locale.cards.voidBatchHint}</p>
          </div>
        </Notice>
      </Card>
    </>
  );
}
