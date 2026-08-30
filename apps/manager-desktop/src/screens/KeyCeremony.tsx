import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertOctagon, KeyRound, Printer, ShieldCheck } from 'lucide-react';
import { api, ApiRequestError } from '../lib/api';
import { locale } from '../lib/locale';
import { Button, Card, Field, Input, Notice } from '../components/ui';

/**
 * The backup key ceremony (CLAUDE_v3.md §7.3, §12.19).
 *
 * ## Why this is a wall and not a card on a settings page
 *
 * The failure it prevents does not look like a failure. A merchant completes setup, sees
 * backups running nightly, and has a folder of intact encrypted archives in Drive. Then
 * the machine burns, or is stolen, or its disk dies — and because the only copy of the
 * key was on that machine, every one of those archives is permanently unopenable. Not by
 * us, not by Google, not by anyone.
 *
 * That is worse than never having had backups, because it was trusted. So the ceremony
 * has no "later" button, no close control, and no route around it: while the key is
 * unconfirmed this component replaces the dashboard entirely.
 *
 * ## Why re-entry rather than a checkbox
 *
 * "I have written it down" is a claim. Typing 44 characters back is evidence. The copy
 * asks explicitly for it to be typed from the paper rather than pasted from the screen —
 * that cannot be enforced, and saying it still changes what most people do.
 */

export interface KeyStatus {
  configured: boolean;
  fingerprint: string | null;
  confirmed: boolean;
  confirmedAt: string | null;
  confirmedBy: string | null;
  backupsEnabled: boolean;
  /** Whether any key has ever been confirmed — a first run versus a replaced key. */
  everConfirmed: boolean;
}

export function useKeyStatus() {
  return useQuery({
    queryKey: ['backup', 'key'],
    queryFn: () => api.get<KeyStatus>('/backup/key'),
    // The dashboard is unusable while this is unresolved, so it must not sit stale.
    staleTime: 0,
  });
}

/**
 * The printable sheet.
 *
 * Rendered into the document and revealed only by the print stylesheet, so the key never
 * sits visible on a second surface of the screen. `window.print()` in the Tauri webview
 * goes to the machine's real print dialog.
 */
function PrintableKey({ value, fingerprint }: { value: string; fingerprint: string }) {
  return (
    <div className="hidden print:block" dir="rtl">
      <h1 className="mb-4 text-2xl font-bold">{locale.keyCeremony.printTitle}</h1>
      <p className="mb-6 text-base font-bold">{locale.keyCeremony.printWarning}</p>

      <p className="mb-2 text-sm">{locale.keyCeremony.keyLabel}</p>
      <p className="mb-6 break-all font-mono text-lg" dir="ltr">
        {value}
      </p>

      <p className="mb-2 text-sm">{locale.keyCeremony.fingerprintLabel}</p>
      <p className="mb-6 font-mono text-base" dir="ltr">
        {fingerprint}
      </p>

      <p className="text-sm">
        {locale.keyCeremony.printGeneratedAt}: {new Date().toLocaleString('ar-IQ')}
      </p>
    </div>
  );
}

export function KeyCeremonyScreen({ onCompleted }: { onCompleted?: () => void }) {
  const queryClient = useQueryClient();
  const status = useKeyStatus();
  const [revealed, setRevealed] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);

  const generate = useMutation({
    mutationFn: () => api.post<KeyStatus>('/backup/key/generate'),
    onSuccess: (next) => queryClient.setQueryData(['backup', 'key'], next),
  });

  const reveal = useMutation({
    mutationFn: () => api.post<{ key: string }>('/backup/key/reveal'),
    onSuccess: ({ key }) => setRevealed(key),
    onError: (e) => setError(e instanceof ApiRequestError ? e.message : locale.common.error),
  });

  const confirm = useMutation({
    mutationFn: (key: string) => api.post<KeyStatus>('/backup/key/confirm', { key }),
    onSuccess: (next) => {
      queryClient.setQueryData(['backup', 'key'], next);
      // Cleared immediately on success: there is no reason for the key to stay in a
      // form field, in React state, or in the browser's autofill after this point.
      setTyped('');
      setRevealed(null);
      setError(null);
      onCompleted?.();
    },
    onError: (e) =>
      setError(
        e instanceof ApiRequestError && e.code === 'VALIDATION_FAILED'
          ? locale.keyCeremony.mismatch
          : e instanceof ApiRequestError
            ? e.message
            : locale.common.error,
      ),
  });

  if (status.isLoading) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center">
        <p className="text-steel">{locale.common.loading}</p>
      </div>
    );
  }

  const key = status.data;

  return (
    <div className="min-h-[100dvh] overflow-y-auto bg-canvas print:bg-white">
      <div className="mx-auto max-w-3xl px-8 py-10 print:p-0">
        {/* The warning comes BEFORE the key. A consequence explained after the secret is
            already on screen is read by nobody. */}
        <div className="mb-8 flex items-start gap-4 print:hidden">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-accent-tint text-accent">
            <KeyRound size={24} aria-hidden />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-ink">{locale.keyCeremony.title}</h1>
            <p className="text-base text-steel">{locale.keyCeremony.subtitle}</p>
          </div>
        </div>

        <div className="mb-8 print:hidden">
          <Notice tone="danger" title={locale.keyCeremony.whyTitle}>
            <div className="space-y-2">
              <p>{locale.keyCeremony.why}</p>
              <p className="font-bold">{locale.keyCeremony.whyHard}</p>
              <p>{locale.keyCeremony.whyWorse}</p>
            </div>
          </Notice>
        </div>

        {/* Step 1 — generate. Idempotent server-side, and incapable of replacing an
            existing key, so a double click cannot orphan a shop's archives. */}
        {!key?.configured ? (
          <Card className="p-6 print:hidden">
            <Button
              onClick={() => generate.mutate()}
              disabled={generate.isPending}
              className="w-full"
            >
              {generate.isPending ? locale.keyCeremony.generating : locale.keyCeremony.generate}
            </Button>
          </Card>
        ) : null}

        {/* Step 2 — reveal, record, print. */}
        {key?.configured && !revealed ? (
          <Card className="space-y-4 p-6 print:hidden">
            <div>
              <p className="mb-1 text-sm text-steel">{locale.keyCeremony.fingerprintLabel}</p>
              <p className="font-mono text-lg text-ink" dir="ltr">
                {key.fingerprint}
              </p>
              <p className="mt-1 text-sm text-steel">{locale.keyCeremony.fingerprintHint}</p>
            </div>
            <Button
              onClick={() => reveal.mutate()}
              disabled={reveal.isPending}
              className="w-full"
            >
              {reveal.isPending ? locale.keyCeremony.revealing : locale.keyCeremony.reveal}
            </Button>
          </Card>
        ) : null}

        {revealed && key?.fingerprint ? (
          <>
            <Card className="space-y-4 p-6 print:hidden">
              <div>
                <p className="mb-2 text-sm text-steel">{locale.keyCeremony.keyLabel}</p>
                <p
                  className="select-all break-all rounded-md border border-border bg-canvas p-4 font-mono text-lg text-ink"
                  dir="ltr"
                  data-testid="backup-key"
                >
                  {revealed}
                </p>
                <p className="mt-2 text-base text-ink">{locale.keyCeremony.keyHint}</p>
              </div>

              <Button variant="secondary" onClick={() => window.print()} className="w-full">
                <Printer size={18} aria-hidden />
                {locale.keyCeremony.print}
              </Button>
            </Card>

            <PrintableKey value={revealed} fingerprint={key.fingerprint} />
          </>
        ) : null}

        {/* Step 3 — prove it was recorded. */}
        {key?.configured ? (
          <Card className="mt-6 space-y-4 p-6 print:hidden">
            <div>
              <h2 className="text-lg font-bold text-ink">{locale.keyCeremony.confirmTitle}</h2>
              <p className="text-base text-steel">{locale.keyCeremony.confirmHint}</p>
            </div>

            <Field label={locale.keyCeremony.keyLabel} error={error ?? undefined}>
              <Input
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                placeholder={locale.keyCeremony.confirmPlaceholder}
                dir="ltr"
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>

            <Button
              onClick={() => confirm.mutate(typed)}
              disabled={confirm.isPending || typed.trim().length === 0}
              className="w-full"
            >
              {confirm.isPending ? locale.keyCeremony.confirming : locale.keyCeremony.confirm}
            </Button>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The standing reminder, shown on every screen while backups are off.
 *
 * Defence in depth behind the gate above. The gate covers first run; this covers the
 * state that arrives later — a key replaced during a migration or a restore onto new
 * hardware, which un-confirms itself by fingerprint (§12.19) and would otherwise leave a
 * shop backing nothing up with no visible sign.
 *
 * Deliberately not dismissible. A banner with an × is a banner that is gone by Tuesday.
 */
export function BackupBlockedBanner({ status, onFix }: { status: KeyStatus; onFix: () => void }) {
  if (status.backupsEnabled) return null;

  return (
    <div className="border-b border-danger/25 bg-danger-tint px-8 py-3 print:hidden">
      <div className="mx-auto flex max-w-content items-center gap-3">
        <AlertOctagon size={20} className="shrink-0 text-danger" aria-hidden />
        <div className="flex-1">
          <p className="text-sm font-bold text-danger">{locale.keyCeremony.bannerTitle}</p>
          <p className="text-sm text-ink">
            {status.configured
              ? locale.keyCeremony.bannerUnconfirmed
              : locale.keyCeremony.bannerUnconfigured}
          </p>
        </div>
        <Button variant="secondary" onClick={onFix}>
          {locale.keyCeremony.bannerAction}
        </Button>
      </div>
    </div>
  );
}

/** The confirmed state, for the Backup screen to show instead of the ceremony. */
export function KeyConfirmedSummary({ status }: { status: KeyStatus }) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-success/25 bg-success-tint p-4">
      <ShieldCheck size={20} className="shrink-0 text-success" aria-hidden />
      <div className="text-sm">
        <p className="font-bold text-success">{locale.keyCeremony.confirmedTitle}</p>
        <p className="text-ink">
          {locale.keyCeremony.confirmedBy} {status.confirmedBy} ·{' '}
          {locale.keyCeremony.confirmedAt}{' '}
          {status.confirmedAt ? new Date(status.confirmedAt).toLocaleDateString('ar-IQ') : ''} ·{' '}
          <span className="font-mono" dir="ltr">
            {status.fingerprint}
          </span>
        </p>
      </div>
    </div>
  );
}
