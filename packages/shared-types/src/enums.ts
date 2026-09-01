import { z } from 'zod';

/**
 * Enum discipline (v3).
 *
 * **These schemas are now the only enforcement.** SQLite does not support Prisma
 * `enum`, so every one of these is a plain `String` column in the database. The
 * database will happily store `"BANANA"` in `discount_type`. Nothing stops that
 * except validating here, at the boundary, on every write.
 *
 * That makes this file load-bearing in a way it was not under PostgreSQL. Adding a
 * value means adding it here first.
 */

/* ── Roles and RBAC ────────────────────────────────────────────────────────── */

/**
 * v1's `ASSISTANT` is gone with the Expo app it belonged to. `STATION` replaces it:
 * the Loyalty Station operator (CLAUDE_v3.md §6.2), who may scan, register a
 * customer and print — and who must never see a settings screen (§6.4).
 *
 * `AGENT` is the Print Capture Agent, and it exists for one reason: its credentials
 * live in cleartext in `agent-settings.json` on the cashier PC. That is the least
 * trusted machine on the network — it is the one a shop's staff use all day, and the
 * one running three of the four capture modes inside the print path. Whatever that
 * file holds is what an attacker who reaches that machine holds, so it must be the
 * narrowest account this system has: post a capture, and nothing else. Giving the
 * agent a Station login instead would hand that file the ability to register
 * customers, redeem vouchers, search customers by name and read card numbers.
 */
export const RoleSchema = z.enum(['OWNER', 'MANAGER', 'STATION', 'AGENT']);
export type Role = z.infer<typeof RoleSchema>;

/** Roles permitted to use the manager desktop app. */
export const DASHBOARD_ROLES: readonly Role[] = ['OWNER', 'MANAGER'];
/** Roles permitted to operate the Loyalty Station. */
export const STATION_ROLES: readonly Role[] = ['OWNER', 'MANAGER', 'STATION'];
/**
 * Roles permitted to submit a captured invoice.
 *
 * The OWNER stays on the list deliberately. §12.15 accepts that a capture is lost when
 * the cashier PC's disk fills, on the grounds that the invoice number and amount reach
 * the log and the paper receipt is in the cashier's hand — which only makes the sale
 * re-enterable if somebody is allowed to re-enter it.
 */
export const INGEST_ROLES: readonly Role[] = ['OWNER', 'AGENT'];

export const isDashboardRole = (role: Role): boolean => DASHBOARD_ROLES.includes(role);
export const isStationRole = (role: Role): boolean => STATION_ROLES.includes(role);

/* ── Customers ─────────────────────────────────────────────────────────────── */

export const CustomerCategorySchema = z.enum(['REGULAR', 'WHOLESALE', 'VIP']);
export type CustomerCategory = z.infer<typeof CustomerCategorySchema>;

/* ── Cards (§12.25) ────────────────────────────────────────────────────────── */

/**
 * The life of a physical card.
 *
 * Cards exist before customers do: a batch is generated, printed by a vendor, and
 * sits in a drawer as `PRINTED` until somebody is handed one.
 *
 * ```
 *   PRINTED ──assign──► ASSIGNED ──reported lost──► LOST ──replacement──► REPLACED
 *      │                    └────────replaced (damaged)──────────────────► REPLACED
 *      └──void (misprint)─► VOID
 * ```
 *
 * `LOST` may return to `ASSIGNED` — "I found it" is a real support call, and
 * refusing it pushes staff into issuing a replacement nobody needed. It is safe
 * because the partial unique index makes the dangerous version impossible: a
 * customer already holding a live replacement cannot acquire a second live card, and
 * the attempt is refused by name rather than silently.
 *
 * `PRINTED` and `VOID` have no owner. `ASSIGNED`, `LOST` and `REPLACED` all keep
 * one, because who held a dead card is exactly what a support call asks about.
 */
export const CardStatusSchema = z.enum(['PRINTED', 'ASSIGNED', 'LOST', 'REPLACED', 'VOID']);
export type CardStatus = z.infer<typeof CardStatusSchema>;

/** Statuses a card can be scanned into a sale with. Exactly one. */
export const SCANNABLE_CARD_STATUS: CardStatus = 'ASSIGNED';

/**
 * Where a card came from, which decides which numbering scheme it carries.
 *
 * `PRE_PRINTED` cards have a serial, belong to a batch, and carry a `card.v2`
 * number. `THERMAL` cards are printed at the Station when no blank is to hand
 * (§6.3) — they have **no serial**, because there is no physical inventory to
 * track, and letting them consume serials would corrupt the count of blanks
 * remaining that the batch screen exists to answer. They carry `card.v1`.
 */
export const CardOriginSchema = z.enum(['PRE_PRINTED', 'THERMAL']);
export type CardOrigin = z.infer<typeof CardOriginSchema>;

/**
 * Where a batch is in its journey from "generated" to "cards in a drawer".
 *
 * Informational only: nothing gates issuance on it, because issuance is already
 * gated by something better — the operator has to physically scan a card that
 * exists. `RETIRED` is the wholesale remedy for a leaked export file (§12.25).
 */
export const CardBatchStatusSchema = z.enum(['GENERATED', 'EXPORTED', 'RECEIVED', 'RETIRED']);
export type CardBatchStatus = z.infer<typeof CardBatchStatusSchema>;

/* ── Discounts ─────────────────────────────────────────────────────────────── */

/**
 * `NONE` is a real, selectable configuration, not an absence: it switches instant
 * discounting off while leaving capture and reporting running. A merchant
 * evaluating the programme can watch the numbers before committing to a rate.
 */
export const DiscountTypeSchema = z.enum(['PERCENTAGE', 'FIXED_AMOUNT', 'NONE']);
export type DiscountType = z.infer<typeof DiscountTypeSchema>;

/** Types a `discount_rule` may declare. A rule is never `NONE` — it just would not exist. */
export const RuleDiscountTypeSchema = z.enum(['PERCENTAGE', 'FIXED_AMOUNT']);
export type RuleDiscountType = z.infer<typeof RuleDiscountTypeSchema>;

/* ── Periods ───────────────────────────────────────────────────────────────── */

export const PeriodTypeSchema = z.enum(['WEEKLY', 'MONTHLY', 'CUSTOM']);
export type PeriodType = z.infer<typeof PeriodTypeSchema>;

/* ── Print capture (CLAUDE_v3.md §4.2) ─────────────────────────────────────── */

/**
 * How an invoice reached the system.
 *
 * `SPOOL_WATCH` is the preferred mode and the only one that is out-of-path: it
 * observes a spool directory and cannot block printing if the agent dies (§4.6).
 * The other three sit in the print path. `MANUAL` covers an invoice keyed in by
 * hand when capture failed entirely.
 */
export const CaptureModeSchema = z.enum([
  'SPOOL_WATCH',
  'VIRTUAL_PRINTER',
  'SERIAL_BRIDGE',
  'NETWORK_PROXY',
  'MANUAL',
]);
export type CaptureMode = z.infer<typeof CaptureModeSchema>;

/** The one mode that cannot block printing. Auto-detection tries it first (§4.6 #1). */
export const PREFERRED_CAPTURE_MODE: CaptureMode = 'SPOOL_WATCH';

/**
 * Narrows a stored or received capture mode, defaulting rather than throwing.
 *
 * An unrecognised mode must not lose an invoice: the sale happened, and recording
 * it with an imprecise capture label is strictly better than discarding it because
 * an agent reported a mode this build has not heard of.
 */
export function toCaptureModeOrDefault(value: string, fallback: CaptureMode = 'MANUAL'): CaptureMode {
  const parsed = CaptureModeSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

/** Modes that sit in the print path and therefore need forward-first handling. */
export const IN_PATH_CAPTURE_MODES: readonly CaptureMode[] = [
  'VIRTUAL_PRINTER',
  'SERIAL_BRIDGE',
  'NETWORK_PROXY',
];

export const isInPathCaptureMode = (mode: CaptureMode): boolean =>
  IN_PATH_CAPTURE_MODES.includes(mode);

/** Codepages Arabic-market thermal printers actually use. Never assume UTF-8 (§4.5 #2). */
export const PrinterCodepageSchema = z.enum(['CP864', 'WINDOWS_1256', 'UTF8', 'AUTO']);
export type PrinterCodepage = z.infer<typeof PrinterCodepageSchema>;

/* ── Vouchers and settlement ───────────────────────────────────────────────── */

export const VoucherStatusSchema = z.enum(['ISSUED', 'REDEEMED', 'VOID']);
export type VoucherStatus = z.infer<typeof VoucherStatusSchema>;

/**
 * What the slip tells the cashier to do about a granted discount (CLAUDE_v3.md §9).
 *
 * §9 is **closed** by operator ruling: the merchant records discounts by his own
 * accounting method, and the system does not prescribe one. All three strategies stay
 * available and the choice is a per-store setting, because a second merchant may want
 * the slip to carry an explicit procedure.
 *
 * - `MERCHANT_DEFINED` (default) — states gross, discount and net plainly and defers
 *   the mechanism to the store. Assumes nothing about how the discount is recorded.
 * - `VOUCHER_AS_PAYMENT` — the invoice stays at full value in the POS and the customer
 *   pays cash + voucher. Presumes the POS accepts a second tender on one invoice.
 * - `DAILY_PROMOTIONAL_EXPENSE` — full cash is collected and the slips are aggregated
 *   at end of day as one promotional expense.
 *
 * The invariant behind all three is structural, not textual: a discount is never
 * granted without a voucher record written in the same transaction. An unexplained
 * shortfall in the drawer reads as theft in the books and would wrongly implicate
 * staff (§9, §0 rule 3).
 */
export const SettlementStrategySchema = z.enum([
  'MERCHANT_DEFINED',
  'VOUCHER_AS_PAYMENT',
  'DAILY_PROMOTIONAL_EXPENSE',
]);
export type SettlementStrategy = z.infer<typeof SettlementStrategySchema>;

/**
 * The Arabic name of each strategy, declared once (§12.27).
 *
 * Both sides need it — the API to label the options in the settings response, the
 * manager to name the strategy on the reconciliation panel — and a `Record` keyed by
 * the union means adding a fourth strategy is a type error everywhere it must be
 * handled, rather than a silent mislabel in whichever client spelled out a ternary.
 */
export const SETTLEMENT_STRATEGY_LABELS: Readonly<Record<SettlementStrategy, string>> = {
  MERCHANT_DEFINED: 'بيان الخصم فقط',
  VOUCHER_AS_PAYMENT: 'قسيمة كوسيلة دفع',
  DAILY_PROMOTIONAL_EXPENSE: 'مصروف ترويجي يومي',
};

/* ── Feature flags (CLAUDE_v3.md §8) ───────────────────────────────────────── */

export const FeatureFlagKeySchema = z.enum([
  'whatsapp_integration',
  'customer_card_printing',
  'cloud_backup',
  'advanced_reports',
  'voucher_reconciliation',
  'sms_fallback',
  /** Out of scope for v3 and disabled by default — see CLAUDE_v3.md §12.4. */
  'auto_update',
]);
export type FeatureFlagKey = z.infer<typeof FeatureFlagKeySchema>;

/**
 * Shipping defaults. `cloud_backup` is the one enabled by default: §7.3 makes
 * encrypted off-machine backup mandatory, and a mandatory safeguard that ships
 * switched off is not a safeguard.
 */
export const DEFAULT_FEATURE_FLAGS: Readonly<Record<FeatureFlagKey, boolean>> = {
  whatsapp_integration: false,
  customer_card_printing: true,
  cloud_backup: true,
  advanced_reports: false,
  voucher_reconciliation: true,
  sms_fallback: false,
  auto_update: false,
};

/* ── Notifications ─────────────────────────────────────────────────────────── */

export const NotificationChannelSchema = z.enum(['WHATSAPP', 'SMS']);
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;

export const NotificationStatusSchema = z.enum(['PENDING', 'SENT', 'FAILED', 'STUBBED']);
export type NotificationStatus = z.infer<typeof NotificationStatusSchema>;
