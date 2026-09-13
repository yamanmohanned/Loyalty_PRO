import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Printer, ShieldCheck } from 'lucide-react';
import { PAPER_WIDTHS, type CaptureStatus, type PaperWidth } from '@walaa/shared-types';
import { api } from '../lib/api';
import { formatDate, locale } from '../lib/locale';
import {
  Button,
  Card,
  CardHeader,
  Chip,
  cn,
  ErrorState,
  Field,
  Notice,
  PageHeader,
  Select,
} from '../components/ui';
import { DemoHardwareNotice } from '../components/DemoSurfaces';
import { IS_DEMO } from '../lib/demo';

/**
 * Print capture settings (CLAUDE_v3.md §4, PROMPT_v3 V3-3).
 *
 * The screen's real job is to make the **Fail-Open distinction visible** before a
 * merchant picks a mode. `SPOOL_WATCH` observes the print spool from outside the
 * path and cannot stop printing however badly it fails. The other three sit in the
 * path: they forward first and a watchdog restarts them, but there is still a
 * window in which a job can be lost. §4.6 originally promised all four were safe;
 * that was corrected, and this UI states the corrected truth rather than the
 * comfortable version.
 *
 * The agent itself does not exist yet — it is built in V3-5 — so status is shown
 * honestly as "not installed" rather than faked.
 */

type CaptureMode = 'SPOOL_WATCH' | 'VIRTUAL_PRINTER' | 'SERIAL_BRIDGE' | 'NETWORK_PROXY';

const MODES: Array<{
  key: CaptureMode;
  label: string;
  description: string;
  inPath: boolean;
  setup: string;
}> = [
  {
    key: 'SPOOL_WATCH',
    label: locale.captureModes.SPOOL_WATCH,
    description: locale.capture.modeSpoolHint,
    inPath: false,
    setup: 'لا يحتاج أي إعداد على برنامج المحاسبة.',
  },
  {
    key: 'VIRTUAL_PRINTER',
    label: locale.captureModes.VIRTUAL_PRINTER,
    description: 'طابعة وسيطة تلتقط ثم تمرّر إلى الطابعة الحقيقية.',
    inPath: true,
    setup: 'يجب توجيه برنامج المحاسبة إلى الطابعة الوسيطة.',
  },
  {
    key: 'SERIAL_BRIDGE',
    label: locale.captureModes.SERIAL_BRIDGE,
    description: 'يقرأ من منفذ COM افتراضي ويمرّر إلى المنفذ الحقيقي.',
    inPath: true,
    setup: 'يجب تغيير المنفذ في برنامج المحاسبة.',
  },
  {
    key: 'NETWORK_PROXY',
    label: locale.captureModes.NETWORK_PROXY,
    description: 'يستمع على المنفذ 9100 ويمرّر إلى عنوان الطابعة الحقيقي.',
    inPath: true,
    setup: 'يجب تغيير عنوان الطابعة في برنامج المحاسبة.',
  },
];

export function CaptureScreen() {
  const [mode, setMode] = useState<CaptureMode>('SPOOL_WATCH');
  const [codepage, setCodepage] = useState('AUTO');

  const selected = MODES.find((m) => m.key === mode);

  return (
    <>
      <PageHeader
        icon={<Printer size={24} aria-hidden />}
        title={locale.capture.title}
        subtitle={locale.capture.subtitle}
      />

      {/*
        Two different sentences for the same absent agent.

        On a real till «الوكيل غير مثبَّت» is a warning and belongs in amber: the shop
        believes it is capturing sales and is not. On a demo laptop there is no till to
        capture from, and the same amber notice tells a merchant evaluating the product
        that it arrived broken. The condition is identical; what it MEANS is not.
      */}
      {IS_DEMO ? (
        <DemoHardwareNotice className="mb-6" />
      ) : (
        <div className="mb-6">
          <CaptureHealth />
        </div>
      )}

      <Card className="mb-6">
        <CardHeader title={locale.capture.modeTitle} />
        <ul className="divide-y divide-border">
          {MODES.map((m) => (
            <li key={m.key}>
              <button
                type="button"
                onClick={() => setMode(m.key)}
                className={cn(
                  'flex w-full items-start gap-4 p-6 text-start transition-colors duration-fast',
                  mode === m.key ? 'bg-accent-tint/40' : 'hover:bg-canvas',
                )}
              >
                <span
                  className={cn(
                    'mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-pill border-2',
                    mode === m.key ? 'border-accent bg-accent' : 'border-border',
                  )}
                >
                  {mode === m.key ? <span className="h-1.5 w-1.5 rounded-pill bg-white" /> : null}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-base font-semibold text-ink">{m.label}</span>
                    {!m.inPath ? (
                      <Chip tone="success">
                        <ShieldCheck size={14} className="me-1 inline" aria-hidden />
                        {locale.capture.preferredBadge}
                      </Chip>
                    ) : (
                      <Chip tone="warning">داخل مسار الطباعة</Chip>
                    )}
                  </span>
                  <span className="mt-1 block text-sm leading-relaxed text-steel">
                    {m.description}
                  </span>
                  <span className="mt-1 block text-xs text-steel">{m.setup}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Card>

      {/* The honest statement of residual risk, shown only when it applies. */}
      {selected?.inPath ? (
        <div className="mb-6">
          <Notice tone="danger" title="تحذير">
            <span className="inline-flex items-start gap-2">
              <AlertTriangle size={18} className="mt-0.5 shrink-0" aria-hidden />
              <span>{locale.capture.inPathWarning}</span>
            </span>
          </Notice>
        </div>
      ) : (
        <div className="mb-6">
          <Notice tone="accent">
            <span className="inline-flex items-start gap-2">
              <CheckCircle2 size={18} className="mt-0.5 shrink-0" aria-hidden />
              <span>
                هذا الوضع خارج مسار الطباعة تماماً — لا يمكنه تعطيل الطباعة مهما حدث له.
              </span>
            </span>
          </Notice>
        </div>
      )}

      <div className="grid grid-cols-2 gap-6">
        <Card>
          <CardHeader title={locale.capture.codepage} />
          <div className="p-6">
            <Field label={locale.capture.codepage} hint={locale.capture.codepageHint}>
              <Select value={codepage} onChange={(e) => setCodepage(e.target.value)}>
                <option value="AUTO">كشف تلقائي</option>
                <option value="CP864">CP864</option>
                <option value="WINDOWS_1256">Windows-1256</option>
                <option value="UTF8">UTF-8</option>
              </Select>
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader title={locale.capture.calibrationTitle} />
          <div className="space-y-4 p-6">
            <p className="text-sm leading-relaxed text-steel">{locale.capture.calibrationHint}</p>
            <Button variant="secondary" disabled>
              <Printer size={18} aria-hidden />
              {locale.capture.calibrationStart}
            </Button>
            <p className="text-xs text-steel">{locale.capture.calibrationUnavailable}</p>
          </div>
        </Card>
      </div>

      <PaperWidthPanel />
    </>
  );
}

/**
 * The Loyalty Station's thermal roll width (§5, §10.7).
 *
 * **It sits on this screen because this is the only printer-facing screen, and it is
 * labelled for the printer it actually governs.** Everything above concerns the
 * *cashier's* receipt printer, which the capture agent listens to; this is the
 * *station's* slip printer, a different device in a different place. Two printers on
 * one screen is a real chance to change the wrong one, so the copy names the machine
 * rather than saying "the printer".
 *
 * Merchant-level, not per-station: a shop running two roll widths is hypothetical, and
 * a per-station setting would be a settings surface on an app that has none by design
 * (§6.4).
 */
function PaperWidthPanel(): JSX.Element {
  const queryClient = useQueryClient();
  const printing = useQuery({
    queryKey: ['printing'],
    queryFn: () => api.get<{ paperWidth: PaperWidth }>('/system/printing'),
  });

  const save = useMutation({
    mutationFn: (paperWidth: PaperWidth) =>
      api.put<{ paperWidth: PaperWidth }>('/system/printing', { paperWidth }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['printing'] }),
  });

  const current = printing.data?.paperWidth;

  /* Without this the select rendered blank and disabled-looking with no reason given,
     which reads as "this setting is broken" rather than "the server is unreachable". */
  if (printing.isError) {
    return (
      <Card className="mt-6">
        <CardHeader title={locale.capture.paperTitle} />
        <ErrorState
          what={locale.failure.what.capturePrinting}
          error={printing.error}
          onRetry={() => void printing.refetch()}
        />
      </Card>
    );
  }

  return (
    <Card className="mt-6">
      <CardHeader title={locale.capture.paperTitle} />
      <div className="space-y-4 p-6">
        <p className="text-sm leading-relaxed text-steel">{locale.capture.paperHint}</p>

        <Field label={locale.capture.paperLabel}>
          <Select
            value={current === undefined ? '' : String(current)}
            disabled={printing.isPending || save.isPending}
            onChange={(e) => save.mutate(Number(e.target.value) as PaperWidth)}
          >
            {PAPER_WIDTHS.map((width) => (
              <option key={width} value={String(width)}>
                {locale.capture.paperOption(width)}
              </option>
            ))}
          </Select>
        </Field>

        {/* Said out loud because it is the one thing a manager would otherwise discover
            by walking to the station and finding nothing changed. */}
        <p className="text-xs text-steel">{locale.capture.paperPropagation}</p>
      </div>
    </Card>
  );
}

/**
 * Whether sales are reaching this machine, from the captures themselves.
 *
 * Three states, and each tells the manager something different to do: nothing has ever
 * arrived (set the agent up), nothing has arrived for a day (the till or the agent has
 * stopped), or captures are flowing. Amber for the first two — the shop believes it is
 * recording sales and is not.
 */
function CaptureHealth() {
  const status = useQuery({
    queryKey: ['capture-status'],
    queryFn: () => api.get<CaptureStatus>('/system/capture'),
    refetchInterval: 60_000,
  });

  if (!status.data) return null;
  const { lastCapturedAt, capturedLast24h } = status.data;

  if (!lastCapturedAt) {
    return (
      <Notice tone="warning" title={locale.capture.captureNever}>
        {locale.capture.captureNeverHint}
      </Notice>
    );
  }

  const at = formatDate(lastCapturedAt);
  if (capturedLast24h === 0) {
    return (
      <Notice tone="warning" title={locale.capture.captureStale}>
        {locale.capture.captureStaleHint(at)}
      </Notice>
    );
  }

  return (
    <Notice tone="accent" title={locale.capture.captureLive(capturedLast24h)}>
      {locale.capture.captureLiveHint(at)}
    </Notice>
  );
}
