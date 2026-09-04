import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { BadgePercent, Link2, Receipt, Users, Wallet, type LucideIcon } from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../lib/api';

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
  cn,
  Notice,
  PageHeader,
  Skeleton,
  SkeletonTable,
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

  return (
    <>
      <PageHeader
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
      <div className="mb-6 grid grid-cols-4 gap-4">
        <KpiCard
          icon={Wallet}
          label={locale.overview.kpiSales}
          money={o?.capturedSales}
          loading={!o}
          hint={o ? locale.overview.kpiSalesHint(o.capturedInvoices, o.averageBasket) : undefined}
        />
        <KpiCard
          icon={Users}
          label={locale.overview.kpiCustomers}
          value={o ? group(o.totalCustomers) : null}
          loading={!o}
          hint={o ? locale.overview.kpiCustomersHint(o.newCustomersInRange) : undefined}
        />
        <KpiCard
          icon={Link2}
          label={locale.overview.kpiEnrolment}
          value={o ? `${o.attributionRatePct}٪` : null}
          loading={!o}
          hint={o ? `${group(o.attributedInvoices)} ${locale.overview.kpiAttributed}` : undefined}
          tone={o && o.attributionRatePct < 20 ? 'warning' : 'accent'}
        />
        <KpiCard
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

      <div className="mb-6 grid grid-cols-[1.7fr_1fr] gap-6">
        <Card>
          <CardHeader title={locale.overview.chartTitle} />
          <div className="h-72 p-6">
            {isLoading ? (
              <Skeleton className="h-full w-full" />
            ) : o && o.timeseries.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={o.timeseries} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
                  <defs>
                    <linearGradient id="sales" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#0F6E56" stopOpacity={0.22} />
                      <stop offset="100%" stopColor="#0F6E56" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="rgba(17,24,39,0.06)" vertical={false} />
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
                  {/* Flat, 2D, one accent — no 3D, no neon (§6 anti-patterns). */}
                  <Area
                    type="monotone"
                    dataKey="amount"
                    stroke="#0F6E56"
                    strokeWidth={2}
                    fill="url(#sales)"
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
            <ul className="divide-y divide-border">
              {o.topCustomers.map((c) => (
                <li key={c.id}>
                  <Link
                    to={`/customers/${c.id}`}
                    className="flex items-center justify-between gap-3 px-6 py-3 transition-colors duration-fast hover:bg-canvas"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-base font-medium text-ink">{c.name}</p>
                      <p className="text-xs text-steel">
                        {c.transactionCount} {locale.overview.kpiCaptured}
                      </p>
                    </div>
                    <Money value={c.spendInRange} />
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
              <tr className="border-b border-border text-sm text-steel">
                <th className="px-6 py-3 text-start font-medium">{locale.customer.colInvoice}</th>
                <th className="px-6 py-3 text-start font-medium">{locale.customers.colCustomer}</th>
                <th className="px-6 py-3 text-start font-medium">{locale.customer.colGross}</th>
                <th className="px-6 py-3 text-start font-medium">{locale.customer.colDiscount}</th>
                <th className="px-6 py-3 text-start font-medium">{locale.customer.colCapture}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {o.recentTransactions.map((t) => (
                <tr key={t.id} className="text-base">
                  <td className="px-6 py-3 font-mono text-sm selectable">{t.invoiceId}</td>
                  <td className="px-6 py-3">
                    {t.customerName ?? (
                      <Chip tone="neutral">{locale.overview.unattributed}</Chip>
                    )}
                  </td>
                  <td className="px-6 py-3">
                    <Money value={t.amountGross} />
                  </td>
                  <td className="px-6 py-3">
                    {t.discountValue > 0 ? (
                      <Chip tone="success">
                        <Money value={t.discountValue} className="text-success" />
                      </Chip>
                    ) : (
                      <span className="text-steel">—</span>
                    )}
                  </td>
                  <td className="px-6 py-3 text-sm text-steel">
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

/**
 * One headline figure.
 *
 * **Taken from `dashboard.png`:** the tinted rounded icon square beside the label,
 * and a supporting line under the value. Both are arrangement, and both earn their
 * space — the icon makes four tiles scannable without reading, and the supporting
 * line is where a second real number goes.
 *
 * **Refused: the sparkline and the "+18٪ عن الفترة السابقة" delta.** Neither exists.
 * There is no per-KPI series and no prior-period comparison in `OverviewReport`, and
 * a delta is exactly the kind of figure that would have to be invented to fill a
 * shape — §2.2's "anything implying a feature we do not have", with the added
 * hazard that a fabricated percentage is indistinguishable from a real one.
 *
 * The icon is decorative and `aria-hidden`: the label carries the meaning, so nothing
 * here is signalled by the icon alone.
 */
function KpiCard({
  icon: Icon,
  label,
  value,
  money,
  hint,
  loading = false,
  tone = 'neutral',
}: {
  icon: LucideIcon;
  label: string;
  value?: string | null;
  money?: number;
  hint?: string;
  loading?: boolean;
  tone?: 'neutral' | 'accent' | 'warning';
}) {
  return (
    <Card className="p-5">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'flex size-11 shrink-0 items-center justify-center rounded-lg',
            tone === 'warning' ? 'bg-amber-tint text-amber' : 'bg-accent-tint text-accent',
          )}
        >
          <Icon size={22} aria-hidden />
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-sm text-steel">{label}</p>
          <div className="mt-1.5">
            {loading ? (
              <Skeleton className="h-8 w-24" />
            ) : money !== undefined ? (
              <Money value={money} className="text-2xl" />
            ) : (
              <p
                className={cn(
                  'amount text-2xl',
                  tone === 'warning' ? 'text-amber' : tone === 'accent' ? 'text-accent' : 'text-ink',
                )}
              >
                {value}
              </p>
            )}
          </div>
          {hint ? <p className="mt-1 text-xs leading-relaxed text-steel">{hint}</p> : null}
        </div>
      </div>
    </Card>
  );
}
