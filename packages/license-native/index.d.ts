/** The licensing module, implemented in Rust (`src/lib.rs`). */

export interface DeviceIdentity {
  deviceId: string;
  machineGuidDigest: string;
  volumeSerialDigest: string;
}

export interface LicenseInfo {
  licenseId: string;
  deviceId: string;
  /** 'trial' | 'perpetual' */
  kind: string;
  /** Unix seconds. */
  issuedAt: number;
  expiresAt?: number | null;
  features: string[];
  note?: string | null;
}

export type VerifyFailure = 'MALFORMED' | 'BAD_SIGNATURE' | 'UNSUPPORTED_VERSION' | 'DEVICE_MISMATCH';

export interface VerifyOutcome {
  ok: boolean;
  reason?: VerifyFailure | null;
  licensedDevice?: string | null;
  version?: number | null;
  license?: LicenseInfo | null;
  normalized?: string | null;
}

export type LicenseStatusName =
  | 'UNLICENSED'
  | 'TRIAL'
  | 'EMERGENCY'
  | 'GRACE'
  | 'EXPIRED'
  | 'PERPETUAL'
  | 'TAMPERED';

export type LicenseBasis = 'trial' | 'perpetual' | 'emergency';
export type LicenseWarning = 'none' | 'notice' | 'warning' | 'urgent';

export interface LicenseStatus {
  status: LicenseStatusName;
  readOnly: boolean;
  basis?: LicenseBasis | null;
  warning: LicenseWarning;
  license?: LicenseInfo | null;
  expiresAt?: number | null;
  graceEndsAt?: number | null;
  daysLeft?: number | null;
  clockBehindBy?: number | null;
  invalidCodes: number;
  invalidUnlocks: number;
  emergencyUntil?: number | null;
  /** Seconds the clock is behind the latest recorded time, whatever the licence. */
  clockRollbackBy?: number | null;
}

export type UnlockFailure = 'MALFORMED' | 'TYPO' | 'NOT_VALID' | 'EXPIRED';

export interface UnlockOutcome {
  ok: boolean;
  reason?: UnlockFailure | null;
  validUntil?: number | null;
  normalized?: string | null;
}

export interface AnchorResolution {
  latest?: number | null;
  conflict: boolean;
}

export interface KeyInfo {
  kind: 'development' | 'production';
  fingerprint: string;
  /** Unix seconds: the day the vendor's key was made. */
  createdAt: number;
}

/** False when the module file is missing; every function then throws an Arabic sentence. */
export const available: boolean;
export function computeDeviceId(): DeviceIdentity;
export function verifyLicense(code: string, deviceId: string): VerifyOutcome;
export function licenseStatus(
  codes: string[],
  unlockCodes: string[],
  deviceId: string,
  now: number,
  latestSeen: number | null | undefined,
): LicenseStatus;
export function verifyUnlock(
  code: string,
  deviceId: string,
  now: number,
  latestSeen: number | null | undefined,
): UnlockOutcome;
export function recordingAllowed(codes: string[], unlockCodes: string[], deviceId: string, t: number): boolean;
export function uptimeSeconds(): number | null;
export function resolveAnchors(readings: Array<number | null>): AnchorResolution;
export function readFileAnchor(path: string): number | null;
export function writeFileAnchor(path: string, value: number): void;
export function readRegistryAnchor(subkey: string): number | null;
export function writeRegistryAnchor(subkey: string, value: number): void;
export function keyInfo(): KeyInfo;
export function normalizeCode(text: string): string;
export function knownFeatures(): string[];
/** Test build only. */
export function signForTests(payloadJson: string): string;
/** Test build only: an emergency code from the published test chain. */
export function unlockCodeForTests(deviceId: string, now: number, days: number): string;
/** Test build only. */
export function deleteRegistryKeyForTests(subkey: string): void;
