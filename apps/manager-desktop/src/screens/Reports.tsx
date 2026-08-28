import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { locale } from '../lib/locale';
import {
  Card,
  CardHeader,
  EmptyState,
  Money,
  Notice,
  PageHeader,
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
  const { data, isLoading, isError } = useQuery({
    queryKey: ['programme-report'],
    queryFn: () => api.get<ProgrammeReportResponse>('/reports/programme?range=30d'),
  });

  if (isError) {
    return (
      <>
        <PageHeader title={locale.reports.title} subtitle={locale.reports.subtitle} />
        <Card>
          <EmptyState title={locale.common.error} body={locale.common.errorBody} />
        </Card>
      </>
    );
  }

  const r = data?.report;

  return (
    <>
      <PageHeader title={locale.reports.title} subtitle={locale.reports.subtitle} />

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
