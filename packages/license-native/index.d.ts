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

export type LicenseStatusName = 'UNLICENSED' | 'TRIAL' | 'TRIAL_GRACE' | 'EXPIRED' | 'PERPETUAL' | 'TAMPERED';

export interface LicenseStatus {
  status: LicenseStatusName;
  readOnly: boolean;
  license?: LicenseInfo | null;
  expiresAt?: number | null;
  graceEndsAt?: number | null;
  daysLeft?: number | null;
  showExpiryWarning: boolean;
  clockBehindBy?: number | null;
  invalidCodes: number;
}

export interface AnchorResolution {
  latest?: number | null;
  conflict: boolean;
}

export interface KeyInfo {
  kind: 'development' | 'production';
  fingerprint: string;
}

/** False when the module file is missing; every function then throws an Arabic sentence. */
export const available: boolean;
export function computeDeviceId(): DeviceIdentity;
export function verifyLicense(code: string, deviceId: string): VerifyOutcome;
export function licenseStatus(
  codes: string[],
  deviceId: string,
  now: number,
  latestSeen: number | null | undefined,
): LicenseStatus;
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
/** Test build only. */
export function deleteRegistryKeyForTests(subkey: string): void;
