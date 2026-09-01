import { formatIqd, SETTLEMENT_STRATEGY_LABELS } from '@walaa/shared-types';
import {
  generateVoucherCode,
  type DiscountSettlementStrategy,
  type SettlementContext,
  type SettlementNarrative,
  type SettlementOutcome,
} from './strategy';

/**
 * **Daily promotional expense** — an explicit-procedure settlement (CLAUDE_v3.md §9).
 *
 * For a store whose POS cannot accept a second payment method on one invoice. The
 * invoice is still recorded and paid at full value; the discount is handed to the
 * customer separately and the collected slips are booked at end of day as a single
 * promotional expense.
 *
 * The customer does not see the reduction on the invoice itself, but it is
 * accounting-sound: the day's cash matches the day's
 * POS total exactly, and the discount appears where it honestly belongs, as
 * marketing spend rather than as missing revenue.
 *
 * **The trap this deliberately avoids:** simply telling the cashier to accept less
 * cash. That produces a drawer short by the discount with nothing in the POS to
 * explain it — which reads as theft and implicates whoever was on the till. This
 * strategy never asks a cashier to take short payment.
 */
export const dailyPromotionalExpenseStrategy: DiscountSettlementStrategy = {
  name: 'DAILY_PROMOTIONAL_EXPENSE',
  label: SETTLEMENT_STRATEGY_LABELS.DAILY_PROMOTIONAL_EXPENSE,
  requiresSplitPayment: false,

  describe(context: SettlementContext): SettlementNarrative {
    return {
      // Full cash is collected. The slip is the customer's proof and the store's
      // record; the value is returned to the customer per the merchant's chosen
      // mechanism (immediate refund from the drawer against the slip, or credit).
      cashierInstruction:
        `استلم ${formatIqd(context.amountGross)} كاملاً، ثم سلّم الزبون ` +
        `${formatIqd(context.discountValue)} مقابل هذه القسيمة واحتفظ بها في الدرج. ` +
        `لا تستلم مبلغاً أقل من المسجّل في الفاتورة.`,
      accountingNote:
        'الفاتورة مُحصّلة بالكامل نقداً. تُجمع القسائم في نهاية اليوم وتُقيَّد كمصروف ' +
        'ترويجي واحد، فلا يظهر أي عجز في الصندوق.',
    };
  },

  settle(context: SettlementContext): SettlementOutcome {
    return {
      code: generateVoucherCode(),
      value: context.discountValue,
      strategy: 'DAILY_PROMOTIONAL_EXPENSE',
      ...this.describe(context),
    };
  },
};
