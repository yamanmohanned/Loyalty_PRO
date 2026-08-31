import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Receipt, Users } from 'lucide-react';
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
import { locale } from '../lib/locale';
import { RangePicker, type ReportRange } from '../components/RangePicker';
import {
  Card,
  CardHeader,
  Chip,
  EmptyState,
  Money,
  Notice,
  PageHeader,
  Skeleton,
  SkeletonTable,
} from '../components/ui';

interface OverviewResponse {
  overview: {
    totalCustomers: number;
    newCustomersInRange: number;
    capturedInvoices: number;
    attributedInvoices: number;
    attributionRatePct: number;
    capturedSales: number;
    discountsGranted: number;
    averageBasket: number;
    currentPeriodKey: string;
    timeseries: Array<{ date: string; amount: number; count: number; attributed: number }>;
    topCustomers: Array<{
      id: string;
      name: string;
      phone: string;
      category: string;
      cumulativeAmount: number;
      transactionCount: number;
    }>;
    recentTransactions: Array<{
      id: string;
      invoiceId: string;
      amountGross: number;
      discountValue: number;
      amountNet: number;
      customerName: string | null;
      occurredAt: string;
      captureMode: string;
    }>;
  };
}

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

      {/* Four KPIs across, never three equal columns (§6.5 anti-pattern). */}
      <div className="mb-6 grid grid-cols-4 gap-4">
        <KpiCard
          label={locale.overview.kpiCustomers}
          value={o ? String(o.totalCustomers) : null}
          hint={o ? `+${o.newCustomersInRange} ${locale.overview.kpiCustomers}` : undefined}
        />
        <KpiCard
          label={locale.overview.kpiCaptured}
          value={o ? String(o.capturedInvoices) : null}
        />
        <KpiCard
          label={locale.overview.kpiEnrolment}
          value={o ? `${o.attributionRatePct}٪` : null}
          hint={o ? `${o.attributedInvoices} ${locale.overview.kpiAttributed}` : undefined}
          tone={o && o.attributionRatePct < 20 ? 'warning' : 'accent'}
        />
        <KpiCard
          label={locale.overview.kpiDiscounts}
          value={o ? null : null}
          money={o?.discountsGranted}
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
                    <Money value={c.cumulativeAmount} />
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

function KpiCard({
  label,
  value,
  money,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string | null;
  money?: number;
  hint?: string;
  tone?: 'neutral' | 'accent' | 'warning';
}) {
  return (
    <Card className="p-5">
      <p className="text-sm text-steel">{label}</p>
      <div className="mt-2">
        {value === null && money === undefined ? (
          <Skeleton className="h-8 w-24" />
        ) : money !== undefined ? (
          <Money value={money} className="text-2xl" />
        ) : (
          <p
            className={
              tone === 'warning'
                ? 'amount text-2xl text-amber'
                : tone === 'accent'
                  ? 'amount text-2xl text-accent'
                  : 'amount text-2xl text-ink'
            }
          >
            {value}
          </p>
        )}
      </div>
      {hint ? <p className="mt-1 text-xs text-steel">{hint}</p> : null}
    </Card>
  );
}
