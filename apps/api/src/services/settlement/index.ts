import type { SettlementStrategy as SettlementStrategyName } from '@loyalty-pro/shared-types';
import { dailyPromotionalExpenseStrategy } from './daily-promotional-expense.strategy';
import { merchantDefinedStrategy } from './merchant-defined.strategy';
import type { DiscountSettlementStrategy } from './strategy';
import { voucherAsPaymentStrategy } from './voucher-as-payment.strategy';

export * from './strategy';
export { merchantDefinedStrategy, voucherAsPaymentStrategy, dailyPromotionalExpenseStrategy };

/** The strategy a store gets when it has not chosen one (§9, §12.28). */
export const DEFAULT_SETTLEMENT_STRATEGY: SettlementStrategyName = 'MERCHANT_DEFINED';

const STRATEGIES: Readonly<Record<SettlementStrategyName, DiscountSettlementStrategy>> = {
  MERCHANT_DEFINED: merchantDefinedStrategy,
  VOUCHER_AS_PAYMENT: voucherAsPaymentStrategy,
  DAILY_PROMOTIONAL_EXPENSE: dailyPromotionalExpenseStrategy,
};

/**
 * Selects the configured strategy.
 *
 * Falls back rather than throwing: SQLite stores the setting as a plain string, and a
 * value this build does not recognise must not stop the store discounting. The fallback
 * is the merchant-defined strategy because it is the one whose printed instruction
 * presumes nothing — if the stored value is unreadable, the safest thing to print is
 * the discount itself and no procedure around it.
 */
export function getSettlementStrategy(name: string): DiscountSettlementStrategy {
  return STRATEGIES[name as SettlementStrategyName] ?? merchantDefinedStrategy;
}

/** Default first — this is the order the settings screen renders. */
export const ALL_SETTLEMENT_STRATEGIES: readonly DiscountSettlementStrategy[] = [
  merchantDefinedStrategy,
  voucherAsPaymentStrategy,
  dailyPromotionalExpenseStrategy,
];
