import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { SETTLEMENT_STRATEGY_LABELS, type ProgrammeReportResponse } from '@walaa/shared-types';
import { locale } from '../lib/locale';
import { RangePicker, type ReportRange } from '../components/RangePicker';
import {
  BarRows,
  BarTable,
  ChartFrame,
  Funnel,
  VizDefs,
  type BarDatum,
  type FunnelStep,
} from '../components/charts';
import { colorForCaptureMode, colorForCategory, colorForTier, TIER_RAMP } from '../lib/viz';
import { Card, CardHeader, EmptyState, Money, Notice, PageHeader, Skeleton } from '../components/ui';

/**
 * Programme reporting (charts added 2026-09-02).
 *
 * The metric given the most prominence is **outstanding vouchers** — slips issued to
 * customers that never reached the till. A rising number there means either the
 * cashier is not collecting them or customers are not handing them over, and in both
 * cases the drawer will stop matching what the system believes was discounted. It is
 * the earliest warning of a reconciliation problem, which is why it gets the funnel
 * rather than a cell in a table.
 *
 * ── What each panel is, and why that form ──────────────────────────────────
 *
 * | Panel | Form | Why |
 * |---|---|---|
 * | Headline figures | stat tiles | Four single numbers. A bar chart of one number is not a chart |
 * | Voucher funnel | ordinal ramp | Issued → redeemed → outstanding is a sequence; the order is the meaning |
 * | Capture health | categorical bars | Five modes, no order between them — identity, not magnitude |
 * | Customers by category | categorical bars | Three identities |
 * | Tier ladder | ordinal ramp | Swapping two tiers would change what the chart says |
 * | Today's settlement | funnel + note | The same three stages, for one day |
 *
 * Colour is assigned from `lib/viz.ts`, which records the validator output that
 * produced it. Nothing here picks a hex.
 *
 * ── The range picker sits above everything ─────────────────────────────────
 *
 * One filter row, in the page header, scoping every panel. Per-chart filters would
 * let two panels on one screen describe different weeks, which is a way of being
 * wrong that nobody notices.
 */
export function ReportsScreen() {
  const [range, setRange] = useState<ReportRange>('30d');

  const { data, isLoading, isError, isFetching } = useQuery({
    // The range is part of the key, so each window caches rather than refetching.
    queryKey: ['programme-report', range],
    queryFn: () => api.get<ProgrammeReportResponse>(`/reports/programme?range=${range}`),
    // Holds the previous window's figures while the next arrives, so changing the
    // range dims the panels rather than collapsing them into skeletons.
    placeholderData: (previous) => previous,
  });

  const r = data?.report;
  // `isFetching` with data already present is a refetch, not a first load.
  const stale = isFetching && Boolean(data);
  const firstLoad = isLoading && !data;

  const header = (
    <PageHeader
      title={locale.reports.title}
      subtitle={locale.reports.subtitle}
      action={<RangePicker value={range} onChange={setRange} />}
    />
  );

  if (isError) {
    return (
      <>
        {header}
        <Card>
          <EmptyState title={locale.common.error} body={locale.common.errorBody} />
        </Card>
      </>
    );
  }

  return (
    <>
      {header}
      <VizDefs />

      <div className="space-y-6">
        {/* ── Headline figures ──────────────────────────────────────────── */}

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Stat
            label={locale.reports.discountsGranted}
            money={r?.discountsGranted}
            loading={firstLoad}
            stale={stale}
          />
          <Stat
            label={locale.reports.vouchersIssued}
            value={r ? new Intl.NumberFormat('en-US').format(r.vouchersIssued) : undefined}
            loading={firstLoad}
            stale={stale}
          />
          <Stat
            label={locale.reports.vouchersRedeemed}
            value={r ? new Intl.NumberFormat('en-US').format(r.vouchersRedeemed) : undefined}
            loading={firstLoad}
            stale={stale}
          />
          <Stat
            label={locale.reports.redemptionRate}
            value={r ? `${r.redemptionRatePct}٪` : undefined}
            loading={firstLoad}
            stale={stale}
          />
        </div>

        {/* ── The funnel, and the number it exists to surface ───────────── */}

        <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
          <VoucherFunnel report={r} loading={firstLoad} stale={stale} />

          <Card className="flex flex-col">
            <CardHeader
              title={locale.reports.vouchersOutstanding}
              subtitle={locale.reports.outstandingHint}
            />
            <div className="flex flex-1 flex-col justify-center p-6">
              {firstLoad || !r ? (
                <Skeleton className="h-12 w-32" />
              ) : (
                <div className={stale ? 'opacity-45 transition-opacity' : 'transition-opacity'}>
                  <p className="amount text-5xl leading-none text-ink">
                    {new Intl.NumberFormat('en-US').format(r.vouchersOutstanding)}
                  </p>
                  <div className="mt-3">
                    <Money value={r.outstandingValue} className="text-steel" />
                  </div>
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* ── Capture health ────────────────────────────────────────────── */}

        <CaptureHealth report={r} loading={firstLoad} stale={stale} />

        {/* ── Two breakdowns, side by side rather than three columns (§6.5) ─ */}

        <div className="grid gap-6 lg:grid-cols-2">
          <CategoryBreakdown report={r} loading={firstLoad} stale={stale} />
          <TierLadder report={r} loading={firstLoad} stale={stale} />
        </div>

        {/* ── Today ─────────────────────────────────────────────────────── */}

        <TodaySettlement report={r} loading={firstLoad} stale={stale} />
      </div>
    </>
  );
}

/* ── Panels ────────────────────────────────────────────────────────────────── */

type Report = ProgrammeReportResponse['report'];

interface PanelProps {
  report: Report | undefined;
  loading: boolean;
  stale: boolean;
}

const share = (part: number, whole: number): number =>
  whole > 0 ? Math.round((part / whole) * 100) : 0;

function VoucherFunnel({ report, loading, stale }: PanelProps) {
  const steps: FunnelStep[] = useMemo(() => {
    if (!report) return [];
    const issued = report.vouchersIssued;
    return [
      {
        key: 'issued',
        label: locale.reports.funnelIssued,
        value: issued,
        display: locale.reports.voucherCount(issued),
        color: TIER_RAMP[3]!,
      },
      {
        key: 'redeemed',
        label: locale.reports.funnelRedeemed,
        value: report.vouchersRedeemed,
        display: locale.reports.voucherCount(report.vouchersRedeemed),
        color: TIER_RAMP[2]!,
        note: locale.reports.funnelShare(share(report.vouchersRedeemed, issued)),
      },
      {
        key: 'outstanding',
        label: locale.reports.funnelOutstanding,
        value: report.vouchersOutstanding,
        display: locale.reports.voucherCount(report.vouchersOutstanding),
        color: TIER_RAMP[1]!,
        note: locale.reports.funnelShare(share(report.vouchersOutstanding, issued)),
      },
    ];
  }, [report]);

  return (
    <ChartFrame
      title={locale.reports.funnelTitle}
      subtitle={locale.reports.funnelSubtitle}
      empty={locale.reports.funnelEmpty}
      isLoading={loading}
      isEmpty={Boolean(report) && report!.vouchersIssued === 0}
      isStale={stale}
      table={
        <BarTable
          data={steps.map((step) => ({
            key: step.key,
            label: step.label,
            value: step.value,
            color: step.color,
            note: step.note,
          }))}
          labelHeader={locale.reports.funnelTitle}
          valueHeader={locale.reports.captureColCount}
        />
      }
    >
      <Funnel steps={steps} />
    </ChartFrame>
  );
}

function CaptureHealth({ report, loading, stale }: PanelProps) {
  const data: BarDatum[] = useMemo(() => {
    if (!report) return [];
    const total = report.captureByMode.reduce((sum, row) => sum + row.count, 0);
    return report.captureByMode.map((row) => ({
      key: row.mode,
      label: locale.captureModes[row.mode as keyof typeof locale.captureModes] ?? row.mode,
      value: row.count,
      // Keyed by the mode, so a mode going quiet never repaints the others.
      color: colorForCaptureMode(row.mode),
      display: locale.reports.invoiceCount(row.count),
      note: locale.reports.shareOfTotal(share(row.count, total)),
    }));
  }, [report]);

  return (
    <ChartFrame
      title={locale.reports.captureHealth}
      subtitle={locale.reports.captureSubtitle}
      empty={locale.reports.captureEmpty}
      isLoading={loading}
      isEmpty={Boolean(report) && data.length === 0}
      isStale={stale}
      table={
        <BarTable
          data={data}
          labelHeader={locale.reports.captureColMode}
          valueHeader={locale.reports.captureColCount}
        />
      }
      // The attribution rate belongs beside capture health rather than in the stat
      // row: capture counts are the denominator it is a fraction of, and the two are
      // read together or not at all. In the footer so it survives the table toggle.
      footer={
        report ? (
          <div className="mt-6 flex items-baseline justify-between border-t border-border pt-4">
            <span className="text-base text-steel">{locale.reports.attributionRate}</span>
            <span className="amount text-xl text-accent">{report.attributionRatePct}٪</span>
          </div>
        ) : null
      }
    >
      <BarRows data={data} />
    </ChartFrame>
  );
}

function CategoryBreakdown({ report, loading, stale }: PanelProps) {
  const data: BarDatum[] = useMemo(() => {
    if (!report) return [];
    const total = report.customersByCategory.reduce((sum, row) => sum + row.count, 0);
    return report.customersByCategory.map((row) => ({
      key: row.category,
      label: locale.categories[row.category as 'REGULAR'] ?? row.category,
      value: row.count,
      color: colorForCategory(row.category),
      // The count carries its unit and the share is set apart. Bare and adjacent,
      // `9` and `75٪` rendered as `975٪` — two numbers touching read as one, and
      // this panel is nothing but numbers (§12.27).
      display: locale.reports.tierReached(row.count),
      note: locale.reports.shareOfTotal(share(row.count, total)),
    }));
  }, [report]);

  return (
    <ChartFrame
      title={locale.reports.categoryTitle}
      subtitle={locale.reports.categorySubtitle}
      empty={locale.reports.categoryEmpty}
      isLoading={loading}
      isEmpty={Boolean(report) && data.length === 0}
      isStale={stale}
      table={
        <BarTable
          data={data}
          labelHeader={locale.reports.categoryColCategory}
          valueHeader={locale.reports.categoryColCount}
        />
      }
    >
      <BarRows data={data} />
    </ChartFrame>
  );
}

function TierLadder({ report, loading, stale }: PanelProps) {
  const data: BarDatum[] = useMemo(() => {
    if (!report) return [];
    return report.tierPerformance.map((tier, index) => ({
      key: String(tier.thresholdAmount),
      label: `${locale.reports.ofThreshold} ${new Intl.NumberFormat('en-US').format(tier.thresholdAmount)} ${locale.common.currency} · ${tier.discountLabel}`,
      value: tier.reached,
      // Ordinal: the ladder has an order, and the ramp shows it.
      color: colorForTier(index),
      display: locale.reports.tierReached(tier.reached),
    }));
  }, [report]);

  return (
    <ChartFrame
      title={locale.reports.tierTitle}
      subtitle={locale.reports.tierSubtitle}
      empty={locale.reports.tierEmpty}
      isLoading={loading}
      isEmpty={Boolean(report) && data.length === 0}
      isStale={stale}
      table={
        <BarTable
          data={data}
          labelHeader={locale.reports.tierColTier}
          valueHeader={locale.reports.tierColReached}
        />
      }
    >
      {/* Scaled against the widest bar rather than the customer count: the lowest
          tier is always the largest, and scaling to it is what makes the drop-off
          between tiers visible at all. */}
      <BarRows data={data} />
    </ChartFrame>
  );
}

function TodaySettlement({ report, loading, stale }: PanelProps) {
  const recon = report?.todayReconciliation;

  const steps: FunnelStep[] = useMemo(() => {
    if (!recon) return [];
    return [
      {
        key: 'issued',
        label: locale.reports.vouchersIssued,
        value: recon.issuedCount,
        display: locale.reports.voucherCount(recon.issuedCount),
        color: TIER_RAMP[3]!,
        note: money(recon.issuedValue),
      },
      {
        key: 'redeemed',
        label: locale.reports.vouchersRedeemed,
        value: recon.redeemedCount,
        display: locale.reports.voucherCount(recon.redeemedCount),
        color: TIER_RAMP[2]!,
        note: money(recon.redeemedValue),
      },
      {
        key: 'outstanding',
        label: locale.reports.vouchersOutstanding,
        value: recon.outstandingCount,
        display: locale.reports.voucherCount(recon.outstandingCount),
        color: TIER_RAMP[1]!,
        note: money(recon.outstandingValue),
      },
    ];
  }, [recon]);

  return (
    <ChartFrame
      title={locale.reports.reconTitle}
      subtitle={recon?.date ?? locale.reports.reconSubtitle}
      empty={locale.reports.reconEmpty}
      isLoading={loading}
      isEmpty={Boolean(recon) && recon!.issuedCount === 0}
      isStale={stale}
      table={
        <BarTable
          data={steps.map((step) => ({
            key: step.key,
            label: step.label,
            value: step.value,
            display: step.display,
            color: step.color,
            note: step.note,
          }))}
          labelHeader={locale.reports.reconTitle}
          valueHeader={locale.reports.captureColCount}
        />
      }
      // Keyed off the union, never a ternary. Adding a fourth strategy is then a
      // compile error at every place that must handle it (§12.27).
      footer={
        recon ? (
          <div className="mt-6">
            <Notice tone="neutral">
              {locale.reports.reconStrategy}:{' '}
              {SETTLEMENT_STRATEGY_LABELS[recon.settlementStrategy]}
            </Notice>
          </div>
        ) : null
      }
    >
      <Funnel steps={steps} />
    </ChartFrame>
  );
}

/* ── Bits ──────────────────────────────────────────────────────────────────── */

const money = (value: number): string =>
  `${new Intl.NumberFormat('en-US').format(value)} ${locale.common.currency}`;

function Stat({
  label,
  value,
  money: amount,
  loading,
  stale,
}: {
  label: string;
  value?: string | number;
  money?: number;
  loading: boolean;
  stale: boolean;
}) {
  return (
    <Card className="p-5">
      <p className="text-sm text-steel">{label}</p>
      <div className={`mt-2 transition-opacity duration-normal ${stale ? 'opacity-45' : ''}`}>
        {loading ? (
          <Skeleton className="h-8 w-24" />
        ) : amount !== undefined ? (
          <Money value={amount} className="text-2xl" />
        ) : (
          <p className="amount text-2xl text-ink">{value ?? '—'}</p>
        )}
      </div>
    </Card>
  );
}
