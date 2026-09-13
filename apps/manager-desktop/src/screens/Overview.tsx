import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  BadgePercent,
  BarChart3,
  LayoutDashboard,
  Link2,
  RefreshCw,
  Receipt,
  ShoppingBasket,
  UserPlus,
  Users,
  Wallet,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../lib/api';
import { SERIES, TOOLTIP_STYLE, VIZ } from '../lib/viz';

/** Thousand-separated, the way money is (§12.33: an ungrouped count beside a grouped
 *  sum is the pair that made 4200000 unreadable next to 987,654,321). */
const group = (value: number): string => new Intl.NumberFormat('en-US').format(value);
import type { OverviewResponse } from '@walaa/shared-types';
import { locale, formatDate, formatTime } from '../lib/locale';
import { RangePicker, type ReportRange } from '../components/RangePicker';
import {
  buttonClass,
  Card,
  CardHeader,
  Chip,
  cn,
  DeltaPill,
  EmptyState,
  ErrorState,
  MiniBars,
  MiniStat,
  Money,
  Monogram,
  Notice,
  PageHeader,
  SectionLabel,
  Skeleton,
  SkeletonTable,
  StatTile,
  tableHeadRow,
  tableRow,
  td,
  thSticky,
} from '../components/ui';

/**
 * Overview.
 *
 * The headline metric is the **attribution rate**, not sales. Under v1 the
 * interesting number was linked spend; under v3 the agent captures every invoice in
 * the store, so what a manager actually needs to know is what fraction reached an
 * enrolled customer. That gap is the programme's reach, and it is the number that
 * decides whether the loyalty scheme is working at all.
 *
 * ── The 2026-09-05 presentation rebuild ──────────────────────────────────────
 *
 * The screen keeps every figure it had and adds none. What changed is **weight**:
 * four real numbers were living inside 13px grey hint sentences, three real daily
 * series were computed by the API and drawn nowhere, and the page had no structure
 * above the card — six bands of content with nothing telling the reader where the
 * headline stopped and the detail began.
 *
 * Everything the reference asks for that this product cannot honestly answer is
 * refused at the point it would have been drawn, with the reason written there:
 * a points economy (this scheme has none), a prior-period delta (the endpoint takes
 * a window and no offset), a payment method and a payment status on the invoice row
 * (neither is captured), a customer-growth series (two scalars, no daily shape).
 */

/**
 * How many days each window covers, for splitting it in half.
 *
 * It restates `since()` in `reports.service.ts`, and that is the one duplication in
 * this file worth accepting: the alternative is a second request per range purely to
 * learn a boundary the client can compute, and the figure it feeds is a trend
 * indicator whose worst failure mode is being one day off at a boundary.
 */
const RANGE_DAYS: Readonly<Record<ReportRange, number>> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '365d': 365,
};

/** `YYYY-MM-DD` in the VIEWER's local day, matching how the API buckets (§13.1). */
function localDateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Percentage change, or null where there is no base to change from. */
function pctChange(before: number, after: number): number | null {
  if (before <= 0) return null;
  return ((after - before) / before) * 100;
}

export function OverviewScreen() {
  // The window was hardcoded to 30 days while the API had accepted four all along.
  const [range, setRange] = useState<ReportRange>('30d');

  const { data, isLoading, isError, isFetching, refetch, dataUpdatedAt, error: loadError } = useQuery({
    // The range is part of the key, so switching windows caches each one rather than
    // refetching the same month every time a manager glances back at it.
    queryKey: ['overview', range],
    queryFn: () => api.get<OverviewResponse>(`/reports/overview?range=${range}`),
  });

  const o = data?.overview;
  const series = useMemo(() => o?.timeseries ?? [], [o]);

  /*
    The three daily series the API has always returned and the screen never drew.

    Memoised because each one is handed to a mark that renders on every parent
    update, and a fresh array identity on each render is the cheapest way to defeat
    memoisation further down.
  */
  const salesPoints = useMemo(() => series.map((d) => d.amount), [series]);
  const capturedPoints = useMemo(() => series.map((d) => d.count), [series]);
  const attributedPoints = useMemo(() => series.map((d) => d.attributed), [series]);
  const ratePoints = useMemo(
    () => series.map((d) => (d.count > 0 ? (d.attributed / d.count) * 100 : 0)),
    [series],
  );

  /*
    ── The trend, and what it is a trend AGAINST ────────────────────────────────

    `/reports/overview` accepts a window and no offset, so the previous period is not
    in the response and no amount of arithmetic here can produce it. The reference's
    «+18٪ عن الفترة السابقة» is therefore refused: a number under that label would be
    a fabrication (§10.9), and a fabricated percentage is indistinguishable from a
    real one.

    What the response DOES contain is every day of the selected window, so the window
    can be compared against itself. The split is on the **calendar midpoint**, not on
    the midpoint of the array: the series is sparse — a day with no captures produces
    no entry — so splitting by index would compare eleven busy days against nineteen
    quiet ones and call the difference a trend.

    Below four populated days there is nothing to halve, and with an empty first half
    there is no base to divide by; both cases yield null and the pill is not drawn.
  */
  const trend = useMemo(() => {
    if (series.length < 4) return null;

    const boundary = new Date();
    boundary.setHours(0, 0, 0, 0);
    boundary.setDate(boundary.getDate() - Math.floor(RANGE_DAYS[range] / 2));
    const boundaryKey = localDateKey(boundary);

    const half = { recent: { amount: 0, count: 0, attributed: 0 }, earlier: { amount: 0, count: 0, attributed: 0 } };
    for (const day of series) {
      const bucket = day.date >= boundaryKey ? half.recent : half.earlier;
      bucket.amount += day.amount;
      bucket.count += day.count;
      bucket.attributed += day.attributed;
    }
    if (half.earlier.count === 0 || half.recent.count === 0) return null;

    return {
      sales: pctChange(half.earlier.amount, half.recent.amount),
      // A rate moves in percentage POINTS. Expressing it as a percentage change of a
      // percentage compounds a ratio and produces a number nobody can act on.
      ratePoints:
        (half.recent.attributed / half.recent.count) * 100 -
        (half.earlier.attributed / half.earlier.count) * 100,
    };
  }, [series, range]);

  /*
    The donut's two slices.

    An unattributed count of zero is DROPPED rather than drawn as a zero-width wedge:
    a shop where every invoice reached an enrolled customer is a real state, and a
    single-slice ring is the honest picture of it. The empty case (no captures at all)
    is handled separately, because a ring of nothing says nothing.
  */
  const split = useMemo(
    () =>
      o
        ? [
            {
              name: locale.overview.splitAttributed,
              value: o.attributedInvoices,
              fill: SERIES[0],
            },
            {
              name: locale.overview.splitUnattributed,
              value: o.capturedInvoices - o.attributedInvoices,
              // Not a series colour: unattributed is the ABSENCE of attribution, not
              // a second category, and painting it as one would claim a symmetry that
              // is not there. `VIZ.absence` — the card border, one step stronger.
              fill: VIZ.absence,
            },
          ].filter((slice) => slice.value > 0)
        : [],
    [o],
  );

  /*
    The header is identical in both branches, so it is built once.

    It used to be written out twice — once in the error return and once in the happy
    path — which is how a control ends up present on one and missing on the other
    after somebody edits the branch they were looking at.
  */
  const header = (
    <PageHeader
      icon={<LayoutDashboard size={24} aria-hidden />}
      title={locale.overview.title}
      subtitle={locale.overview.subtitle}
      action={
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <RangePicker value={range} onChange={setRange} />
            <button
              type="button"
              onClick={() => void refetch()}
              disabled={isFetching}
              aria-label={locale.overview.refresh}
              title={locale.overview.refresh}
              className={buttonClass('secondary', 'px-3')}
            >
              <RefreshCw
                size={18}
                aria-hidden
                className={cn(isFetching && 'motion-safe:animate-spin')}
              />
            </button>
            {/*
              The reference's primary action is «تصدير». There is no export endpoint
              behind this screen and inventing a button that cannot do anything is
              worse than not offering one — so the emerald action navigates to the
              screen that DOES produce reports. An anchor, not a button, because it
              is a navigation: `buttonClass` exists so it can look identical without
              lying to the accessibility tree about what it does.
            */}
            <Link to="/reports" className={buttonClass('primary')}>
              <BarChart3 size={18} aria-hidden />
              {locale.overview.detailedReport}
            </Link>
          </div>
          {/*
            Read off the query that is already running — `dataUpdatedAt`, not a second
            request. A dashboard with a refresh control and no timestamp cannot answer
            the question the refresh control exists for.
          */}
          {dataUpdatedAt ? (
            <p className="text-xs tabular-nums text-steel">
              {locale.overview.lastUpdated(
                formatTime(dataUpdatedAt, {
                  hour: '2-digit',
                  minute: '2-digit',
                }),
              )}
            </p>
          ) : null}
        </div>
      }
    />
  );

  /*
    One query backs this entire screen, so the error state is the screen's rather than
    each card's: nine cards each reporting the same dead connection is nine copies of
    one fact, and the retry would be the same retry nine times. Loading and empty ARE
    per-card, because those two genuinely differ between a chart and a table.
  */
  if (isError) {
    return (
      <>
        {header}
        <Card>
          <ErrorState what={locale.failure.what.overview} error={loadError} onRetry={() => void refetch()} />
        </Card>
      </>
    );
  }

  return (
    <>
      {header}

      {/*
        Four KPIs across, never three equal columns (§6.5 anti-pattern) — which is
        also why `dashboard.png`'s three-column middle band is refused below.

        **The set is the one §2.4 asks for**: the merchant should feel at a glance
        whether the store is doing well. Sales value leads, the attribution rate
        carries the programme's actual health, and the two counts sit beside them.

        The reference's per-tile trend line is drawn HERE and only here — on the two
        tiles whose figure has a real daily series behind it. Registered customers and
        discounts granted have no daily shape in the response and get no mark, which
        makes the row honest rather than uniform. A decorative line on a figure that
        has no series is the same lie as a decorative number.
      */}
      <div className="mb-6 grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatTile
          icon={Wallet}
          label={locale.overview.kpiSales}
          money={o?.capturedSales}
          loading={!o}
          stale={isFetching && Boolean(o)}
          sparkline={salesPoints}
          seriesColor={SERIES[0]}
          delta={
            trend?.sales != null ? (
              <DeltaPill value={trend.sales} text={locale.overview.deltaPct(trend.sales)} />
            ) : undefined
          }
          hint={trend?.sales != null ? locale.overview.deltaCaption : undefined}
        />
        <StatTile
          icon={Users}
          label={locale.overview.kpiCustomers}
          value={o ? group(o.totalCustomers) : null}
          loading={!o}
          stale={isFetching && Boolean(o)}
          /* No daily series and no delta: this is a running total of everyone ever
             registered, and it is the one figure on the screen the range control does
             not move. The hint says so, because a number that ignores the control
             above it looks broken until it is explained. */
          hint={o ? locale.overview.kpiCustomersNote : undefined}
        />
        <StatTile
          icon={Link2}
          label={locale.overview.kpiEnrolment}
          value={o ? `${o.attributionRatePct}٪` : null}
          loading={!o}
          stale={isFetching && Boolean(o)}
          tone={o && o.attributionRatePct < 20 ? 'warning' : 'accent'}
          /* The only tile that gets a track: this figure already IS a fraction of a
             measured whole (attributed ÷ captured), so the bar restates it rather
             than inventing a second number beside it. */
          progressPct={o?.attributionRatePct}
          sparkline={ratePoints}
          /* A rate lives on a fixed 0–100, and it is drawn as a line with no fill:
             normalised to its own extremes, 100/100/100/96 becomes a cliff, and an
             area under a series that sits near its ceiling fills the box solid. */
          sparklineDomain={[0, 100]}
          sparklineFill={false}
          seriesColor={SERIES[0]}
          delta={
            trend ? (
              <DeltaPill
                value={trend.ratePoints}
                text={locale.overview.deltaPoints(trend.ratePoints)}
                unit={locale.overview.deltaPointsUnit}
              />
            ) : undefined
          }
          hint={trend ? locale.overview.deltaCaption : undefined}
        />
        <StatTile
          icon={BadgePercent}
          label={locale.overview.kpiDiscounts}
          money={o?.discountsGranted}
          loading={!o}
          stale={isFetching && Boolean(o)}
          /* Deliberately no trend pill. A rise in discount spending is not a win and
             not a loss — it depends entirely on the sales that earned it — and a green
             upward arrow would be asserting a judgement the data does not support. */
          hint={o ? locale.overview.kpiDiscountsHint : undefined}
        />
      </div>

      <div className="mb-8">
        <Notice tone="neutral">{locale.overview.attributionHint}</Notice>
      </div>

      <SectionLabel title={locale.overview.sectionAnalytics} />

      {/*
        The dominant chart and the ratio beside it.

        Under RTL the first child lands at the RIGHT edge — where an Arabic reader
        starts — so the wide sales chart is first in the DOM and the donut second.
        1.6 / 1 rather than anything equal: the time series is the element that
        actually needs the width, and equal columns would be spending it on a ring
        that reads fine at half the size.

        Below `xl` they stack rather than compress. A 30-day series in a 380px column
        is a chart nobody can read a date off.
      */}
      <div className="mb-6 grid grid-cols-1 gap-5 xl:grid-cols-[1.6fr_1fr]">
        <Card className="flex flex-col">
          <CardHeader title={locale.overview.chartTitle} subtitle={locale.overview.chartSubtitle} />
          <div className="h-80 p-6">
            {isLoading ? (
              <Skeleton className="h-full w-full" />
            ) : series.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={series} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
                  {/*
                    `SERIES[0]` — **#0E7C60, the chart teal, not the UI accent.**
                    These sites used `#0F6E56`, which is §6.2.1's exact prohibition:
                    the brand accent measures OKLCH chroma 0.091 against a 0.10 floor
                    for a data mark, so it reads as grey rather than as an identity.
                    That section exists because somebody would eventually reconcile
                    the two hex values by picking one; this is what picking the wrong
                    one looks like in the code.
                  */}
                  <defs>
                    <linearGradient id="sales" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={SERIES[0]} stopOpacity={0.26} />
                      <stop offset="55%" stopColor={SERIES[0]} stopOpacity={0.07} />
                      <stop offset="100%" stopColor={SERIES[0]} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  {/*
                    Horizontal only, and SOLID — `viz.ts` is explicit that a dashed
                    rule reads as a projection or a threshold when it is only a
                    reading aid, and this screen was drawing `4 6` dashes in a
                    hardcoded grey that was not the grid token either. One token, one
                    treatment, every chart in the product.
                  */}
                  <CartesianGrid stroke={VIZ.grid} vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 12, fill: VIZ.axisInk }}
                    tickFormatter={(v: string) => v.slice(5)}
                    axisLine={false}
                    tickLine={false}
                    minTickGap={24}
                    // Time runs right-to-left, like the text.
                    reversed
                  />
                  <YAxis
                    tick={{ fontSize: 12, fill: VIZ.axisInk }}
                    tickFormatter={(v: number) => `${Math.round(v / 1000)}k`}
                    axisLine={false}
                    tickLine={false}
                    orientation="right"
                    width={48}
                  />
                  <Tooltip
                    cursor={{ stroke: VIZ.grid, strokeWidth: 1 }}
                    formatter={(value: number) => [`${group(value)} د.ع`, '']}
                    /* Recharts joins the series name to its value with ` : `. This
                       chart has one series and suppresses the name, which left the
                       separator stranded in front of the figure — the tooltip read
                       « : 354,650 د.ع ». An empty separator is the whole fix. */
                    separator=""
                    contentStyle={TOOLTIP_STYLE}
                  />
                  {/* Flat and 2D — no 3D, no neon (§6 anti-patterns). The dots mark
                      where a real reading exists, which on a sparse series is the
                      difference between a measurement and an interpolation. */}
                  <Area
                    type="monotone"
                    dataKey="amount"
                    stroke={SERIES[0]}
                    strokeWidth={2.5}
                    fill="url(#sales)"
                    dot={{ r: 3, fill: VIZ.surface, stroke: SERIES[0], strokeWidth: 2 }}
                    activeDot={{ r: 5, fill: SERIES[0], stroke: VIZ.surface, strokeWidth: 2 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <EmptyState
                icon={<Receipt size={22} aria-hidden />}
                title={locale.overview.chartEmpty}
              />
            )}
          </div>
        </Card>

        {/*
          The attribution split, drawn.

          `dashboard.png` puts a donut here and it is the one place on this screen
          where the reference's shape and our content genuinely coincide: the headline
          metric (§2.4) is a ratio of one whole into two parts, which is what a donut
          is for. The centre carries the rate the KPI tile states in words, and the
          legend carries both counts as **direct labels** — required, not optional:
          `viz.ts` records a contrast WARN on the categorical scale and obliges every
          chart built on it to name its series in text.

          **The reference's five-slice category donut is refused.** We do not measure
          sales by city, and inventing a breakdown to fill a ring is precisely the
          §10.9 failure. Two slices is what the data has.
        */}
        <Card className="flex flex-col">
          <CardHeader title={locale.overview.splitTitle} subtitle={locale.overview.splitSubtitle} />
          {isLoading ? (
            <div className="flex flex-1 flex-col justify-center p-6">
              <Skeleton className="mx-auto size-44 rounded-pill" />
            </div>
          ) : o && o.capturedInvoices > 0 ? (
            <div className="flex flex-1 flex-col justify-center p-6">
              <div className="relative h-44">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={split}
                      dataKey="value"
                      nameKey="name"
                      innerRadius="66%"
                      outerRadius="100%"
                      startAngle={90}
                      endAngle={-270}
                      paddingAngle={split.length > 1 ? 2 : 0}
                      stroke="none"
                      isAnimationActive={false}
                    >
                      {split.map((slice) => (
                        <Cell key={slice.name} fill={slice.fill} />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>

                {/* The centre label is absolutely positioned rather than drawn as a
                    chart label: recharts would place it in the SVG's own LTR frame,
                    and the percent sign lands on the wrong side of the digits. */}
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                  <p className="amount text-stat leading-none text-ink">
                    {o.attributionRatePct}٪
                  </p>
                  <p className="mt-1 text-xs text-steel">{locale.overview.splitCentreLabel}</p>
                </div>
              </div>

              <ul className="mt-6 space-y-1">
                {split.map((slice) => (
                  <li
                    key={slice.name}
                    className="flex items-center justify-between gap-3 rounded-md px-2 py-2"
                  >
                    <span className="flex items-center gap-2.5 text-sm text-ink">
                      <span
                        className="size-2.5 shrink-0 rounded-pill"
                        style={{ backgroundColor: slice.fill }}
                        aria-hidden
                      />
                      {slice.name}
                    </span>
                    <span className="amount text-sm text-ink">
                      {locale.overview.splitInvoices(slice.value)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            // Centred in the space the card actually has: this card is stretched to
            // its neighbour's height by the grid, so an empty state at its natural
            // height sat against the top edge with a third of the card blank below.
            <div className="flex flex-1 items-center justify-center">
              <EmptyState
                icon={<Receipt size={22} aria-hidden />}
                title={locale.overview.chartEmpty}
              />
            </div>
          )}
        </Card>
      </div>

      {/*
        The customer band.

        The brief's «نمو العملاء» — active against new customers, day by day — is
        **not built, and not approximated**. The response holds `totalCustomers` and
        `newCustomersInRange`: two scalars, no daily shape, and no definition of
        "active" anywhere in this product. A two-series chart drawn from that would be
        two invented series.

        What sits in the slot instead is the dual-series chart this screen already
        had, built from two fields that ARE per-day: invoices captured against
        invoices that reached a customer. The gap between the lines is the
        programme's reach read directly off the chart, which is the same question the
        brief's chart was asking.
      */}
      <div className="mb-8 grid grid-cols-1 gap-5 xl:grid-cols-[1fr_1.25fr]">
        <Card className="flex flex-col">
          <CardHeader
            title={locale.overview.topCustomers}
            subtitle={locale.overview.topCustomersSubtitle}
            action={
              <Link
                to="/customers"
                className="shrink-0 rounded-sm text-sm font-semibold text-accent hover:underline"
              >
                {locale.common.viewAll}
              </Link>
            }
          />
          {isLoading ? (
            <SkeletonTable rows={5} columns={2} />
          ) : o && o.topCustomers.length > 0 ? (
            /*
              The row is the reference's, mirrored honestly: the name and its figure
              at the START edge where reading begins, and the monogram with a rank
              badge at the END, exactly as `dashboard.png` lays it out once the page
              direction is applied (§6.7 #4).

              The rank number is a fact about a ranked list, not a figure invented to
              fill a circle. **The reference's podium colouring is refused** — gold,
              silver and bronze for the first three would spend amber on decoration,
              and amber is a status colour here (§6.2). All five badges are neutral.
            */
            <ul className="divide-y divide-border">
              {o.topCustomers.map((c, index) => (
                <li key={c.id}>
                  <Link
                    to={`/customers/${c.id}`}
                    className="flex items-center justify-between gap-3 px-5 py-3.5 transition-colors duration-fast hover:bg-canvas"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-base font-semibold text-ink">{c.name}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-sm text-steel">
                        <Money value={c.spendInRange} className="text-sm" />
                        <span>
                          {group(c.transactionCount)} {locale.overview.kpiCaptured}
                        </span>
                      </p>
                      {/* The brief asks for a "loyalty level" here and we have one:
                          `category` was on this payload and rendered nowhere. It is a
                          real classification the merchant sets, not a tier invented
                          to fill the row. */}
                      <Chip tone="neutral" className="mt-1.5 px-2 py-0.5 text-xs" dot>
                        {locale.categories[c.category as 'REGULAR'] ?? c.category}
                      </Chip>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Monogram name={c.name} size="sm" />
                      {/* The rank is announced to a screen reader, where the visual
                          order of a list is not conveyed. */}
                      <span
                        className="flex size-6 items-center justify-center rounded-pill bg-canvas text-xs font-bold text-steel"
                        aria-label={locale.overview.rankLabel(index + 1)}
                      >
                        {index + 1}
                      </span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              icon={<Users size={22} aria-hidden />}
              title={locale.overview.topCustomersEmpty}
            />
          )}
        </Card>

        <Card className="flex flex-col">
          <CardHeader
            title={locale.overview.captureTrend}
            subtitle={locale.overview.captureTrendSubtitle}
          />
          <div className="h-64 flex-1 px-6 pb-2 pt-4">
            {isLoading ? (
              <Skeleton className="h-full w-full" />
            ) : series.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={series} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="capturedSeries" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={SERIES[1]} stopOpacity={0.18} />
                      <stop offset="100%" stopColor={SERIES[1]} stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="attributedSeries" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={SERIES[0]} stopOpacity={0.28} />
                      <stop offset="100%" stopColor={SERIES[0]} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={VIZ.grid} vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 12, fill: VIZ.axisInk }}
                    tickFormatter={(v) => String(v).slice(5)}
                    axisLine={false}
                    tickLine={false}
                    minTickGap={24}
                    reversed
                  />
                  <YAxis
                    tick={{ fontSize: 12, fill: VIZ.axisInk }}
                    axisLine={false}
                    tickLine={false}
                    orientation="right"
                    width={40}
                    allowDecimals={false}
                  />
                  <Tooltip
                    cursor={{ stroke: VIZ.grid, strokeWidth: 1 }}
                    contentStyle={TOOLTIP_STYLE}
                  />
                  <Area
                    type="monotone"
                    dataKey="count"
                    name={locale.overview.seriesCaptured}
                    stroke={SERIES[1]}
                    strokeWidth={2}
                    fill="url(#capturedSeries)"
                    dot={false}
                  />
                  <Area
                    type="monotone"
                    dataKey="attributed"
                    name={locale.overview.seriesAttributed}
                    stroke={SERIES[0]}
                    strokeWidth={2.5}
                    fill="url(#attributedSeries)"
                    dot={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <EmptyState
                icon={<Receipt size={22} aria-hidden />}
                title={locale.overview.chartEmpty}
              />
            )}
          </div>
          {/* Direct labels, not a colour key alone: `viz.ts` records a contrast WARN on
              the categorical scale and obliges every chart on it to name its series in
              text (§2.3 — never meaning by colour alone). */}
          <ul className="flex flex-wrap gap-x-6 gap-y-2 border-t border-border px-6 py-3">
            {[
              { name: locale.overview.seriesAttributed, fill: SERIES[0] },
              { name: locale.overview.seriesCaptured, fill: SERIES[1] },
            ].map((sr) => (
              <li key={sr.name} className="flex items-center gap-2 text-sm text-ink">
                <span
                  className="size-2.5 rounded-pill"
                  style={{ backgroundColor: sr.fill }}
                  aria-hidden
                />
                {sr.name}
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {/*
        ── The activity band ────────────────────────────────────────────────────

        Four real figures that the API has always returned and that this screen was
        printing as grey hint sentences under the KPI tiles: a number set in 13px
        steel beneath a 32px number is a number nobody reads. Nothing here is new
        data — it is the §10.9 check applied to HIERARCHY rather than to presence.

        **The reference's version of this row is a points economy** — «نقاط تم
        إصدارها», «تم استبدالها», «نقاط متاحة اليوم», «معدل الاستخدام». This scheme
        has no points: it is spend → threshold → discount → voucher, and there is no
        table, field or endpoint anywhere in the product that could answer any of the
        four. They are omitted rather than approximated.
      */}
      <SectionLabel title={locale.overview.sectionActivity} />
      <div className="mb-8 grid grid-cols-2 gap-4 xl:grid-cols-4">
        <MiniStat
          icon={Receipt}
          label={locale.overview.kpiCaptured}
          value={o ? group(o.capturedInvoices) : null}
          loading={!o}
          stale={isFetching && Boolean(o)}
          visual={<MiniBars values={capturedPoints} color={SERIES[1]} />}
        />
        <MiniStat
          icon={Link2}
          /* `splitAttributed` («مرتبطة بزبون»), not `kpiAttributed` («فواتير مرتبطة
             بزبون»): the card beside it already says «فواتير ملتقطة», so the word is
             carried by the pair, and the long form wrapped to two lines here at
             1440 while every other card in the row held one. */
          label={locale.overview.splitAttributed}
          value={o ? group(o.attributedInvoices) : null}
          loading={!o}
          stale={isFetching && Boolean(o)}
          visual={<MiniBars values={attributedPoints} color={SERIES[0]} />}
        />
        <MiniStat
          icon={ShoppingBasket}
          label={locale.overview.miniBasket}
          money={o?.averageBasket}
          loading={!o}
          stale={isFetching && Boolean(o)}
          /* No mini-bars: a mean over the whole window has no per-day value in the
             response, and dividing today's amount by today's count would be a
             DIFFERENT statistic wearing this one's label. */
        />
        <MiniStat
          icon={UserPlus}
          label={locale.overview.miniNew}
          value={o ? group(o.newCustomersInRange) : null}
          caption={locale.overview.miniNewCaption}
          loading={!o}
          stale={isFetching && Boolean(o)}
        />
      </div>

      {/* No `SectionLabel` above this one: the card's own header already names the
          band, and two headings twelve pixels apart is a rule and a title saying the
          same word. The analytics and activity bands get one because nothing inside
          them does. */}
      <Card>
        <CardHeader title={locale.overview.recent} subtitle={locale.overview.recentSubtitle} />
        {isLoading ? (
          <SkeletonTable rows={6} columns={7} />
        ) : o && o.recentTransactions.length > 0 ? (
          /*
            The header sticks to the PAGE scroller — see `thSticky`. A bounded
            `overflow-auto` on the table would also do it, and was tried: it puts a
            second wheel target inside a page that already scrolls, for the sake of
            the handful of rows past the cap.

            **The reference's «طريقة الدفع» and «الحالة» columns are refused.** The
            invoice payload carries neither a payment method nor a payment status —
            the register settles the sale and this system reads the printed result, so
            there is nothing here that knows how it was paid or whether it cleared.
            `captureMode` is the closest real fact (HOW the invoice reached us) and it
            already has the last column.

            «عرض الكل» is refused for the same class of reason: there is no
            transactions list route to send it to, and a control that goes nowhere is
            worse than an absent one.
          */
          <table className="w-full text-start">
            <thead>
              <tr className={tableHeadRow}>
                <th className={thSticky}>{locale.customer.colInvoice}</th>
                <th className={thSticky}>{locale.customers.colCustomer}</th>
                <th className={thSticky}>{locale.customer.colGross}</th>
                <th className={thSticky}>{locale.customer.colDiscount}</th>
                {/* `amountNet` and `occurredAt` were both on this payload and shown
                    nowhere — the §10.9 check again. The brief asks for exactly these
                    two columns, so the shape it wants and the data we hold agree. */}
                <th className={thSticky}>{locale.overview.colNet}</th>
                <th className={thSticky}>{locale.overview.colDate}</th>
                <th className={thSticky}>{locale.customer.colCapture}</th>
              </tr>
            </thead>
            <tbody>
              {o.recentTransactions.map((t) => (
                <tr key={t.id} className={cn(tableRow, 'text-base')}>
                  {/* Latin, and isolated: an invoice number beside Arabic reverses
                      under the bidi algorithm otherwise (§12.25). */}
                  <td className={td}>
                    <bdi dir="ltr" className="font-mono text-sm selectable">
                      {t.invoiceId}
                    </bdi>
                  </td>
                  <td className={td}>
                    {t.customerName ? (
                      <span className="flex items-center gap-2.5">
                        <Monogram name={t.customerName} size="sm" />
                        <span className="font-medium text-ink">{t.customerName}</span>
                      </span>
                    ) : (
                      <Chip tone="neutral" dot>
                        {locale.overview.unattributed}
                      </Chip>
                    )}
                  </td>
                  <td className={td}>
                    <Money value={t.amountGross} />
                  </td>
                  <td className={td}>
                    {t.discountValue > 0 ? (
                      <Chip tone="success" dot>
                        <Money value={t.discountValue} className="text-success" />
                      </Chip>
                    ) : (
                      <span className="text-steel">—</span>
                    )}
                  </td>
                  <td className={td}>
                    <Money value={t.amountNet} />
                  </td>
                  <td className={cn(td, 'text-sm tabular-nums text-steel')}>
                    {formatDate(t.occurredAt)}
                  </td>
                  <td className={cn(td, 'text-sm')}>
                    <Chip tone="neutral">
                      {locale.captureModes[t.captureMode as keyof typeof locale.captureModes] ??
                        t.captureMode}
                    </Chip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState
            icon={<Receipt size={22} aria-hidden />}
            title={locale.overview.chartEmpty}
            body={locale.overview.attributionHint}
          />
        )}
      </Card>
    </>
  );
}
