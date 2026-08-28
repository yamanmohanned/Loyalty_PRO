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
 */
export const RoleSchema = z.enum(['OWNER', 'MANAGER', 'STATION']);
export type Role = z.infer<typeof RoleSchema>;

/** Roles permitted to use the manager desktop app. */
export const DASHBOARD_ROLES: readonly Role[] = ['OWNER', 'MANAGER'];
/** Roles permitted to operate the Loyalty Station. */
export const STATION_ROLES: readonly Role[] = ['OWNER', 'MANAGER', 'STATION'];

export const isDashboardRole = (role: Role): boolean => DASHBOARD_ROLES.includes(role);
export const isStationRole = (role: Role): boolean => STATION_ROLES.includes(role);

/* ── Customers ─────────────────────────────────────────────────────────────── */

export const CustomerCategorySchema = z.enum(['REGULAR', 'WHOLESALE', 'VIP']);
export type CustomerCategory = z.infer<typeof CustomerCategorySchema>;

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
 * How a granted discount is settled against the books (CLAUDE_v3.md §9).
 *
 * This is an OPEN question at the merchant, which is exactly why it is a selectable
 * strategy rather than a hardcoded flow:
 *
 * - `VOUCHER_AS_PAYMENT` (preferred) — the invoice stays at full value in the POS and
 *   the customer pays cash + voucher. Requires Al-Bayan to support split payment,
 *   which is not yet confirmed.
 * - `DAILY_PROMOTIONAL_EXPENSE` (fallback) — vouchers are aggregated daily and booked
 *   as a promotional expense. Less elegant, still accounting-sound.
 *
 * Neither may ever produce a cash total below what the POS recorded without a
 * matching voucher record. That is an unexplained shortfall that reads as theft in
 * the books and would wrongly implicate staff (§9, §0 rule 3).
 */
export const SettlementStrategySchema = z.enum([
  'VOUCHER_AS_PAYMENT',
  'DAILY_PROMOTIONAL_EXPENSE',
]);
export type SettlementStrategy = z.infer<typeof SettlementStrategySchema>;

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
