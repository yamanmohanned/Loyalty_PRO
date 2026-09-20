import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Prisma, PrismaClient, Station } from '@prisma/client';
import {
  PAIRING_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_TTL_MINUTES,
  formatPairingCode,
  type CreateStationRequest,
  type StationSummary,
  type StationType,
  type StationStatus,
} from '@loyalty-pro/shared-types';
import { prisma as defaultClient } from '../lib/prisma';
import { AUDIT_ACTIONS, recordAudit } from './audit.service';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  PROVISIONING A TILL, AND ENDING ONE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PRD FND-03, whose two acceptance criteria are the design: a station on a new device
 * «خلال 3 دقائق دون تدخل تقني», and a revoked device stopped «خلال دقيقة».
 *
 * The three-minute one is why pairing is a short code on a screen rather than a
 * configuration file: the manager creates the station, the tablet reads the QR (or
 * somebody types twelve characters), and it is done. The one-minute one is why the
 * device token is checked against the database on the request rather than trusted from
 * a signed claim — a JWT cannot be un-issued, so a fifteen-minute access token would
 * mean a revoked till kept trading for fifteen minutes.
 *
 * ── Why a fresh station rather than re-pairing a revoked one ─────────────────
 *
 * REVOKED is terminal. Re-pairing a revoked station would leave the manager's list
 * showing one row whose history contains two devices, and «is this the tablet I
 * revoked last month, or the new one?» is a question nobody should have to answer
 * about a device that can take money. A new device is a new row.
 */

type Db = PrismaClient | Prisma.TransactionClient;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * A pairing code from §13.10's alphabet.
 *
 * `randomInt` rather than `randomBytes(n) % 30`: the modulo is biased, because 256 is
 * not a multiple of 30 — the first sixteen characters of the alphabet would come up
 * slightly more often than the rest. It makes no practical difference to a code that
 * expires in fifteen minutes, and it costs nothing to not have to think about that.
 */
function generatePairingCode(): string {
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i += 1) {
    code += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
  }
  return code;
}

/** Same shape as a refresh token: full-entropy random, stored only as a digest. */
function generateDeviceToken(): { token: string; hash: string } {
  const token = randomBytes(48).toString('base64url');
  return { token, hash: sha256(token) };
}

/**
 * Constant-time comparison of two hex digests.
 *
 * The pairing code is compared by looking its hash up in the database, so this is only
 * reached for the candidate that matched a merchant's row — but a `===` on a secret is
 * the kind of thing that gets copied into somewhere it matters.
 */
function digestsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function toSummary(station: Station, now: Date = new Date()): StationSummary {
  return {
    id: station.id,
    name: station.name,
    type: station.type as StationType,
    status: station.status as StationStatus,
    branchId: station.branchId,
    deviceLabel: station.deviceLabel,
    pairedAt: station.pairedAt?.toISOString() ?? null,
    lastSeenAt: station.lastSeenAt?.toISOString() ?? null,
    revokedAt: station.revokedAt?.toISOString() ?? null,
    pairable:
      station.status === 'PENDING' &&
      station.pairingCodeHash !== null &&
      (station.pairingExpiresAt?.getTime() ?? 0) > now.getTime(),
  };
}

export class StationError extends Error {
  constructor(
    readonly code: 'NAME_TAKEN' | 'NOT_FOUND' | 'ALREADY_REVOKED' | 'BAD_CODE' | 'ALREADY_PAIRED',
    message: string,
  ) {
    super(message);
    this.name = 'StationError';
  }
}

export interface CreatedStation {
  readonly station: StationSummary;
  readonly code: string;
  readonly expiresAt: Date;
}

/** Creates a station and its first pairing code. The code is returned once, here. */
export async function createStation(
  merchantId: string,
  request: CreateStationRequest,
  actorUserId: string | null,
  db: Db = defaultClient,
  now: Date = new Date(),
): Promise<CreatedStation> {
  const clash = await db.station.findFirst({
    where: { merchantId, name: request.name },
    select: { id: true },
  });
  if (clash) {
    throw new StationError(
      'NAME_TAKEN',
      'توجد محطة بهذا الاسم. الأسماء تُميّز المحطات في القوائم والتقارير، فلا تتكرر.',
    );
  }

  const code = generatePairingCode();
  const expiresAt = new Date(now.getTime() + PAIRING_TTL_MINUTES * 60_000);

  const station = await db.station.create({
    data: {
      merchantId,
      branchId: request.branchId ?? null,
      type: request.type,
      name: request.name,
      status: 'PENDING',
      pairingCodeHash: sha256(code),
      pairingExpiresAt: expiresAt,
      createdByUserId: actorUserId,
    },
  });

  await recordAudit(
    {
      merchantId,
      actorUserId,
      action: AUDIT_ACTIONS.STATION_CREATED,
      entityType: 'station',
      entityId: station.id,
      after: { name: station.name, type: station.type },
    },
    db,
  );

  return { station: toSummary(station, now), code: formatPairingCode(code), expiresAt };
}

/**
 * Issues a fresh pairing code for a station that has not been paired.
 *
 * Exists because the first code expires in fifteen minutes and the tablet is often not
 * in the room yet. It refuses an ACTIVE station: re-pairing a live till from the
 * manager's screen, with no revocation in between, would be a way to silently move a
 * shop's till onto another device.
 */
export async function regeneratePairing(
  merchantId: string,
  stationId: string,
  actorUserId: string | null,
  db: Db = defaultClient,
  now: Date = new Date(),
): Promise<CreatedStation> {
  const station = await db.station.findFirst({ where: { id: stationId, merchantId } });
  if (!station) throw new StationError('NOT_FOUND', 'لا توجد محطة بهذا المعرّف.');
  if (station.status === 'REVOKED') {
    throw new StationError('ALREADY_REVOKED', 'هذه المحطة مُبطَلة. أنشئ محطة جديدة بدلاً منها.');
  }
  if (station.status === 'ACTIVE') {
    throw new StationError(
      'ALREADY_PAIRED',
      'هذه المحطة مرتبطة بجهاز. أبطِلها أولاً إن أردت ربطها بجهاز آخر.',
    );
  }

  const code = generatePairingCode();
  const expiresAt = new Date(now.getTime() + PAIRING_TTL_MINUTES * 60_000);

  const updated = await db.station.update({
    where: { id: station.id },
    data: { pairingCodeHash: sha256(code), pairingExpiresAt: expiresAt },
  });

  await recordAudit(
    {
      merchantId,
      actorUserId,
      action: AUDIT_ACTIONS.STATION_PAIRING_ISSUED,
      entityType: 'station',
      entityId: station.id,
      after: { expiresAt },
    },
    db,
  );

  return { station: toSummary(updated, now), code: formatPairingCode(code), expiresAt };
}

export interface PairedStation {
  readonly station: Station;
  readonly deviceToken: string;
}

/**
 * Exchanges a pairing code for a device token, once.
 *
 * The code is destroyed in the same statement that pairs the station, and the update is
 * conditional on the station still being PENDING — so two devices racing on one code
 * cannot both pair. The loser sees the ordinary "bad code" refusal, which is true by
 * then.
 *
 * Deliberately unauthenticated: the device presenting the code has no account yet, and
 * requiring one would mean a person with a password has to stand at every tablet, which
 * is exactly the three-minute criterion this is built to meet. The code itself is the
 * credential — single-use, short-lived, and rate-limited at the route.
 */
export async function pairStation(
  code: string,
  deviceLabel: string | undefined,
  db: Db = defaultClient,
  now: Date = new Date(),
): Promise<PairedStation> {
  const hash = sha256(code);

  const candidate = await db.station.findFirst({
    where: { pairingCodeHash: hash, status: 'PENDING' },
  });

  const badCode = new StationError(
    'BAD_CODE',
    'رمز الربط غير صحيح أو انتهت صلاحيته. اطلب رمزاً جديداً من لوحة المدير.',
  );

  if (!candidate || !candidate.pairingCodeHash) throw badCode;
  if (!digestsMatch(candidate.pairingCodeHash, hash)) throw badCode;
  if ((candidate.pairingExpiresAt?.getTime() ?? 0) <= now.getTime()) throw badCode;

  const { token, hash: tokenHash } = generateDeviceToken();

  // Conditional on PENDING: the race between two devices is decided here, by the
  // database, rather than by which of them read the row first.
  const claimed = await db.station.updateMany({
    where: { id: candidate.id, status: 'PENDING' },
    data: {
      status: 'ACTIVE',
      deviceTokenHash: tokenHash,
      deviceLabel: deviceLabel ?? null,
      pairedAt: now,
      lastSeenAt: now,
      pairingCodeHash: null,
      pairingExpiresAt: null,
    },
  });
  if (claimed.count !== 1) throw badCode;

  const station = await db.station.findUniqueOrThrow({ where: { id: candidate.id } });

  await recordAudit(
    {
      merchantId: station.merchantId,
      actorUserId: null,
      action: AUDIT_ACTIONS.STATION_PAIRED,
      entityType: 'station',
      entityId: station.id,
      after: { name: station.name, deviceLabel: station.deviceLabel },
    },
    db,
  );

  return { station, deviceToken: token };
}

/**
 * Ends a station.
 *
 * The device token is cleared as well as the status being set, so even a bug that
 * forgot to check the status could not resolve the old token to this row. Belt and
 * brace, on the one control whose whole purpose is to stop a device.
 */
export async function revokeStation(
  merchantId: string,
  stationId: string,
  actorUserId: string | null,
  db: Db = defaultClient,
  now: Date = new Date(),
): Promise<StationSummary> {
  const station = await db.station.findFirst({ where: { id: stationId, merchantId } });
  if (!station) throw new StationError('NOT_FOUND', 'لا توجد محطة بهذا المعرّف.');
  if (station.status === 'REVOKED') {
    throw new StationError('ALREADY_REVOKED', 'هذه المحطة مُبطَلة بالفعل.');
  }

  const updated = await db.station.update({
    where: { id: station.id },
    data: {
      status: 'REVOKED',
      revokedAt: now,
      revokedByUserId: actorUserId,
      deviceTokenHash: null,
      pairingCodeHash: null,
      pairingExpiresAt: null,
    },
  });

  await recordAudit(
    {
      merchantId,
      actorUserId,
      action: AUDIT_ACTIONS.STATION_REVOKED,
      entityType: 'station',
      entityId: station.id,
      before: { status: station.status, deviceLabel: station.deviceLabel },
      after: { status: 'REVOKED' },
    },
    db,
  );

  return toSummary(updated, now);
}

export async function listStations(
  merchantId: string,
  db: Db = defaultClient,
): Promise<StationSummary[]> {
  const stations = await db.station.findMany({
    where: { merchantId },
    orderBy: [{ status: 'asc' }, { name: 'asc' }],
  });
  const now = new Date();
  return stations.map((station) => toSummary(station, now));
}

/* ── The per-request check ─────────────────────────────────────────────────── */

/**
 * `lastSeenAt` is a column in a list, not an audit trail, so it is not worth a write on
 * every request a till makes. One a minute per station is plenty to answer «when did
 * this tablet last talk to us», which is the only question it is there for.
 */
const LAST_SEEN_THROTTLE_MS = 60_000;
const lastSeenWrites = new Map<string, number>();

/** Test hook: the throttle is process-local, and a suite reuses one process. */
export function resetLastSeenThrottleForTests(): void {
  lastSeenWrites.clear();
}

export interface ResolvedStation {
  readonly id: string;
  readonly merchantId: string;
  readonly name: string;
  readonly type: StationType;
}

/**
 * Resolves a device token to its station, or null.
 *
 * One indexed read on a unique hash. Done per request rather than from a claim inside
 * the access token, because FND-03 requires a revoked device to stop within a minute
 * and a JWT cannot be withdrawn — a fifteen-minute token would mean fifteen minutes of
 * a revoked till still trading.
 *
 * Returns null for anything that is not an ACTIVE station: an unknown token, a revoked
 * one, or a token belonging to another merchant's station. The caller cannot tell those
 * apart, which is correct — they are all "this device may not act".
 */
export async function resolveDeviceToken(
  token: string,
  db: Db = defaultClient,
  now: Date = new Date(),
): Promise<ResolvedStation | null> {
  const station = await db.station.findUnique({
    where: { deviceTokenHash: sha256(token) },
    select: { id: true, merchantId: true, name: true, type: true, status: true },
  });
  if (!station || station.status !== 'ACTIVE') return null;

  const last = lastSeenWrites.get(station.id) ?? 0;
  if (now.getTime() - last >= LAST_SEEN_THROTTLE_MS) {
    lastSeenWrites.set(station.id, now.getTime());
    // Deliberately not awaited into the request's critical path beyond the update
    // itself; a failure here must never refuse a sale.
    await db.station
      .update({ where: { id: station.id }, data: { lastSeenAt: now } })
      .catch(() => undefined);
  }

  return {
    id: station.id,
    merchantId: station.merchantId,
    name: station.name,
    type: station.type as StationType,
  };
}
