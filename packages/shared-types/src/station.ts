import { z } from 'zod';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  STATIONS — PROVISIONED BY THE MANAGER, REVOCABLE BY THE MANAGER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PRD FND-03: «إنشاء المحطات: نوعها (ولاء أو طلبات)، اسم، رابط وQR للربط بجهاز، رمز
 * جهاز يُبطَل من لوحة المدير», with two acceptance criteria that shape the whole
 * design — a station installed on a new device in three minutes with nobody technical
 * present, and a revoked device stopped within a minute.
 *
 * ── Two secrets, not one ─────────────────────────────────────────────────────
 *
 * A **pairing code** is short, short-lived and single-use. It is what goes on the
 * screen as a QR and what somebody reads down a telephone when the tablet has no
 * camera. It grants nothing by itself: presented once, it is exchanged for the real
 * credential and immediately destroyed.
 *
 * A **device token** is 48 bytes of randomness that never appears on a screen after
 * the moment it is issued. It is what the device keeps and what the manager revokes.
 *
 * Collapsing the two — handing out the long-lived token as the QR — would mean a
 * photograph of a screen, or a pairing card left on a desk, is permanent access to a
 * till. The split costs one round trip and removes that entirely.
 *
 * ── Why the code uses this alphabet ──────────────────────────────────────────
 *
 * The same thirty characters the licensing device ID uses (§13.10): no 0/O, no 1/I/L,
 * no U. A code that is read aloud in a shop, or copied off a screen onto a tablet, is
 * read by somebody who is not thinking about character sets. Twelve of them is about
 * 59 bits, which for a single-use secret that expires in fifteen minutes and sits
 * behind a rate limit is a great deal more than enough.
 */

/* ── Enums ─────────────────────────────────────────────────────────────────── */

export const STATION_TYPES = ['LOYALTY', 'ORDERS'] as const;
export const StationTypeSchema = z.enum(STATION_TYPES);
export type StationType = z.infer<typeof StationTypeSchema>;

export const STATION_TYPE_LABELS_AR: Readonly<Record<StationType, string>> = {
  LOYALTY: 'محطة الولاء',
  ORDERS: 'محطة الطلبات',
};

/**
 * PENDING — created, waiting for a device to present the pairing code.
 * ACTIVE  — paired, and the device token it holds is accepted.
 * REVOKED — the manager ended it. Terminal: a revoked station is never reopened,
 *           because "is this the device I revoked or a new one?" is a question the
 *           manager should never have to answer. Re-pairing creates a new station.
 */
export const STATION_STATUSES = ['PENDING', 'ACTIVE', 'REVOKED'] as const;
export const StationStatusSchema = z.enum(STATION_STATUSES);
export type StationStatus = z.infer<typeof StationStatusSchema>;

export const STATION_STATUS_LABELS_AR: Readonly<Record<StationStatus, string>> = {
  PENDING: 'بانتظار الربط',
  ACTIVE: 'مرتبطة',
  REVOKED: 'مُبطَلة',
};

/* ── The pairing code ──────────────────────────────────────────────────────── */

/** §13.10's alphabet: thirty characters with every confusable pair removed. */
export const PAIRING_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PAIRING_CODE_LENGTH = 12;
/** Long enough to walk to the till; short enough that a forgotten code is harmless. */
export const PAIRING_TTL_MINUTES = 15;

/** `ABCD-EFGH-JKMN` — grouped because twelve unbroken characters are miscopied. */
export function formatPairingCode(code: string): string {
  const bare = normalisePairingCode(code);
  return bare.replace(/(.{4})(?=.)/g, '$1-');
}

/**
 * Accepts whatever a person typed and returns the canonical form.
 *
 * Case is folded and grouping dashes and spaces are dropped, because a code read off a
 * screen arrives in every one of those shapes.
 *
 * Confusables are NOT silently corrected, and it is worth saying why, because the
 * tempting thing is to map O to 0 and I to 1. The alphabet excludes *both* members of
 * every confusable pair — no 0 and no O, no 1 and no I and no L — so there is no
 * character to correct them to. A typed O is simply wrong, and the honest answer is to
 * say so. `U` is the one exception the alphabet creates: it was dropped for being
 * confusable with `V`, which was kept, so a `U` has exactly one thing it can have meant.
 */
export function normalisePairingCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/U/g, 'V');
}

export const PairingCodeSchema = z
  .string()
  .transform(normalisePairingCode)
  .refine((code) => code.length === PAIRING_CODE_LENGTH, {
    message: `رمز الربط ${PAIRING_CODE_LENGTH} خانة`,
  })
  .refine((code) => [...code].every((c) => PAIRING_ALPHABET.includes(c)), {
    message: 'رمز الربط يحتوي حرفاً غير صالح',
  });

/* ── Wire contracts ────────────────────────────────────────────────────────── */

export const CreateStationRequestSchema = z
  .object({
    name: z.string().trim().min(2, 'اسم المحطة قصير').max(60, 'اسم المحطة طويل'),
    type: StationTypeSchema,
    /** Which branch it stands in. Null for a single-branch shop. */
    branchId: z.string().uuid().nullable().optional(),
  })
  .strict();
export type CreateStationRequest = z.infer<typeof CreateStationRequestSchema>;

export interface StationPairing {
  /** Grouped for display. Shown once, at creation, and never retrievable again. */
  readonly code: string;
  /** What the QR encodes. The device opens it and the code is filled in for them. */
  readonly url: string;
  readonly expiresAt: string;
}

export interface StationSummary {
  readonly id: string;
  readonly name: string;
  readonly type: StationType;
  readonly status: StationStatus;
  readonly branchId: string | null;
  /** What the device called itself when it paired. Reported by the device, never trusted. */
  readonly deviceLabel: string | null;
  readonly pairedAt: string | null;
  readonly lastSeenAt: string | null;
  readonly revokedAt: string | null;
  /** True while a pairing code is outstanding and unexpired. */
  readonly pairable: boolean;
}

export interface CreateStationResponse {
  readonly station: StationSummary;
  readonly pairing: StationPairing;
}

export const PairStationRequestSchema = z
  .object({
    code: PairingCodeSchema,
    /** «لوحي الكاشير» — free text, for the manager's list. Never used for anything else. */
    deviceLabel: z.string().trim().max(60).optional(),
  })
  .strict();
export type PairStationRequest = z.infer<typeof PairStationRequestSchema>;

export interface PairStationResponse {
  readonly stationId: string;
  readonly name: string;
  readonly type: StationType;
  /**
   * Issued once and never shown again. The device stores it; the server keeps only a
   * SHA-256 of it, for the same reason refresh tokens are stored that way — full-entropy
   * input, so there is no low-entropy secret a slow hash would protect.
   */
  readonly deviceToken: string;
}
