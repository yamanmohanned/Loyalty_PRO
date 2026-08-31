import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { locale } from '../lib/locale';
import { RangePicker, type ReportRange } from '../components/RangePicker';
import {
  Card,
  CardHeader,
  EmptyState,
  Money,
  Notice,
  PageHeader,
  SkeletonTable,
  Skeleton,
} from '../components/ui';

interface ProgrammeReportResponse {
  report: {
    discountsGranted: number;
    vouchersIssued: number;
    vouchersRedeemed: number;
    vouchersOutstanding: number;
    outstandingValue: number;
    redemptionRatePct: number;
    averageBasket: number;
    attributionRatePct: number;
    captureByMode: Array<{ mode: string; count: number }>;
    customersByCategory: Array<{ category: string; count: number }>;
    tierPerformance: Array<{ thresholdAmount: number; discountLabel: string; reached: number }>;
    todayReconciliation: {
      date: string;
      issuedCount: number;
      issuedValue: number;
      redeemedCount: number;
      redeemedValue: number;
      outstandingCount: number;
      outstandingValue: number;
      settlementStrategy: string;
    };
  };
}

/**
 * Programme reporting.
 *
 * The metric given the most prominence is **outstanding vouchers** — slips issued
 * to customers that never reached the till. A rising number there means either the
 * cashier is not collecting them or customers are not handing them over, and in
 * both cases the drawer will stop matching what the system believes was discounted.
 * It is the earliest warning of a reconciliation problem, which is why it gets a
 * panel rather than a cell in a table.
 */
export function ReportsScreen() {
  // The window was hardcoded to 30 days while the API had accepted four all along.
  const [range, setRange] = useState<ReportRange>('30d');

  const { data, isLoading, isError } = useQuery({
    // The range is part of the key, so each window caches rather than refetching.
    queryKey: ['programme-report', range],
    queryFn: () => api.get<ProgrammeReportResponse>(`/reports/programme?range=${range}`),
  });

  if (isError) {
    return (
      <>
        <PageHeader
          title={locale.reports.title}
          subtitle={locale.reports.subtitle}
          action={<RangePicker value={range} onChange={setRange} />}
        />
        <Card>
          <EmptyState title={locale.common.error} body={locale.common.errorBody} />
        </Card>
      </>
    );
  }

  const r = data?.report;

  return (
    <>
      <PageHeader
        title={locale.reports.title}
        subtitle={locale.reports.subtitle}
        action={<RangePicker value={range} onChange={setRange} />}
      />

      <div className="mb-6 grid grid-cols-4 gap-4">
        <Stat label={locale.reports.discountsGranted} money={r?.discountsGranted} loading={isLoading} />
        <Stat label={locale.reports.vouchersIssued} value={r?.vouchersIssued} loading={isLoading} />
        <Stat label={locale.reports.vouchersRedeemed} value={r?.vouchersRedeemed} loading={isLoading} />
        <Stat
          label={locale.reports.redemptionRate}
          value={r ? `${r.redemptionRatePct}٪` : undefined}
          loading={isLoading}
        />
      </div>

      <div className="mb-6 grid grid-cols-2 gap-6">
        <Card>
          <CardHeader
            title={locale.reports.vouchersOutstanding}
            subtitle={locale.reports.outstandingHint}
          />
          <div className="p-6">
            {isLoading || !r ? (
              <Skeleton className="h-10 w-32" />
            ) : (
              <>
                <p className="amount text-3xl text-ink">{r.vouchersOutstanding}</p>
                <div className="mt-2">
                  <Money value={r.outstandingValue} className="text-steel" />
                </div>
              </>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title={locale.reports.captureHealth} />
          <div className="space-y-3 p-6">
            {isLoading || !r ? (
              <Skeleton className="h-24 w-full" />
            ) : (
              <>
                {r.captureByMode.length > 0 ? (
                  r.captureByMode.map((m) => (
                    <div key={m.mode} className="flex items-center justify-between text-base">
                      <span className="text-steel">
                        {locale.captureModes[m.mode as keyof typeof locale.captureModes] ?? m.mode}
                      </span>
                      <span className="amount text-ink">{m.count}</span>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-steel">{locale.overview.chartEmpty}</p>
                )}
                <div className="border-t border-border pt-3">
                  <div className="flex items-center justify-between text-base">
                    <span className="text-steel">{locale.reports.attributionRate}</span>
                    <span className="amount text-accent">{r.attributionRatePct}٪</span>
                  </div>
                </div>
              </>
            )}
          </div>
        </Card>
      </div>

      {/* Two breakdowns, side by side rather than three equal columns (§6.5). Both
          count people, never money, so §13.5's Int32 caution does not reach them. */}
      <div className="mb-6 grid grid-cols-2 gap-4">
        <Card>
          <CardHeader title={locale.reports.categoryTitle} />
          <div className="space-y-3 p-6">
            {isLoading || !r ? (
              <SkeletonTable rows={3} columns={2} />
            ) : r.customersByCategory.length === 0 ? (
              <p className="text-base text-steel">{locale.reports.categoryEmpty}</p>
            ) : (
              (() => {
                const total = r.customersByCategory.reduce((sum, row) => sum + row.count, 0);
                return r.customersByCategory.map((row) => {
                  const share = total > 0 ? Math.round((row.count / total) * 100) : 0;
                  return (
                    <div key={row.category} className="space-y-1">
                      <div className="flex items-center justify-between text-base">
                        <span className="text-ink">
                          {locale.categories[row.category as 'REGULAR']}
                        </span>
                        {/* The count carries its unit, and the share is set apart.
                            Bare and adjacent, `9` and `75٪` rendered as `975٪` — two
                            numbers touching read as one, and this panel is nothing
                            but numbers. */}
                        <span className="flex items-baseline gap-3">
                          <span className="amount text-ink">
                            {locale.reports.tierReached(row.count)}
                          </span>
                          <span className="text-sm text-steel">{share}٪</span>
                        </span>
                      </div>
                      {/* A bar, not a pie. Flat and 2D per §6 — and a horizontal bar
                          reads at a glance in RTL without a legend to cross-check. */}
                      <div className="h-2 overflow-hidden rounded-pill bg-canvas">
                        <div className="h-full bg-accent" style={{ width: `${share}%` }} />
                      </div>
                    </div>
                  );
                });
              })()
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title={locale.reports.tierTitle} subtitle={locale.reports.tierSubtitle} />
          <div className="space-y-3 p-6">
            {isLoading || !r ? (
              <SkeletonTable rows={3} columns={2} />
            ) : r.tierPerformance.length === 0 ? (
              <p className="text-base text-steel">{locale.reports.tierEmpty}</p>
            ) : (
              (() => {
                // Scaled against the widest bar rather than the customer count: the
                // lowest tier is always the largest, and scaling to it is what makes
                // the drop-off between tiers visible at all.
                const widest = Math.max(...r.tierPerformance.map((tier) => tier.reached), 1);
                return r.tierPerformance.map((tier) => (
                  <div key={tier.thresholdAmount} className="space-y-1">
                    <div className="flex items-center justify-between text-base">
                      <span className="text-ink">
                        <span className="text-sm text-steel">{locale.reports.ofThreshold} </span>
                        <Money value={tier.thresholdAmount} className="text-base" />
                        <span className="ms-2 text-sm text-accent">{tier.discountLabel}</span>
                      </span>
                      <span className="amount text-ink">
                        {locale.reports.tierReached(tier.reached)}
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-pill bg-canvas">
                      <div
                        className="h-full bg-accent"
                        style={{ width: `${Math.round((tier.reached / widest) * 100)}%` }}
                      />
                    </div>
                  </div>
                ));
              })()
            )}
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="تسوية اليوم" subtitle={r?.todayReconciliation.date} />
        <div className="p-6">
          {isLoading || !r ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <>
              <div className="grid grid-cols-3 gap-6">
                <ReconRow
                  label={locale.reports.vouchersIssued}
                  count={r.todayReconciliation.issuedCount}
                  value={r.todayReconciliation.issuedValue}
                />
                <ReconRow
                  label={locale.reports.vouchersRedeemed}
                  count={r.todayReconciliation.redeemedCount}
                  value={r.todayReconciliation.redeemedValue}
                />
                <ReconRow
                  label={locale.reports.vouchersOutstanding}
                  count={r.todayReconciliation.outstandingCount}
                  value={r.todayReconciliation.outstandingValue}
                />
              </div>
              <div className="mt-6">
                <Notice tone="neutral">
                  آلية التسوية:{' '}
                  {r.todayReconciliation.settlementStrategy === 'VOUCHER_AS_PAYMENT'
                    ? 'قسيمة كوسيلة دفع'
                    : 'مصروف ترويجي يومي'}
                </Notice>
              </div>
            </>
          )}
        </div>
      </Card>
    </>
  );
}

function Stat({
  label,
  value,
  money,
  loading,
}: {
  label: string;
  value?: string | number;
  money?: number;
  loading: boolean;
}) {
  return (
    <Card className="p-5">
      <p className="text-sm text-steel">{label}</p>
      <div className="mt-2">
        {loading ? (
          <Skeleton className="h-8 w-24" />
        ) : money !== undefined ? (
          <Money value={money} className="text-2xl" />
        ) : (
          <p className="amount text-2xl text-ink">{value ?? '—'}</p>
        )}
      </div>
    </Card>
  );
}

function ReconRow({ label, count, value }: { label: string; count: number; value: number }) {
  return (
    <div>
      <p className="text-sm text-steel">{label}</p>
      <p className="amount mt-1 text-xl text-ink">{count}</p>
      <Money value={value} className="text-sm text-steel" />
    </div>
  );
}
