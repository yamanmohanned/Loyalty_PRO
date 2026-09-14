import { z } from 'zod';

/**
 * Offline licensing (packaging/LICENSING.md).
 *
 * The status is decided by the service — by the Rust licensing module it loads — on
 * every sale, new customer and voucher redemption. These types only describe what it
 * reports; nothing on a screen can change it.
 */

export const LicenseStatusNameSchema = z.enum([
  /** No licence — a new installation. Read-only. */
  'UNLICENSED',
  'TRIAL',
  /** An emergency code read over the phone is keeping the shop fully working. */
  'EMERGENCY',
  /** A trial or an emergency window has ended; five days of full operation remain. */
  'GRACE',
  /** A trial and its grace are over. Read-only. */
  'EXPIRED',
  /** Never expires. */
  'PERPETUAL',
  /** The clock is behind the latest recorded time, or the stored licence failed its check. Read-only. */
  'TAMPERED',
]);
export type LicenseStatusName = z.infer<typeof LicenseStatusNameSchema>;

/**
 * How loudly the screens say it: `notice` in the bell (two weeks out), `warning` a
 * countdown in the top bar (one week), `urgent` a red banner on every screen (three
 * days, and every read-only or grace state).
 */
export type LicenseWarning = 'none' | 'notice' | 'warning' | 'urgent';

/** Features a licence can grant. `drive_backup` gates uploads to Google Drive. */
export const LICENSE_FEATURES = ['drive_backup', 'multi_device'] as const;
export type LicenseFeature = (typeof LICENSE_FEATURES)[number];

export interface LicenseState {
  status: LicenseStatusName;
  /** New sales, new customers and voucher redemptions are refused. Everything else works. */
  readOnly: boolean;
  /** This installation's device ID, `WL-XXXX-XXXX` — what the merchant sends the vendor. */
  deviceId: string;
  /** The governing licence's kind, when there is a valid one. */
  kind: 'trial' | 'perpetual' | null;
  /** What a working status rests on — `emergency` while a phone code carries the shop. */
  basis: 'trial' | 'perpetual' | 'emergency' | null;
  licenseId: string | null;
  issuedAt: string | null;
  /** When the governing trial or emergency window ends. */
  expiresAt: string | null;
  graceEndsAt: string | null;
  /** Whole days left: to the end in TRIAL and EMERGENCY, to the end of grace in GRACE. */
  daysLeft: number | null;
  warning: LicenseWarning;
  /** The end of the latest emergency window entered here, past or future. */
  emergencyUntil: string | null;
  /** How far the clock is behind the latest recorded time, when TAMPERED by clock. */
  clockBehindMinutes: number | null;
  /** TAMPERED because a stored licence failed its own signature check. */
  storedLicenseInvalid: boolean;
  /**
   * The licence check itself failed — the module is missing, or a bug — and this is the
   * last status recorded before it did. A shop that was licensed keeps trading.
   */
  degraded: boolean;
  features: string[];
  note: string | null;
}

export interface LicenseActivationEntry {
  licenseId: string;
  kind: 'trial' | 'perpetual';
  activatedAt: string;
  issuedAt: string;
  expiresAt: string | null;
  features: string[];
  note: string | null;
  activatedByName: string | null;
}

export interface LicenseOverview {
  state: LicenseState;
  activations: LicenseActivationEntry[];
}

/** The code as pasted — whitespace and line breaks are fine; the service removes them. */
export const ActivateLicenseRequestSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(1, 'الصق رمز التفعيل الذي أرسله المزوّد أولاً.')
      .max(8000, 'هذا النص أطول من أي رمز تفعيل — الصق الرمز وحده.'),
  })
  .strict();
export type ActivateLicenseRequest = z.infer<typeof ActivateLicenseRequestSchema>;

export interface ActivateLicenseResponse {
  state: LicenseState;
  activation: LicenseActivationEntry;
  /** The same code was already active; nothing changed. */
  alreadyActive: boolean;
}

/** Why an activation was refused — `details.reason` on LICENSE_INVALID. */
export type LicenseRefusalReason =
  | 'MALFORMED'
  | 'BAD_SIGNATURE'
  | 'UNSUPPORTED_VERSION'
  | 'DEVICE_MISMATCH'
  | 'EXPIRED_CODE'
  | 'CLOCK_BEHIND'
  | 'PERPETUAL_ACTIVE';

/** The fifteen symbols read over the phone — case, spaces and dashes do not matter. */
export const EnterUnlockRequestSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(1, 'اكتب رمز الطوارئ الذي قرأه لك المزوّد.')
      .max(64, 'رمز الطوارئ خمسة عشر حرفاً — اكتبه وحده.'),
  })
  .strict();
export type EnterUnlockRequest = z.infer<typeof EnterUnlockRequestSchema>;

export interface EnterUnlockResponse {
  state: LicenseState;
  /** Full operation until then. */
  validUntil: string;
  /** The same code was already entered; nothing changed. */
  alreadyEntered: boolean;
}

/** Why an emergency code was refused — `details.reason` on LICENSE_INVALID. */
export type UnlockRefusalReason = 'MALFORMED' | 'TYPO' | 'NOT_VALID' | 'EXPIRED';

export const LICENSE_EVENT_TYPES = [
  'ACTIVATED',
  'ACTIVATION_FAILED',
  'UNLOCK_ENTERED',
  'UNLOCK_FAILED',
  'LOST',
  'DEVICE_IDENTIFIED',
  'DEVICE_SOURCES_CHANGED',
  'CLOCK_ROLLBACK',
  'CLOCK_RESTORED',
  'CLOCK_ANCHOR_CONFLICT',
  'CLOCK_ANCHOR_RESET',
  'STORED_CODE_INVALID',
  'RESTORED_FROM_MIRROR',
  'CHECK_FAILED',
  'ACCEPTED_BY_OCCURRENCE',
] as const;
export type LicenseEventType = (typeof LICENSE_EVENT_TYPES)[number];

/**
 * What a clock event says about its cause — the difference between a merchant who wound
 * the clock back and one whose CMOS battery died.
 *
 * - `FIRMWARE_RESET`: the clock read a date before this program's key existed. Nothing
 *   a person picks on purpose; typical of a dead motherboard battery or a BIOS reset.
 * - `CHANGED_WHILE_RUNNING`: the clock jumped back while the program was running.
 *   Somebody changed the date.
 * - `SET_BACK_WHILE_OFF`: the machine started with a plausible but earlier date —
 *   changed while it was off, or a battery that drifted.
 */
export type ClockRollbackCause = 'FIRMWARE_RESET' | 'CHANGED_WHILE_RUNNING' | 'SET_BACK_WHILE_OFF';

export interface LicenseEvent {
  id: string;
  type: LicenseEventType;
  at: string;
  actorName: string | null;
  details: Record<string, unknown>;
}

export interface LicenseEventsResponse {
  events: LicenseEvent[];
  /** Every clock rollback ever recorded here — one, or a pattern. */
  clockRollbacks: number;
}
