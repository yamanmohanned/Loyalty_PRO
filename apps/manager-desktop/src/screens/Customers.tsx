import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ArrowRight, Download, RotateCcw, Search, Users } from 'lucide-react';
import {
  formatCardNumber,
  type CustomerDetailResponse,
  type CustomerListResponse,
  type DiscountConfigResponse,
} from '@walaa/shared-types';
import { api } from '../lib/api';
import { locale, formatDate } from '../lib/locale';
import {
  Button,
  Card,
  CardHeader,
  Chip,
  cn,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Money,
  Monogram,
  Notice,
  PageHeader,
  Select,
  SkeletonTable,
  tableHeadRow,
  tableRow,
  td,
  th,
} from '../components/ui';


/**
 * The customer list.
 *
 * Until now this screen was a **lookup**: one phone number in, one customer out. That
 * answers "who is this?" and cannot answer "who are my customers?", which is the
 * question a manager opens this screen to ask. The Stitch design had the list all
 * along and so did `CustomerListQuerySchema`; only the endpoint and the table were
 * missing.
 *
 * **The filter is a phone PREFIX, and there is still no name search.** CLAUDE.md §1.4
 * bans name lookup as an *identification* method, and that ban holds where it was
 * aimed — the scan path, where a queue is waiting and only a unique identifier will
 * do. Narrowing a list you are already looking at is a different act, and it is why
 * the field says "filter" rather than "search".
 */
export function CustomersScreen() {
  const [phone, setPhone] = useState('');
  const [category, setCategory] = useState<'' | 'REGULAR' | 'WHOLESALE' | 'VIP'>('');
  const [sort, setSort] = useState<'createdAt' | 'lifetimeSpend' | 'name'>('createdAt');
  const [page, setPage] = useState(1);

  /** Whether any filter is narrowing the list — sort alone is not a filter. */
  const filtersActive = phone !== '' || category !== '';
  const clearFilters = (): void => {
    setPhone('');
    setCategory('');
    setPage(1);
  };
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const pageSize = 25;
  const trimmed = phone.trim();

  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
    sort,
    order: sort === 'name' ? 'asc' : 'desc',
    ...(trimmed ? { phone: trimmed } : {}),
    ...(category ? { category } : {}),
  });

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['customers', params.toString()],
    queryFn: () => api.get<CustomerListResponse>(`/customers?${params.toString()}`),
  });

  /** Any control that changes what is being listed sends you back to page one. */
  const reset = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    setPage(1);
  };

  async function exportCsv(): Promise<void> {
    setExporting(true);
    try {
      const response = await api.post<{ csv: string }>('/customers/export', {});
      const url = URL.createObjectURL(
        new Blob([response.csv], { type: 'text/csv;charset=utf-8' }),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'walaa-customers.csv';
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice(locale.customers.exportWarning);
    } finally {
      setExporting(false);
    }
  }

  const total = data?.total ?? 0;
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <>
      <PageHeader
        icon={<Users size={24} aria-hidden />}
        title={locale.customers.title}
        subtitle={locale.customers.subtitle}
        action={
          <Button variant="ghost" onClick={() => void exportCsv()} disabled={exporting}>
            <Download size={18} aria-hidden />
            {locale.customers.exportCsv}
          </Button>
        }
      />

      {notice ? <Notice tone="warning">{notice}</Notice> : null}

      <Card className="mb-6">
        <div className="flex flex-wrap items-end gap-4 p-6">
          <Field
            label={locale.customers.searchPlaceholder}
            hint={locale.customers.searchHint}
            className="min-w-64 flex-1"
          >
            {/*
              The magnifier goes through `Input`'s start slot rather than being
              positioned by hand.

              Hand-rolled, it was the same defect the primitive had: the glyph was
              pinned with a logical inset on a wrapper inheriting the page's RTL, and
              its space was reserved with `ps-10` on an input marked `dir="ltr"` — so
              40px was cleared on the left while the glyph sat 12px from the right,
              and a phone number long enough to fill the field ran under it. Measured
              at 12px of overlap before the change. The slot is a flex sibling now, so
              the text cannot reach it whatever the value is.
            */}
            <Input
              value={phone}
              onChange={(e) => reset(setPhone)(e.target.value)}
              placeholder="07701234567"
              className="font-mono"
              dir="ltr"
              inputMode="tel"
              adornment={<Search size={18} className="text-steel" aria-hidden />}
            />
          </Field>

          <Field label={locale.customers.colCategory} className="w-48">
            <Select
              value={category}
              onChange={(e) => reset(setCategory)(e.target.value as typeof category)}
            >
              <option value="">{locale.customers.categoryAll}</option>
              <option value="REGULAR">{locale.customers.categoryRegular}</option>
              <option value="WHOLESALE">{locale.customers.categoryWholesale}</option>
              <option value="VIP">{locale.customers.categoryVip}</option>
            </Select>
          </Field>

          <Field label={locale.customers.sortLabel} className="w-48">
            <Select value={sort} onChange={(e) => reset(setSort)(e.target.value as typeof sort)}>
              <option value="createdAt">{locale.customers.sortNewest}</option>
              <option value="lifetimeSpend">{locale.customers.sortSpend}</option>
              <option value="name">{locale.customers.sortName}</option>
            </Select>
          </Field>

          {/* Taken from the reference's «إعادة تعيين». It earns its place: three
              filters compound silently, and "why is this list empty" is answered by
              one button rather than by remembering which of them is still set. Hidden
              while nothing is set, so it never offers to undo nothing. */}
          {filtersActive ? (
            <Button variant="ghost" onClick={clearFilters} className="mb-0.5">
              <RotateCcw size={18} aria-hidden />
              {locale.customers.resetFilters}
            </Button>
          ) : null}
        </div>
      </Card>

      <Card>
        {/* Error first, then loading. `isError || !data` conflated the two: `!data` is
            also true while the very first request is in flight, so a slow response
            rendered the failure card before it had failed. */}
        {isError ? (
          <ErrorState onRetry={() => void refetch()} />
        ) : isLoading ? (
          <SkeletonTable rows={6} columns={6} />
        ) : !data ? (
          <ErrorState onRetry={() => void refetch()} />
        ) : data.customers.length === 0 ? (
          <EmptyState
            icon={<Users size={22} aria-hidden />}
            title={locale.customers.empty}
            body={locale.customers.emptyBody}
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className={tableHeadRow}>
                    <th className={th}>
                      {locale.customers.colCustomer}
                    </th>
                    <th className={th}>
                      {locale.customers.colBalance}
                    </th>
                    <th className={th}>
                      {locale.customers.colCard}
                    </th>
                    <th className={th}>
                      {locale.customers.colCategory}
                    </th>
                    <th className={th}>
                      {locale.customers.colJoined}
                    </th>
                    <th className={th} />
                  </tr>
                </thead>
                <tbody>
                  {data.customers.map((customer) => (
                    <tr key={customer.id} className={tableRow}>
                      {/* The monogram is `customers.png`'s avatar treatment with the
                          photograph refused — see `Monogram` for why. It also gives a
                          list of Arabic names a start-edge rhythm, which is what makes
                          a row findable by shape before it is readable by text. */}
                      <td className={td}>
                        <span className="flex items-center gap-3">
                          <Monogram name={customer.name} />
                          <span className="min-w-0">
                            <span className="block truncate text-base font-semibold text-ink">
                              {customer.name}
                            </span>
                            <bdi dir="ltr" className="block font-mono text-sm text-steel">
                              {customer.phone}
                            </bdi>
                          </span>
                        </span>
                      </td>
                      <td className={td}>
                        <Money value={customer.lifetimeSpend} />
                        <span className="block text-sm text-steel">
                          {customer.transactionCount} {locale.customer.invoices}
                        </span>
                      </td>
                      {/*
                        The card number was already in this response and rendered
                        nowhere — found by the §10.9 standing check, the same way
                        `capturedSales` was on the Overview. It answers the support
                        question this screen exists for ("which card does this person
                        hold"), and it makes the no-card state visible: a customer
                        between reporting one lost and being issued a replacement holds
                        none, and that is normal rather than an error (§12.25).

                        `dir="ltr"` is load-bearing. Under the RTL page the bidi
                        algorithm lays the four groups out right-to-left and the reader
                        sees the number backwards — §12.25's defect, which no test could
                        see because the string and the DOM were both correct.
                      */}
                      <td className={td}>
                        {customer.cardNumber ? (
                          <bdi dir="ltr" className="font-mono text-sm text-ink">
                            {formatCardNumber(customer.cardNumber)}
                          </bdi>
                        ) : (
                          <span className="text-sm text-steel">{locale.customers.noCard}</span>
                        )}
                      </td>
                      <td className={td}>
                        <Chip tone="accent" dot>
                          {locale.categories[customer.category as 'REGULAR']}
                        </Chip>
                      </td>
                      <td className={cn(td, 'text-sm text-steel')}>
                        {formatDate(customer.createdAt)}
                      </td>
                      <td className={cn(td, 'text-end')}>
                        <Link
                          to={`/customers/${customer.id}`}
                          className="inline-flex min-h-control items-center gap-2 rounded-md border border-border px-4 text-base text-ink transition-colors duration-fast hover:bg-canvas"
                        >
                          {locale.customer.details}
                          {/* Chevron points in the reading direction (§6.7 #4). */}
                          <ArrowRight size={18} className="rtl:rotate-180" aria-hidden />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* A page that does not say it is a page gets mistaken for the whole
                list, and a manager concludes they have 25 customers. */}
            <div className="flex items-center justify-between gap-4 border-t border-border bg-canvas px-6 py-4">
              <span className="text-sm text-steel">
                {locale.customers.pageRange(from, to, total)}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  disabled={page <= 1}
                  onClick={() => setPage((current) => current - 1)}
                >
                  {locale.customers.prev}
                </Button>
                <Button
                  variant="ghost"
                  disabled={to >= total}
                  onClick={() => setPage((current) => current + 1)}
                >
                  {locale.customers.next}
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>
    </>
  );
}

export function CustomerDetailScreen() {
  const { id } = useParams<{ id: string }>();

  /**
   * The rule ladder this customer is measured against.
   *
   * Fetched here rather than folded into the customer response because it is a
   * merchant-wide setting, not a property of the person — which is exactly what the
   * card below exists to say.
   */
  const rules = useQuery({
    queryKey: ['discount-config'],
    queryFn: () => api.get<DiscountConfigResponse>('/discount'),
  });

  /*
    The envelope is `CustomerDetailResponse`, imported — not written inline here.

    It used to be `api.get<{ customer: Customer; balance: CustomerLifetime }>`, and
    the server has returned `{ customer, lifetime }` since the §10.4 split. `api.get<T>`
    casts without checking, so `balance` was `undefined` and `balance.totalSpend` threw
    on every visit to this screen — on a healthy backend. The shared type plus the
    handler's return annotation is what turns that into a compile error.
  */
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['customer', id],
    queryFn: () => api.get<CustomerDetailResponse>(`/customers/${id}`),
    enabled: Boolean(id),
  });

  if (isError) {
    return (
      <Card>
        <ErrorState onRetry={() => void refetch()} />
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card>
        <SkeletonTable rows={4} columns={3} />
      </Card>
    );
  }

  if (!data) {
    return (
      <Card>
        <ErrorState onRetry={() => void refetch()} />
      </Card>
    );
  }

  const { customer, lifetime } = data;

  return (
    <>
      <Link
        to="/customers"
        className="mb-4 inline-flex items-center gap-2 text-sm text-steel hover:text-accent"
      >
        <ArrowRight size={16} className="rtl:rotate-180" aria-hidden />
        {locale.customers.title}
      </Link>

      {/* A person's page leads with the person: `customers.png` puts an avatar at
          the head of every customer row, and the same treatment at page scale gives
          the detail screen an identity a title alone does not. `lead` rather than
          `icon` because the monogram brings its own ground. */}
      <PageHeader
        lead={<Monogram name={customer.name} className="size-12 text-lg" />}
        title={customer.name}
        subtitle={customer.phone}
        action={
          <Chip tone="accent" dot>
            {locale.categories[customer.category]}
          </Chip>
        }
      />

      {/* Asymmetric, not three equal columns (§6.5). */}
      <div className="mb-6 grid grid-cols-[1.6fr_1fr] gap-6">
        <Card className="p-6">
          <p className="text-sm text-steel">{locale.customer.balanceThisPeriod}</p>
          <Money value={lifetime.totalSpend} className="mt-2 text-3xl" />
          <p className="mt-1 text-xs text-steel">{locale.customer.derivedNote}</p>

          {/* v3 showed the gap to this customer's next tier here. There is no such
              gap now: a bracket belongs to an invoice, not to a person, so the only
              honest thing to say is that the ladder applies per invoice (§10.4). */}
          <div className="mt-4">
            <Notice tone="accent">{locale.customer.perInvoiceNote}</Notice>
          </div>
        </Card>

        <div className="space-y-6">
          <Card className="p-6">
            <p className="text-sm text-steel">{locale.overview.kpiAttributed}</p>
            <p className="amount mt-2 text-2xl text-ink">{lifetime.transactionCount}</p>
          </Card>
          <Card className="p-6">
            <p className="text-sm text-steel">رقم البطاقة</p>
            {/* Grouped in fours and set at a readable size: since §12.12 this is a
                16-digit number a manager reads down the phone to a customer who has
                lost their card, not an opaque token nobody was ever meant to say.

                `dir="ltr"` is load-bearing, not cosmetic. Under the RTL page
                direction the bidi algorithm lays the four groups out right-to-left,
                so `0000 0122 6577 3350` renders as `3350 6577 0122 0000` — and the
                whole point of this number is that somebody reads it aloud. */}
            <p
              className="selectable mt-2 font-mono text-lg tabular-nums tracking-[0.15em]"
              dir="ltr"
            >
              {customer.cardNumber ? formatCardNumber(customer.cardNumber) : locale.common.none}
            </p>
          </Card>
        </div>
      </div>



      {/*
        The rules applied to this customer.

        The v1 design had a per-customer override card in this position, and v3
        removed `customer_override_rule` along with the coupon model it belonged to.
        This says so out loud rather than leaving the space blank: a manager who
        remembers the old screen should get the answer — one ladder, everybody —
        instead of hunting for a button that no longer exists.

        It is also the honest answer for the guardrails. §2.3's minimum, maximum and
        absolute cap only bound the discount if there is a single ladder for them to
        bound; a per-customer exception is a path around all three.
      */}
      <Card className="mb-6">
        <CardHeader
          title={locale.appliedRules.title}
          subtitle={locale.appliedRules.subtitle}
          action={
            <Link
              to="/discounts"
              className="inline-flex min-h-control items-center rounded-md border border-border px-4 text-base text-ink transition-colors duration-fast hover:bg-canvas"
            >
              {locale.appliedRules.edit}
            </Link>
          }
        />
        <div className="space-y-2 p-6">
          {rules.isLoading || !rules.data ? (
            <SkeletonTable rows={3} columns={2} />
          ) : rules.data.rules.length === 0 ? (
            <p className="text-base text-steel">{locale.reports.tierEmpty}</p>
          ) : (
            <>
              {[...rules.data.rules]
                .sort((a, b) => a.thresholdAmount - b.thresholdAmount)
                .map((rule) => (
                  // No row is highlighted, and that is the v4 change rather than an
                  // omission. Under v3 a customer sat on a tier, because the tier was
                  // reached by their accumulated spend. A bracket is now a property of
                  // an invoice, so there is no tier this person is "on" — every one of
                  // these applies to them, on whichever invoice reaches it (§1.1).
                  <div
                    key={rule.thresholdAmount}
                    className="flex items-center justify-between gap-4 rounded-md bg-canvas px-4 py-3"
                  >
                    <span className="flex items-center gap-3 text-base">
                      <Money value={rule.thresholdAmount} className="text-base" />
                      <span className="text-accent">
                        {rule.discountType === 'PERCENTAGE'
                          ? `${rule.discountRate}٪`
                          : `${rule.discountRate.toLocaleString('en-US')} د.ع`}
                      </span>
                    </span>
                    <span className="text-sm text-steel">{locale.appliedRules.perInvoice}</span>
                  </div>
                ))}

              {/* The last line of defence gets said on the screen too (§2.3). */}
              {rules.data.settings ? (
                <p className="pt-2 text-sm text-steel">
                  {locale.appliedRules.capNote(
                    `${rules.data.settings.absoluteMaxDiscountValue.toLocaleString('en-US')} د.ع`,
                  )}
                </p>
              ) : null}
            </>
          )}
        </div>
      </Card>

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
