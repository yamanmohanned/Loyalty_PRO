import { Boxes } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FeatureFlagKey } from '@walaa/shared-types';
import { api } from '../lib/api';
import { locale } from '../lib/locale';
import { Card, CardHeader, Chip, cn, ErrorState, Notice, PageHeader, SkeletonTable } from '../components/ui';

/**
 * Feature flags (CLAUDE_v3.md §8).
 *
 * One binary serves every merchant; enabling a module is a toggle here rather than
 * a separate build. Each row carries the honest cost or caveat of the module —
 * WhatsApp is billed per conversation and needs Meta-approved templates, and cloud
 * backup is the one that should never be left off.
 */


const MODULES: Array<{ key: FeatureFlagKey; label: string; hint: string; locked?: string }> = [
  { key: 'cloud_backup', label: locale.modules.cloudBackup, hint: locale.modules.cloudBackupHint },
  { key: 'customer_card_printing', label: locale.modules.cardPrinting, hint: locale.modules.cardPrintingHint },
  { key: 'voucher_reconciliation', label: locale.modules.voucherReconciliation, hint: locale.modules.voucherReconciliationHint },
  { key: 'whatsapp_integration', label: locale.modules.whatsapp, hint: locale.modules.whatsappHint },
  { key: 'sms_fallback', label: locale.modules.smsFallback, hint: locale.modules.smsFallbackHint },
  { key: 'advanced_reports', label: locale.modules.advancedReports, hint: locale.modules.advancedReportsHint },
  {
    key: 'auto_update',
    label: locale.modules.autoUpdate,
    hint: locale.modules.autoUpdateHint,
    locked: 'خارج النطاق',
  },
];

export function ModulesScreen() {
  const queryClient = useQueryClient();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['flags'],
    queryFn: () => api.get<{ flags: Record<FeatureFlagKey, boolean> }>('/flags'),
  });

  const toggle = useMutation({
    mutationFn: (params: { key: FeatureFlagKey; isEnabled: boolean }) =>
      api.put(`/flags/${params.key}`, { isEnabled: params.isEnabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['flags'] }),
  });

  return (
    <>
      <PageHeader
        icon={<Boxes size={24} aria-hidden />}
        title={locale.modules.title}
        subtitle={locale.modules.subtitle}
      />

      <Card>
        <CardHeader title={locale.modules.title} />
        {isError ? (
          <ErrorState onRetry={() => void refetch()} />
        ) : isLoading || !data ? (
          <SkeletonTable rows={6} columns={2} />
        ) : (
          <ul className="divide-y divide-border">
            {MODULES.map((module) => {
              const enabled = data.flags[module.key];
              const isLocked = Boolean(module.locked);
              return (
                <li key={module.key} className="flex items-start justify-between gap-6 p-6">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-base font-semibold text-ink">{module.label}</p>
                      {module.locked ? <Chip tone="neutral">{module.locked}</Chip> : null}
                    </div>
                    <p className="mt-1 text-sm leading-relaxed text-steel">{module.hint}</p>
                  </div>

                  <button
                    type="button"
                    role="switch"
                    aria-checked={enabled}
                    aria-label={module.label}
                    disabled={isLocked || toggle.isPending}
                    onClick={() => toggle.mutate({ key: module.key, isEnabled: !enabled })}
                    className={cn(
                      'relative h-7 w-12 shrink-0 rounded-pill transition-colors duration-base ease-native',
                      enabled ? 'bg-accent' : 'bg-border',
                      isLocked && 'cursor-not-allowed opacity-40',
                    )}
                  >
                    <span
                      className={cn(
                        'absolute top-1 h-5 w-5 rounded-pill bg-surface shadow-card transition-[inset-inline-start] duration-base ease-native',
                        enabled ? 'start-6' : 'start-1',
                      )}
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <div className="mt-6">
        <Notice tone="warning">{locale.modules.cloudBackupHint}</Notice>
      </div>
    </>
  );
}
