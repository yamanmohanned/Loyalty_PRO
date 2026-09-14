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
  /** The trial has expired and the five grace days are running. Fully working. */
  'TRIAL_GRACE',
  /** Trial and grace both over. Read-only. */
  'EXPIRED',
  /** Never expires. */
  'PERPETUAL',
  /** The clock is behind the latest recorded time, or the stored licence failed its check. Read-only. */
  'TAMPERED',
]);
export type LicenseStatusName = z.infer<typeof LicenseStatusNameSchema>;

/** Features a licence can grant. `drive_backup` gates uploads to Google Drive. */
export const LICENSE_FEATURES = ['drive_backup', 'multi_device'] as const;
export type LicenseFeature = (typeof LICENSE_FEATURES)[number];

export interface LicenseState {
  status: LicenseStatusName;
  /** New sales, new customers and voucher redemptions are refused. Everything else works. */
  readOnly: boolean;
  /** This installation's device ID, `WL-XXXX-XXXX` — what the merchant sends the vendor. */
  deviceId: string;
  kind: 'trial' | 'perpetual' | null;
  licenseId: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  graceEndsAt: string | null;
  /** Whole days left: to expiry in TRIAL, to the end of grace in TRIAL_GRACE. */
  daysLeft: number | null;
  /** TRIAL within its last seven days — the top bar counts down. */
  showExpiryWarning: boolean;
  /** How far the clock is behind the latest recorded time, when TAMPERED by clock. */
  clockBehindMinutes: number | null;
  /** TAMPERED because a stored licence failed its own signature check. */
  storedLicenseInvalid: boolean;
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
