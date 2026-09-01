import { formatIqd, SETTLEMENT_STRATEGY_LABELS } from '@walaa/shared-types';
import {
  generateVoucherCode,
  type DiscountSettlementStrategy,
  type SettlementContext,
  type SettlementNarrative,
  type SettlementOutcome,
} from './strategy';

/**
 * **Merchant-defined settlement** — the default (CLAUDE_v3.md §9, closed).
 *
 * The merchant has his own accounting method for discounts and payment handling, and
 * ruled that the system must not prescribe one. So this strategy prints the three
 * figures a cashier needs — gross, discount, net — and says to apply the discount by
 * the store's own procedure. It is the only one of the three that assumes nothing
 * about how the discount is recorded at the register.
 *
 * **What it deliberately does not do:** the other two strategies each print a warning
 * that protects the cashier, and each of those warnings only makes sense inside the
 * mechanism it belongs to — «لا تعدّل الفاتورة» presumes the invoice is settled with a
 * second tender, «لا تستلم مبلغاً أقل» presumes it is not. Printing either here would
 * be the assumption this strategy exists to avoid. A store that wants the procedure
 * on the paper selects one of the other two; nothing else changes.
 *
 * **The §9 invariant still holds, structurally rather than textually.** The voucher is
 * written in the same database transaction as the discount (§12.9), so a reduction a
 * customer received always has a record that explains it. No wording is load-bearing
 * for that guarantee.
 */
export const merchantDefinedStrategy: DiscountSettlementStrategy = {
  name: 'MERCHANT_DEFINED',
  label: SETTLEMENT_STRATEGY_LABELS.MERCHANT_DEFINED,
  requiresSplitPayment: false,

  describe(context: SettlementContext): SettlementNarrative {
    return {
      // All three numbers, in the order a person reads them, and one instruction that
      // names no mechanism. Nothing here has to be calculated at the till.
      cashierInstruction:
        `خصم بقيمة ${formatIqd(context.discountValue)} لهذا الزبون. ` +
        `المبلغ قبل الخصم ${formatIqd(context.amountGross)}، وبعد الخصم ` +
        `${formatIqd(context.amountNet)}. طبّق الخصم وفق آلية المتجر المعتمدة، ` +
        `واحتفظ بهذه القسيمة كسند للخصم.`,
      accountingNote:
        'قيمة الخصم مسجّلة في النظام مقابل رقم الفاتورة ورمز القسيمة. طريقة قيدها في ' +
        'دفاتر المتجر يحدّدها التاجر.',
    };
  },

  settle(context: SettlementContext): SettlementOutcome {
    return {
      code: generateVoucherCode(),
      value: context.discountValue,
      strategy: 'MERCHANT_DEFINED',
      ...this.describe(context),
    };
  },
};
