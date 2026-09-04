import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  BadgePercent,
  LayoutDashboard,
  Link2,
  Receipt,
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
import { SERIES } from '../lib/viz';

/** Thousand-separated, the way money is (§12.33: an ungrouped count beside a grouped
 *  sum is the pair that made 4200000 unreadable next to 987,654,321). */
const group = (value: number): string => new Intl.NumberFormat('en-US').format(value);
import type { OverviewResponse } from '@walaa/shared-types';
import { locale } from '../lib/locale';
import { RangePicker, type ReportRange } from '../components/RangePicker';
import {
  Card,
  CardHeader,
  Chip,
  EmptyState,
  Money,
  Monogram,
  cn,
  Notice,
  PageHeader,
  Skeleton,
  SkeletonTable,
  StatTile,
  tableHeadRow,
  tableRow,
  td,
  th,
} from '../components/ui';

/**
 * Overview.
 *
 * The headline metric is the **attribution rate**, not sales. Under v1 the
 * interesting number was linked spend; under v3 the agent captures every invoice in
 * the store, so what a manager actually needs to know is what fraction reached an
 * enrolled customer. That gap is the programme's reach, and it is the number that
 * decides whether the loyalty scheme is working at all.
 */
export function OverviewScreen() {
  // The window was hardcoded to 30 days while the API had accepted four all along.
  const [range, setRange] = useState<ReportRange>('30d');

  const { data, isLoading, isError } = useQuery({
    // The range is part of the key, so switching windows caches each one rather than
    // refetching the same month every time a manager glances back at it.
    queryKey: ['overview', range],
    queryFn: () => api.get<OverviewResponse>(`/reports/overview?range=${range}`),
  });

  if (isError) {
    return (
      <>
        <PageHeader
          icon={<LayoutDashboard size={24} aria-hidden />}
          title={locale.overview.title}
          subtitle={locale.overview.subtitle}
          action={<RangePicker value={range} onChange={setRange} />}
        />
        <Card>
          <EmptyState title={locale.common.error} body={locale.common.errorBody} />
        </Card>
      </>
    );
  }

  const o = data?.overview;

  /*
    The donut's two slices.
    
    An unattributed count of zero is DROPPED rather than drawn as a zero-width wedge:
    a shop where every invoice reached an enrolled customer is a real state, and a
    single-slice ring is the honest picture of it. The empty case (no captures at all)
    is handled separately, because a ring of nothing says nothing.
  */
  const split = o
    ? [
        {
          name: locale.overview.splitAttributed,
          value: o.attributedInvoices,
          fill: SERIES[0],
        },
        {
          name: locale.overview.splitUnattributed,
          value: o.capturedInvoices - o.attributedInvoices,
          // Not a series colour: unattributed is the ABSENCE of attribution, not a
          // second category, and painting it as one would claim a symmetry that is
          // not there. Grey at 0.14 alpha over the surface — the same value the card
          // borders use, one step stronger.
          fill: 'rgba(17,24,39,0.14)',
        },
      ].filter((slice) => slice.value > 0)
    : [];

  return (
    <>
      <PageHeader
        icon={<LayoutDashboard size={24} aria-hidden />}
        title={locale.overview.title}
        subtitle={locale.overview.subtitle}
        action={<RangePicker value={range} onChange={setRange} />}
      />

      {/*
        Four KPIs across, never three equal columns (§6.5 anti-pattern) — which is
        also why `dashboard.png`'s three-column middle band is refused below.

        **The set changed, and the reason is what §2.4 asks of this screen: the
        merchant should feel at a glance whether the store is doing well.** It led
        with a COUNT of captured invoices, which answers "is the agent running"
        rather than "how are we doing". Sales value leads now, and the invoice count
        becomes its supporting line — the same fact, at the weight it deserves.

        `capturedSales` and `averageBasket` were already computed by the API and
        rendered nowhere. That is what fills the reference's second tile row: real
        figures that existed and were not shown, rather than invented ones.
      */}
      <div className="mb-6 grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatTile
          icon={Wallet}
          label={locale.overview.kpiSales}
          money={o?.capturedSales}
          loading={!o}
          hint={o ? locale.overview.kpiSalesHint(o.capturedInvoices, o.averageBasket) : undefined}
        />
        <StatTile
          icon={Users}
          label={locale.overview.kpiCustomers}
          value={o ? group(o.totalCustomers) : null}
          loading={!o}
          hint={o ? locale.overview.kpiCustomersHint(o.newCustomersInRange) : undefined}
        />
        <StatTile
          icon={Link2}
          label={locale.overview.kpiEnrolment}
          value={o ? `${o.attributionRatePct}٪` : null}
          loading={!o}
          hint={o ? `${group(o.attributedInvoices)} ${locale.overview.kpiAttributed}` : undefined}
          tone={o && o.attributionRatePct < 20 ? 'warning' : 'accent'}
        />
        <StatTile
          icon={BadgePercent}
          label={locale.overview.kpiDiscounts}
          money={o?.discountsGranted}
          loading={!o}
          hint={o ? locale.overview.kpiDiscountsHint : undefined}
        />
      </div>

      <div className="mb-6">
        <Notice tone="neutral">{locale.overview.attributionHint}</Notice>
      </div>

      {/*
        `dashboard.png`'s middle band: a ranked list, a wide chart and a donut across
        one row. The proportions are ours — 1.05 / 2 / 1.05 — because three EQUAL
        columns are a §6.5 anti-pattern and because the chart is the element that
        actually needs the width.

        Under RTL the first child lands at the RIGHT edge, so the DOM order below is
        donut → chart → list, which renders as the reference reads (§6.7 #4).
      */}
      <div className="mb-6 grid grid-cols-[1.05fr_2fr_1.05fr] gap-5">
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
          customers by city, and inventing a breakdown to fill a ring is precisely the
          §10.9 failure. Two slices is what the data has.

          Unattributed is drawn in `border`-grey rather than in a series colour,
          because it is not a second category — it is the absence of the first.
        */}
        <Card>
          <CardHeader title={locale.overview.splitTitle} />
          {isLoading ? (
            <div className="p-6">
              <Skeleton className="mx-auto size-44 rounded-pill" />
            </div>
          ) : o && o.capturedInvoices > 0 ? (
            <div className="p-6">
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
                  <p className="amount text-2xl leading-none text-ink">
                    {o.attributionRatePct}٪
                  </p>
                  <p className="mt-1 text-xs text-steel">{locale.overview.splitCentreLabel}</p>
                </div>
              </div>

              <ul className="mt-5 space-y-2.5">
                {split.map((slice) => (
                  <li key={slice.name} className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-2 text-sm text-ink">
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
            <EmptyState
              icon={<Receipt size={22} aria-hidden />}
              title={locale.overview.chartEmpty}
            />
          )}
        </Card>

        <Card>
          <CardHeader title={locale.overview.chartTitle} />
          <div className="h-72 p-6">
            {isLoading ? (
              <Skeleton className="h-full w-full" />
            ) : o && o.timeseries.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={o.timeseries} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
                  {/*
                    `SERIES[0]` — **#0E7C60, the chart teal, not the UI accent.**
                    These three sites used `#0F6E56`, which is §6.2.1's exact
                    prohibition: the brand accent measures OKLCH chroma 0.091 against
                    a 0.10 floor for a data mark, so it reads as grey rather than as
                    an identity. That section exists because somebody would eventually
                    reconcile the two hex values by picking one; this is what picking
                    the wrong one looks like in the code.
                  */}
                  <defs>
                    <linearGradient id="sales" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={SERIES[0]} stopOpacity={0.28} />
                      <stop offset="55%" stopColor={SERIES[0]} stopOpacity={0.08} />
                      <stop offset="100%" stopColor={SERIES[0]} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  {/* Dashed, horizontal only, and faint: a gridline is a reading aid,
                      not a mark. The reference draws them this way and it is right —
                      solid rules compete with the series for attention. */}
                  <CartesianGrid
                    stroke="rgba(17,24,39,0.07)"
                    strokeDasharray="4 6"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 12, fill: '#6B7280' }}
                    tickFormatter={(v: string) => v.slice(5)}
                    axisLine={false}
                    tickLine={false}
                    reversed
                  />
                  <YAxis
                    tick={{ fontSize: 12, fill: '#6B7280' }}
                    tickFormatter={(v: number) => `${Math.round(v / 1000)}k`}
                    axisLine={false}
                    tickLine={false}
                    orientation="right"
                    width={48}
                  />
                  <Tooltip
                    formatter={(value: number) => [
                      `${new Intl.NumberFormat('en-US').format(value)} د.ع`,
                      '',
                    ]}
                    contentStyle={{
                      borderRadius: 12,
                      border: '1px solid rgba(17,24,39,0.08)',
                      fontFamily: 'IBM Plex Sans Arabic, sans-serif',
                      direction: 'rtl',
                    }}
                  />
                  {/* Flat and 2D — no 3D, no neon (§6 anti-patterns). The dots are
                      the reference's treatment and they earn it: they mark where a
                      real reading exists, which on a sparse series is the difference
                      between a measurement and an interpolation. */}
                  <Area
                    type="monotone"
                    dataKey="amount"
                    stroke={SERIES[0]}
                    strokeWidth={2.5}
                    fill="url(#sales)"
                    dot={{ r: 3, fill: '#FFFFFF', stroke: SERIES[0], strokeWidth: 2 }}
                    activeDot={{ r: 5, fill: SERIES[0], stroke: '#FFFFFF', strokeWidth: 2 }}
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

        <Card>
          <CardHeader title={locale.overview.topCustomers} />
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
                      <p className="mt-0.5 text-sm text-steel">
                        <Money value={c.spendInRange} className="text-sm" />
                      </p>
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
      </div>

      <Card>
        <CardHeader title={locale.overview.recent} />
        {isLoading ? (
          <SkeletonTable rows={6} columns={5} />
        ) : o && o.recentTransactions.length > 0 ? (
        <table className="w-full text-start">
          <thead>
            <tr className={tableHeadRow}>
              <th className={th}>{locale.customer.colInvoice}</th>
              <th className={th}>{locale.customers.colCustomer}</th>
              <th className={th}>{locale.customer.colGross}</th>
              <th className={th}>{locale.customer.colDiscount}</th>
              <th className={th}>{locale.customer.colCapture}</th>
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
                <td className={cn(td, 'text-sm text-steel')}>
                  {locale.captureModes[t.captureMode as keyof typeof locale.captureModes] ??
                    t.captureMode}
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
