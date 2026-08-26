import { z } from 'zod';

/**
 * Enum discipline.
 *
 * The Normalized Invoice Schema (CLAUDE.md §2.3) is specified on the wire in
 * lowercase — `"scan | api | db_agent"`, `"auto | manual"` — while the data model
 * (§4.1) specifies uppercase — `SCAN | API | DB_AGENT`, `AUTO | MANUAL`.
 *
 * Both are correct in their own layer, so this module owns the boundary: wire enums,
 * DB enums, and total mappings between them. Nothing else in the codebase may
 * hand-roll that conversion — that is exactly how contracts drift.
 */

/* ── Invoice source ────────────────────────────────────────────────────────── */

/** Wire form, as it appears in the Normalized Invoice Schema. */
export const InvoiceSourceWireSchema = z.enum(['scan', 'api', 'db_agent']);
export type InvoiceSourceWire = z.infer<typeof InvoiceSourceWireSchema>;

/** Persisted form, as stored in `transaction.source`. */
export const InvoiceSourceSchema = z.enum(['SCAN', 'API', 'DB_AGENT']);
export type InvoiceSource = z.infer<typeof InvoiceSourceSchema>;

const SOURCE_WIRE_TO_DB: Readonly<Record<InvoiceSourceWire, InvoiceSource>> = {
  scan: 'SCAN',
  api: 'API',
  db_agent: 'DB_AGENT',
};

const SOURCE_DB_TO_WIRE: Readonly<Record<InvoiceSource, InvoiceSourceWire>> = {
  SCAN: 'scan',
  API: 'api',
  DB_AGENT: 'db_agent',
};

export const toInvoiceSource = (wire: InvoiceSourceWire): InvoiceSource => SOURCE_WIRE_TO_DB[wire];
export const toInvoiceSourceWire = (db: InvoiceSource): InvoiceSourceWire => SOURCE_DB_TO_WIRE[db];

/* ── Amount capture ────────────────────────────────────────────────────────── */

/**
 * How the amount reached the system. `manual` entries are audited (CLAUDE.md §7.10)
 * because a hand-typed amount is the one place a staff member can inflate a balance.
 */
export const AmountCaptureWireSchema = z.enum(['auto', 'manual']);
export type AmountCaptureWire = z.infer<typeof AmountCaptureWireSchema>;

export const AmountCaptureSchema = z.enum(['AUTO', 'MANUAL']);
export type AmountCapture = z.infer<typeof AmountCaptureSchema>;

const CAPTURE_WIRE_TO_DB: Readonly<Record<AmountCaptureWire, AmountCapture>> = {
  auto: 'AUTO',
  manual: 'MANUAL',
};

const CAPTURE_DB_TO_WIRE: Readonly<Record<AmountCapture, AmountCaptureWire>> = {
  AUTO: 'auto',
  MANUAL: 'manual',
};

export const toAmountCapture = (wire: AmountCaptureWire): AmountCapture => CAPTURE_WIRE_TO_DB[wire];
export const toAmountCaptureWire = (db: AmountCapture): AmountCaptureWire => CAPTURE_DB_TO_WIRE[db];

/* ── Roles and RBAC (CLAUDE.md §7.2) ───────────────────────────────────────── */

export const RoleSchema = z.enum(['OWNER', 'MANAGER', 'ASSISTANT']);
export type Role = z.infer<typeof RoleSchema>;

/** Roles permitted to use the manager dashboard. */
export const DASHBOARD_ROLES: readonly Role[] = ['OWNER', 'MANAGER'];
/** Roles permitted to execute the core loop on the assistant app. */
export const CORE_LOOP_ROLES: readonly Role[] = ['OWNER', 'MANAGER', 'ASSISTANT'];

/** Assistants execute the loop and look customers up — nothing else (CLAUDE.md §7.2). */
export const isDashboardRole = (role: Role): boolean => DASHBOARD_ROLES.includes(role);

/* ── Customers ─────────────────────────────────────────────────────────────── */

export const CustomerCategorySchema = z.enum(['REGULAR', 'WHOLESALE', 'VIP']);
export type CustomerCategory = z.infer<typeof CustomerCategorySchema>;

/* ── Loyalty periods ───────────────────────────────────────────────────────── */

export const PeriodTypeSchema = z.enum(['WEEKLY', 'MONTHLY', 'CUSTOM']);
export type PeriodType = z.infer<typeof PeriodTypeSchema>;

/* ── Override rules ────────────────────────────────────────────────────────── */

export const OverrideTargetTypeSchema = z.enum(['CUSTOMER', 'CATEGORY']);
export type OverrideTargetType = z.infer<typeof OverrideTargetTypeSchema>;

/* ── Coupons ───────────────────────────────────────────────────────────────── */

export const CouponStatusSchema = z.enum(['ACTIVE', 'USED', 'EXPIRED', 'SUPERSEDED']);
export type CouponStatus = z.infer<typeof CouponStatusSchema>;

/* ── Notifications ─────────────────────────────────────────────────────────── */

export const NotificationChannelSchema = z.enum(['WHATSAPP']);
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;

export const NotificationStatusSchema = z.enum(['PENDING', 'SENT', 'FAILED', 'STUBBED']);
export type NotificationStatus = z.infer<typeof NotificationStatusSchema>;
