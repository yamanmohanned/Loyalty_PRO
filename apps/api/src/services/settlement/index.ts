import type { SettlementStrategy as SettlementStrategyName } from '@walaa/shared-types';
import { dailyPromotionalExpenseStrategy } from './daily-promotional-expense.strategy';
import type { DiscountSettlementStrategy } from './strategy';
import { voucherAsPaymentStrategy } from './voucher-as-payment.strategy';

export * from './strategy';
export { voucherAsPaymentStrategy, dailyPromotionalExpenseStrategy };

const STRATEGIES: Readonly<Record<SettlementStrategyName, DiscountSettlementStrategy>> = {
  VOUCHER_AS_PAYMENT: voucherAsPaymentStrategy,
  DAILY_PROMOTIONAL_EXPENSE: dailyPromotionalExpenseStrategy,
};

/**
 * Selects the configured strategy.
 *
 * Falls back to voucher-as-payment on an unrecognised value rather than throwing:
 * SQLite stores the setting as a plain string, and a bad one must not stop the
 * store discounting. The preferred strategy is the safe default because it never
 * asks a cashier to take short payment.
 */
export function getSettlementStrategy(name: string): DiscountSettlementStrategy {
  return STRATEGIES[name as SettlementStrategyName] ?? voucherAsPaymentStrategy;
}

export const ALL_SETTLEMENT_STRATEGIES: readonly DiscountSettlementStrategy[] = [
  voucherAsPaymentStrategy,
  dailyPromotionalExpenseStrategy,
];
