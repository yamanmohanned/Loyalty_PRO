import { formatIqd, SETTLEMENT_STRATEGY_LABELS } from '@loyalty-pro/shared-types';
import {
  generateVoucherCode,
  type DiscountSettlementStrategy,
  type SettlementContext,
  type SettlementNarrative,
  type SettlementOutcome,
} from './strategy';

/**
 * **Voucher as payment** — an explicit-procedure settlement (docs/legacy/CLAUDE_v3.md §9).
 *
 * The invoice stays at its full recorded value in the POS. The customer settles it
 * with cash **plus** the voucher, and the voucher is tendered like any other
 * payment instrument.
 *
 * Why this is preferred: nothing is edited, so no cashier permission is needed and
 * the anti-fraud control stays intact. The drawer reconciles exactly — cash plus
 * collected vouchers equals the POS total for the day, with no residual to explain.
 *
 * **What it presumes:** that the POS accepts a second tender on one invoice. That was
 * §9's open question about Al-Bayan; the question is withdrawn — the merchant settles
 * discounts his own way — and this strategy is kept for a store that does want the
 * procedure printed. Selecting it is a settings change and nothing else in the system
 * moves. It is no longer the default; `MERCHANT_DEFINED` is.
 */
export const voucherAsPaymentStrategy: DiscountSettlementStrategy = {
  name: 'VOUCHER_AS_PAYMENT',
  label: SETTLEMENT_STRATEGY_LABELS.VOUCHER_AS_PAYMENT,
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
