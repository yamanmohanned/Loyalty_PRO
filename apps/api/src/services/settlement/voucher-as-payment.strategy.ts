import { formatIqd } from '@walaa/shared-types';
import {
  generateVoucherCode,
  type DiscountSettlementStrategy,
  type SettlementContext,
  type SettlementNarrative,
  type SettlementOutcome,
} from './strategy';

/**
 * **Voucher as payment** — the preferred settlement (CLAUDE_v3.md §9).
 *
 * The invoice stays at its full recorded value in the POS. The customer settles it
 * with cash **plus** the voucher, and the voucher is tendered like any other
 * payment instrument.
 *
 * Why this is preferred: nothing is edited, so no cashier permission is needed and
 * the anti-fraud control stays intact. The drawer reconciles exactly — cash plus
 * collected vouchers equals the POS total for the day, with no residual to explain.
 *
 * **Depends on an unconfirmed fact:** that Al-Bayan supports split or multiple
 * payment methods on one invoice. If it does not, the merchant selects the
 * promotional-expense strategy instead and nothing else in the system changes.
 */
export const voucherAsPaymentStrategy: DiscountSettlementStrategy = {
  name: 'VOUCHER_AS_PAYMENT',
  label: 'قسيمة كوسيلة دفع',
  requiresSplitPayment: true,

  describe(context: SettlementContext): SettlementNarrative {
    return {
      // The cashier keys the invoice at full value and takes this slip as part of
      // the payment. Phrased as an action, with both numbers present, so nothing
      // has to be calculated at the till.
      cashierInstruction:
        `استلم ${formatIqd(context.amountNet)} نقداً + هذه القسيمة بقيمة ` +
        `${formatIqd(context.discountValue)}. لا تعدّل الفاتورة — اتركها بقيمتها الكاملة ` +
        `${formatIqd(context.amountGross)}.`,
      accountingNote:
        'الفاتورة مسجّلة بقيمتها الكاملة في نظام نقاط البيع. القسيمة تُحتسب كوسيلة دفع، ' +
        'فيتطابق النقد المُحصّل + القسائم المُستلمة مع إجمالي المبيعات المسجّل.',
    };
  },

  settle(context: SettlementContext): SettlementOutcome {
    return {
      code: generateVoucherCode(),
      value: context.discountValue,
      strategy: 'VOUCHER_AS_PAYMENT',
      ...this.describe(context),
    };
  },
};
