import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import { assessMargin, SAFE_PERCENTAGE_MAX, SAFE_PERCENTAGE_MIN } from '@walaa/shared-types';
import { api, ApiRequestError } from '../lib/api';
import { locale } from '../lib/locale';
import {
  AmountInput,
  Button,
  Card,
  CardHeader,
  Field,
  Input,
  Money,
  Notice,
  PageHeader,
  Select,
  SkeletonTable,
} from '../components/ui';

/**
 * The discount rules editor (CLAUDE_v3.md §2.3, PROMPT_v3 V3-3).
 *
 * This screen has one job beyond editing: **stop the manager configuring a rate
 * that loses money.** A supermarket clears 2–4% net, so a 10% instant discount on
 * a 25,000 IQD basket hands back 2,500 against roughly 750 of profit. Nobody sets
 * that out of carelessness — they set it because 10% sounds competitive and the
 * margin arithmetic is not in front of them.
 *
 * So the arithmetic is put in front of them, live, as they type. The warning uses
 * the **same `assessMargin` function the API validates with**, imported from the
 * shared package — the number shown while configuring is the number that governs
 * at the till, not a separate frontend approximation that could drift.
 */

interface DiscountRuleRow {
  id?: string;
  thresholdAmount: number;
  discountType: 'PERCENTAGE' | 'FIXED_AMOUNT';
  discountRate: number;
  maxDiscountValue: number | null;
}

interface DiscountConfig {
  settings: {
    discountType: 'PERCENTAGE' | 'FIXED_AMOUNT' | 'NONE';
    minRate: number;
    maxRate: number;
    absoluteMaxDiscountValue: number;
    periodType: 'WEEKLY' | 'MONTHLY' | 'CUSTOM';
    settlementStrategy: 'VOUCHER_AS_PAYMENT' | 'DAILY_PROMOTIONAL_EXPENSE';
  };
  rules: Array<DiscountRuleRow & { id: string; isActive: boolean; sortOrder: number }>;
  settlementStrategies: Array<{ name: string; label: string; requiresSplitPayment: boolean }>;
}

export function DiscountsScreen() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['discount-config'],
    queryFn: () => api.get<DiscountConfig>('/discount'),
  });

  const [draftSettings, setDraftSettings] = useState<DiscountConfig['settings'] | null>(null);
  const [draftRules, setDraftRules] = useState<DiscountRuleRow[] | null>(null);

  const settings = draftSettings ?? data?.settings ?? null;
  const rules = draftRules ?? data?.rules ?? null;

  /**
   * Live margin assessment for every rule, recomputed on each keystroke. Cheap —
   * it is pure arithmetic — and the whole point is that it cannot lag behind what
   * the manager is looking at.
   */
  const assessments = useMemo(() => {
    if (!settings || !rules) return [];
    return rules.map((rule) =>
      assessMargin({
        thresholdAmount: rule.thresholdAmount || 1,
        discountType: rule.discountType,
        discountRate: rule.discountRate || 0,
        absoluteMaxDiscountValue: settings.absoluteMaxDiscountValue || 1,
      }),
    );
  }, [settings, rules]);

  const dangerousCount = assessments.filter((a) => a.exceedsProfit).length;

  const saveSettings = useMutation({
    mutationFn: (next: DiscountConfig['settings']) =>
      api.put('/discount/settings', {
        discountType: next.discountType,
        minRate: next.minRate,
        maxRate: next.maxRate,
        absoluteMaxDiscountValue: next.absoluteMaxDiscountValue,
        periodType: next.periodType,
        settlementStrategy: next.settlementStrategy,
      }),
  });

  const saveRules = useMutation({
    mutationFn: (next: DiscountRuleRow[]) =>
      api.put('/discount/rules', {
        rules: next.map((r) => ({
          thresholdAmount: r.thresholdAmount,
          discountType: r.discountType,
          discountRate: r.discountRate,
          ...(r.maxDiscountValue !== null ? { maxDiscountValue: r.maxDiscountValue } : {}),
        })),
      }),
  });

  async function save() {
    if (!settings || !rules) return;
    setError(null);
    setSaved(false);

    try {
      // Settings first: the rules endpoint validates against min/max and the
      // absolute cap, so saving them in the other order would reject rules that
      // are valid under the settings the manager just chose.
      await saveSettings.mutateAsync(settings);
      await saveRules.mutateAsync(rules);
      await queryClient.invalidateQueries({ queryKey: ['discount-config'] });
      setDraftSettings(null);
      setDraftRules(null);
      setSaved(true);
    } catch (caught) {
      if (caught instanceof ApiRequestError) {
        setError(
          caught.fields?.length
            ? `${caught.message} — ${caught.fields[0]?.message ?? ''}`
            : caught.message,
        );
      } else {
        setError(locale.common.errorBody);
      }
    }
  }

  if (isLoading || !settings || !rules) {
    return (
      <>
        <PageHeader title={locale.discounts.title} subtitle={locale.discounts.subtitle} />
        <Card>
          <SkeletonTable rows={6} columns={3} />
        </Card>
      </>
    );
  }

  const updateSettings = (patch: Partial<DiscountConfig['settings']>) => {
    setDraftSettings({ ...settings, ...patch });
    setSaved(false);
  };

  const updateRule = (index: number, patch: Partial<DiscountRuleRow>) => {
    setDraftRules(rules.map((r, i) => (i === index ? { ...r, ...patch } : r)));
    setSaved(false);
  };

  const isSaving = saveSettings.isPending || saveRules.isPending;

  return (
    <>
      <PageHeader
        title={locale.discounts.title}
        subtitle={locale.discounts.subtitle}
        action={
          <Button onClick={save} disabled={isSaving}>
            {isSaving ? locale.common.saving : locale.common.save}
          </Button>
        }
      />

      {error ? (
        <div className="mb-4">
          <Notice tone="danger">{error}</Notice>
        </div>
      ) : null}
      {saved ? (
        <div className="mb-4">
          <Notice tone="accent">{locale.discounts.savedNotice}</Notice>
        </div>
      ) : null}

      {/* The headline safety signal, above everything else on the screen. */}
      {dangerousCount > 0 ? (
        <div className="mb-6">
          <Notice tone="danger" title={locale.discounts.marginTitle}>
            <span className="inline-flex items-start gap-2">
              <AlertTriangle size={18} className="mt-0.5 shrink-0" aria-hidden />
              <span>
                {dangerousCount === 1
                  ? 'أحد المستويات يمنح خصماً أعلى من الربح الصافي التقديري للفاتورة.'
                  : `${dangerousCount} مستويات تمنح خصماً أعلى من الربح الصافي التقديري للفاتورة.`}
              </span>
            </span>
          </Notice>
        </div>
      ) : null}

      <div className="space-y-6">
        <Card>
          <CardHeader title={locale.discounts.settingsTitle} />
          <div className="grid grid-cols-2 gap-5 p-6">
            <Field label={locale.discounts.discountType} hint={settings.discountType === 'NONE' ? locale.discounts.typeNoneHint : undefined}>
              <Select
                value={settings.discountType}
                onChange={(e) => updateSettings({ discountType: e.target.value as DiscountConfig['settings']['discountType'] })}
              >
                <option value="PERCENTAGE">{locale.discounts.typePercentage}</option>
                <option value="FIXED_AMOUNT">{locale.discounts.typeFixed}</option>
                <option value="NONE">{locale.discounts.typeNone}</option>
              </Select>
            </Field>

            <Field label={locale.discounts.periodType}>
              <Select
                value={settings.periodType}
                onChange={(e) => updateSettings({ periodType: e.target.value as DiscountConfig['settings']['periodType'] })}
              >
                <option value="WEEKLY">{locale.periodTypes.WEEKLY}</option>
                <option value="MONTHLY">{locale.periodTypes.MONTHLY}</option>
                <option value="CUSTOM">{locale.periodTypes.CUSTOM}</option>
              </Select>
            </Field>

            <Field label={locale.discounts.minRate} hint={locale.discounts.safeBand}>
              <Input
                type="number"
                min={0}
                max={100}
                value={settings.minRate}
                onChange={(e) => updateSettings({ minRate: Number(e.target.value) })}
                className="font-mono"
              />
            </Field>

            <Field label={locale.discounts.maxRate}>
              <Input
                type="number"
                min={0}
                max={100}
                value={settings.maxRate}
                onChange={(e) => updateSettings({ maxRate: Number(e.target.value) })}
                className="font-mono"
              />
            </Field>

            {/* The last line of defence gets a full-width row and its own explanation. */}
            <Field
              label={locale.discounts.absoluteCap}
              hint={locale.discounts.absoluteCapHint}
              className="col-span-2"
            >
              <AmountInput
                value={settings.absoluteMaxDiscountValue}
                onChange={(e) => updateSettings({ absoluteMaxDiscountValue: Number(e.target.value) })}
              />
            </Field>

            <Field
              label={locale.discounts.settlement}
              hint={locale.discounts.settlementHint}
              className="col-span-2"
            >
              <Select
                value={settings.settlementStrategy}
                onChange={(e) =>
                  updateSettings({
                    settlementStrategy: e.target.value as DiscountConfig['settings']['settlementStrategy'],
                  })
                }
              >
                {data?.settlementStrategies.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.label}
                    {s.requiresSplitPayment ? ' — يتطلب دعم الدفع المجزّأ' : ''}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader
            title={locale.discounts.rulesTitle}
            subtitle={locale.discounts.rulesSubtitle}
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  const last = rules[rules.length - 1];
                  setDraftRules([
                    ...rules,
                    {
                      thresholdAmount: (last?.thresholdAmount ?? 0) + 25_000,
                      discountType: 'PERCENTAGE',
                      discountRate: Math.min((last?.discountRate ?? 1) + 1, settings.maxRate),
                      maxDiscountValue: null,
                    },
                  ]);
                  setSaved(false);
                }}
              >
                <Plus size={18} aria-hidden />
                {locale.discounts.addRule}
              </Button>
            }
          />

          <div className="divide-y divide-border">
            {rules.map((rule, index) => {
              const assessment = assessments[index];
              return (
                <div key={rule.id ?? `new-${index}`} className="p-6">
                  <div className="grid grid-cols-[2fr_1.4fr_1.4fr_auto] items-end gap-4">
                    <Field label={locale.discounts.colThreshold}>
                      <AmountInput
                        value={rule.thresholdAmount}
                        onChange={(e) => updateRule(index, { thresholdAmount: Number(e.target.value) })}
                      />
                    </Field>

                    <Field label={locale.discounts.discountType}>
                      <Select
                        value={rule.discountType}
                        onChange={(e) =>
                          updateRule(index, {
                            discountType: e.target.value as DiscountRuleRow['discountType'],
                          })
                        }
                      >
                        <option value="PERCENTAGE">{locale.discounts.typePercentage}</option>
                        <option value="FIXED_AMOUNT">{locale.discounts.typeFixed}</option>
                      </Select>
                    </Field>

                    <Field label={locale.discounts.colRate}>
                      {rule.discountType === 'PERCENTAGE' ? (
                        <AmountInput
                          suffix="٪"
                          value={rule.discountRate}
                          onChange={(e) => updateRule(index, { discountRate: Number(e.target.value) })}
                        />
                      ) : (
                        <AmountInput
                          value={rule.discountRate}
                          onChange={(e) => updateRule(index, { discountRate: Number(e.target.value) })}
                        />
                      )}
                    </Field>

                    <Button
                      variant="ghost"
                      aria-label={locale.discounts.removeRule}
                      onClick={() => {
                        setDraftRules(rules.filter((_, i) => i !== index));
                        setSaved(false);
                      }}
                      disabled={rules.length <= 1}
                      className="text-danger hover:bg-danger-tint"
                    >
                      <Trash2 size={18} aria-hidden />
                    </Button>
                  </div>

                  {/* The live margin readout — the reason this screen exists. */}
                  {assessment ? (
                    <div className="mt-4">
                      <div className="mb-2 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-steel">
                        <span>
                          الخصم عند العتبة:{' '}
                          <Money value={assessment.discountAtThreshold} className="text-ink" />
                        </span>
                        <span>
                          الربح الصافي التقديري:{' '}
                          <Money value={assessment.estimatedNetProfit} className="text-ink" />
                        </span>
                      </div>
                      {assessment.warning ? (
                        <Notice tone={assessment.exceedsProfit ? 'danger' : 'warning'}>
                          {assessment.warning}
                        </Notice>
                      ) : (
                        <Notice tone="accent">
                          ضمن النطاق الآمن ({SAFE_PERCENTAGE_MIN}–{SAFE_PERCENTAGE_MAX}٪).
                        </Notice>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    </>
  );
}
