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
  VerifiedEmpty,
  VizDefs,
  type BarDatum,
  type FunnelStep,
} from '../components/charts';
import {
  colorForCaptureMode,
  colorForCategory,
  colorForTier,
  SERIES,
  TIER_RAMP,
} from '../lib/viz';
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

        {/* ── The margin guardrail, reported ────────────────────────────── */}

        <CapImpact report={r} loading={firstLoad} stale={stale} />

        {/* ── Capture health ────────────────────────────────────────────── */}

        <CaptureHealth report={r} loading={firstLoad} stale={stale} />

        {/* ── Two breakdowns, side by side rather than three columns (§6.5) ─ */}

        <div className="grid gap-6 lg:grid-cols-2">
          <CategoryBreakdown report={r} loading={firstLoad} stale={stale} />
          <BracketLadder report={r} loading={firstLoad} stale={stale} />
        </div>

        {/* ── Who the discounts are going to (v4 §10.5) ─────────────────── */}

        <DiscountByCustomer report={r} loading={firstLoad} stale={stale} />

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

/** The neutral empty: nothing has happened yet, said in two lines rather than one. */
function EmptyNote({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="rounded-md border border-border bg-canvas px-5 py-4">
      <p className="text-base text-ink">{title}</p>
      <p className="mt-1 text-sm leading-relaxed text-steel">{hint}</p>
    </div>
  );
}

/**
 * What §2.3's absolute cap actually did (§12.37).
 *
 * The cap exists to stop a tier ladder that loses money on every qualifying sale.
 * Until now it did that silently: the system computed how much it withheld and threw
 * the number away, so a merchant whose ladder was set far too high saw a working
 * discount programme and no signal at all.
 *
 * Two figures, and a sentence when they mean something. **The share is against
 * discounted sales, not all captures** — "the cap binds on most discounts" and "the
 * cap binds on 2% of footfall" are different statements, and only the first one says
 * the ladder is misconfigured.
 */
function CapImpact({ report, loading, stale }: PanelProps) {
  const capped = report?.cappedDiscountCount ?? 0;
  const discounted = report?.discountedTransactionCount ?? 0;
  const pct = share(capped, discounted);

  // Two thirds is the point where this stops being an occasional large basket and
  // starts being the configuration. Deliberately not a hair-trigger: a cap that
  // catches the odd wholesale invoice is the cap working as designed.
  const misconfigured = discounted > 0 && pct >= 67;

  const rows: BarDatum[] = report
    ? [
        {
          key: 'capped',
          label: locale.reports.capTimes,
          value: capped,
          color: SERIES[2],
          display: locale.reports.invoiceCount(capped),
          note: locale.reports.capOfDiscounted(pct),
        },
      ]
    : [];

  return (
    <ChartFrame
      title={locale.reports.capTitle}
      subtitle={locale.reports.capSubtitle}
      // Two different zeros. Zero capped OUT OF N discounted sales is a verified
      // absence — the guardrail was exercised N times and never had to bite. Zero
      // out of zero is silence: nothing has happened for it to apply to. A bare "0"
      // reads as "the feature is not working" in both cases.
      empty={
        discounted > 0 ? (
          <VerifiedEmpty
            title={locale.reports.capNeverApplied}
            detail={locale.reports.capNeverAppliedOf(discounted)}
          />
        ) : (
          <EmptyNote
            title={locale.reports.capNoDiscounts}
            hint={locale.reports.capNoDiscountsHint}
          />
        )
      }
      isLoading={loading}
      isEmpty={Boolean(report) && capped === 0}
      isStale={stale}
      table={
        <BarTable
          data={rows}
          labelHeader={locale.reports.capTitle}
          valueHeader={locale.reports.captureColCount}
        />
      }
      footer={
        report ? (
          <div className="mt-6 space-y-4 border-t border-border pt-4">
            <div className="flex items-baseline justify-between gap-4">
              <div>
                <p className="text-base text-ink">{locale.reports.capSaved}</p>
                <p className="mt-0.5 text-sm text-steel">{locale.reports.capSavedHint}</p>
              </div>
              <Money value={report.forgoneDiscountValue} className="text-xl" />
            </div>

            {/* The line that turns a statistic into an instruction. Amber, because
                it is a warning about configuration rather than a failure — and it
                carries an icon and words, never colour alone. */}
            {misconfigured ? (
              <Notice tone="warning">{locale.reports.capAdvice}</Notice>
            ) : null}
          </div>
        ) : null
      }
    >
      {/* One bar against the discounted total, so the share is read as a proportion
          rather than inferred from a bare count. */}
      <BarRows data={rows} scaleTo={Math.max(discounted, 1)} />
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

/**
 * Discount value taken per customer over the range (v4 §10.5).
 *
 * **This panel exists because v4 removed a bound nobody had designed.** Under v3 a
 * customer climbed the ladder once per period, which capped how often any one of them
 * could be discounted. v4 judges every invoice on its own, so a wholesale buyer at
 * 480,000 a day takes the ceiling every day — and every guardrail in §2.3 bounds a
 * single invoice, none of them a customer.
 *
 * It reports; it does not restrict. A frequency cap would be a discount-model decision
 * with its own guardrails, and growing one out of a reporting screen is exactly how a
 * second ladder arrives by accident (§12.27).
 *
 * One hue for every row, because this is a ranking rather than a set of categories:
 * the bars are the same thing measured, and colouring them differently would imply a
 * distinction that is not there.
 */
function DiscountByCustomer({ report, loading, stale }: PanelProps) {
  const data: BarDatum[] = useMemo(() => {
    if (!report) return [];
    return report.discountByCustomer.map((row) => ({
      key: row.id,
      label: row.name,
      value: row.discountValue,
      color: SERIES[0],
      display: money(row.discountValue),
      // The invoice count is what turns a large number into a diagnosis: 5,000 across
      // one basket is an ordinary wholesale sale, and 5,000 across twenty is a habit.
      note: locale.reports.discountedInvoices(row.discountedInvoiceCount),
    }));
  }, [report]);

  return (
    <ChartFrame
      title={locale.reports.perCustomerTitle}
      subtitle={locale.reports.perCustomerSubtitle}
      empty={locale.reports.perCustomerEmpty}
      isLoading={loading}
      isEmpty={Boolean(report) && data.length === 0}
      isStale={stale}
      table={
        <BarTable
          data={data}
          labelHeader={locale.reports.perCustomerColName}
          valueHeader={locale.reports.perCustomerColValue}
        />
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

function BracketLadder({ report, loading, stale }: PanelProps) {
  const data: BarDatum[] = useMemo(() => {
    if (!report) return [];
    // Invoices per bracket, not customers per tier (v4 §10.6). Each invoice is
    // counted once, in the highest bracket it reached — the one that actually paid.
    return report.bracketPerformance.map((bracket, index) => ({
      key: String(bracket.thresholdAmount),
      label: `${locale.reports.ofThreshold} ${new Intl.NumberFormat('en-US').format(bracket.thresholdAmount)} ${locale.common.currency} · ${bracket.discountLabel}`,
      value: bracket.invoiceCount,
      // Ordinal: the ladder has an order, and the ramp shows it.
      color: colorForTier(index),
      display: locale.reports.bracketInvoices(bracket.invoiceCount),
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
