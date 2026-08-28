import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ArrowRight, Search, Users } from 'lucide-react';
import { formatCardNumber } from '@walaa/shared-types';
import { api } from '../lib/api';
import { locale } from '../lib/locale';
import {
  Card,
  CardHeader,
  Chip,
  EmptyState,
  Field,
  Input,
  Money,
  Notice,
  PageHeader,
  SkeletonTable,
} from '../components/ui';

interface CustomerDto {
  id: string;
  name: string;
  phone: string;
  category: 'REGULAR' | 'WHOLESALE' | 'VIP';
  barcodeToken: string;
  createdAt: string;
}

interface BalanceDto {
  periodKey: string;
  cumulativeAmount: number;
  transactionCount: number;
  nextThresholdAmount: number | null;
  amountToNextThreshold: number | null;
  nextDiscountLabel: string | null;
}

/**
 * Customer lookup.
 *
 * **Search is by phone number only.** A name is not unique — two "حسين علي" in one
 * neighbourhood is unremarkable — so a name search would return a list the manager
 * has to disambiguate, and at a counter that is worse than no search at all. The
 * phone number, and the card barcode, are the two identifiers that resolve to
 * exactly one account.
 */
export function CustomersScreen() {
  const [query, setQuery] = useState('');

  const trimmed = query.trim();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['customer-resolve', trimmed],
    queryFn: () =>
      api.get<{ customer: CustomerDto; balance: BalanceDto }>(
        `/customers/resolve?identifier=${encodeURIComponent(trimmed)}`,
      ),
    enabled: trimmed.length >= 4,
    retry: false,
  });

  return (
    <>
      <PageHeader title={locale.customers.title} subtitle={locale.customers.subtitle} />

      <Card className="mb-6">
        <div className="p-6">
          <Field label={locale.customers.searchPlaceholder} hint={locale.customers.searchHint}>
            <div className="relative">
              <Search
                size={18}
                className="pointer-events-none absolute inset-y-0 start-3 my-auto text-steel"
                aria-hidden
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="07701234567"
                className="ps-10 font-mono"
                dir="ltr"
              />
            </div>
          </Field>
        </div>
      </Card>

      {trimmed.length < 4 ? (
        <Card>
          <EmptyState
            icon={<Users size={22} aria-hidden />}
            title={locale.customers.empty}
            body={locale.customers.emptyBody}
          />
        </Card>
      ) : isLoading ? (
        <Card>
          <SkeletonTable rows={1} columns={3} />
        </Card>
      ) : isError || !data ? (
        <Card>
          <EmptyState
            icon={<Search size={22} aria-hidden />}
            title="لا نتائج مطابقة"
            body="تحقّق من رقم الهاتف، أو سجّل الزبون من محطة الولاء."
          />
        </Card>
      ) : (
        <Card>
          <CardHeader title={data.customer.name} subtitle={data.customer.phone} />
          <div className="flex items-center justify-between gap-6 p-6">
            <div>
              <p className="text-sm text-steel">{locale.customer.balanceThisPeriod}</p>
              <Money value={data.balance.cumulativeAmount} className="text-2xl" />
              <p className="mt-1 text-xs text-steel">{locale.customer.derivedNote}</p>
            </div>
            <Chip tone="accent">{locale.categories[data.customer.category]}</Chip>
            <Link
              to={`/customers/${data.customer.id}`}
              className="inline-flex min-h-control items-center gap-2 rounded-md border border-border px-4 text-base text-ink transition-colors duration-fast hover:bg-canvas"
            >
              التفاصيل
              {/* Chevron points in the reading direction — start, not end (§6.7 #4). */}
              <ArrowRight size={18} className="rtl:rotate-180" aria-hidden />
            </Link>
          </div>
        </Card>
      )}
    </>
  );
}

/** Customer detail — balance derived from transactions, never read from a cache. */
export function CustomerDetailScreen() {
  const { id } = useParams<{ id: string }>();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['customer', id],
    queryFn: () => api.get<{ customer: CustomerDto; balance: BalanceDto }>(`/customers/${id}`),
    enabled: Boolean(id),
  });

  if (isLoading) {
    return (
      <Card>
        <SkeletonTable rows={4} columns={3} />
      </Card>
    );
  }

  if (isError || !data) {
    return (
      <Card>
        <EmptyState title={locale.common.error} body={locale.common.errorBody} />
      </Card>
    );
  }

  const { customer, balance } = data;

  return (
    <>
      <Link
        to="/customers"
        className="mb-4 inline-flex items-center gap-2 text-sm text-steel hover:text-accent"
      >
        <ArrowRight size={16} className="rtl:rotate-180" aria-hidden />
        {locale.customers.title}
      </Link>

      <PageHeader
        title={customer.name}
        subtitle={customer.phone}
        action={<Chip tone="accent">{locale.categories[customer.category]}</Chip>}
      />

      {/* Asymmetric, not three equal columns (§6.5). */}
      <div className="mb-6 grid grid-cols-[1.6fr_1fr] gap-6">
        <Card className="p-6">
          <p className="text-sm text-steel">{locale.customer.balanceThisPeriod}</p>
          <Money value={balance.cumulativeAmount} className="mt-2 text-3xl" />
          <p className="mt-1 text-xs text-steel">
            {locale.customer.derivedNote} · {balance.periodKey}
          </p>

          <div className="mt-4">
            {balance.amountToNextThreshold !== null && balance.nextDiscountLabel ? (
              <Notice tone="accent">
                تبقّى <Money value={balance.amountToNextThreshold} className="text-accent" />{' '}
                {locale.customer.toNextTier} {balance.nextDiscountLabel}
              </Notice>
            ) : (
              <Notice tone="accent">{locale.customer.allTiersReached}</Notice>
            )}
          </div>
        </Card>

        <div className="space-y-6">
          <Card className="p-6">
            <p className="text-sm text-steel">{locale.overview.kpiAttributed}</p>
            <p className="amount mt-2 text-2xl text-ink">{balance.transactionCount}</p>
          </Card>
          <Card className="p-6">
            <p className="text-sm text-steel">رقم البطاقة</p>
            {/* Grouped in fours and set at a readable size: since §12.12 this is a
                16-digit number a manager reads down the phone to a customer who has
                lost their card, not an opaque token nobody was ever meant to say. */}
            <p className="selectable mt-2 font-mono text-lg tabular-nums tracking-[0.15em]">
              {formatCardNumber(customer.barcodeToken)}
            </p>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader title={locale.customer.transactions} />
        <EmptyState
          title={locale.common.comingSoon}
          body="سجل الفواتير والقسائم لهذا الزبون يُضاف مع شاشات التقارير التفصيلية."
        />
      </Card>
    </>
  );
}
