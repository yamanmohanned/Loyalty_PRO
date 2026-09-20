import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  computeDeviceId,
  deleteRegistryKeyForTests,
  keyInfo,
  licenseStatus as evaluateStatus,
  readFileAnchor,
  readRegistryAnchor,
  recordingAllowed,
  resolveAnchors,
  uptimeSeconds,
  verifyLicense,
  verifyUnlock,
  writeFileAnchor,
  writeRegistryAnchor,
  type LicenseInfo,
  type LicenseStatus as NativeStatus,
} from '@loyalty-pro/license-native';
import {
  LICENSE_EVENT_TYPES,
  LICENSE_FEATURES,
  type ActivateLicenseResponse,
  type ClockRollbackCause,
  type EnterUnlockResponse,
  type LicenseActivationEntry,
  type LicenseEvent,
  type LicenseEventType,
  type LicenseEventsResponse,
  type LicenseFeature,
  type LicenseOverview,
  type LicenseRefusalReason,
  type LicenseState,
  type LicenseStatusName,
  type UnlockRefusalReason,
} from '@loyalty-pro/shared-types';
import { loadEnv } from '../config/env';
import { resolveDataDir } from '../config/paths';
import { AppError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { AUDIT_ACTIONS, recordAudit, type AuditAction } from './audit.service';

/**
 * Offline licensing, as the service applies it (packaging/LICENSING.md).
 *
 * ## The rule above every other
 *
 * **A shop that has paid is never stopped.** Not by a corrupted licence, a lost clock
 * record, a Windows reinstall, or a bug in this file. Every path below that can refuse
 * a sale has a way back that needs neither a visit nor the internet:
 *
 *  - an emergency code the provider reads over the phone (`enterUnlock`) restores full
 *    operation at once, whatever else is wrong;
 *  - a trial or an emergency window that ends is followed by five days of full
 *    operation with a red warning — never a hard stop;
 *  - when the check itself fails, the gate uses the last status it recorded, so a shop
 *    last seen licensed keeps trading (`degradedState`);
 *  - a sale the till queued while the shop was licensed is accepted whenever it
 *    arrives (`assertCanRecord`'s `occurredAt`).
 *
 * ## Where the decisions are made
 *
 * In Rust (`@loyalty-pro/license-native`, built from `crates/loyalty-pro-license`): the device ID,
 * every signature and phone-code check, the governing licence, the status. This file
 * stores codes and times, asks, and applies the answer — on every sale, new customer
 * and voucher redemption, here in the service, because a lock in a screen is gone the
 * moment somebody opens the API in a browser.
 *
 * ## What read-only means
 *
 * UNLICENSED, EXPIRED and TAMPERED refuse three things: linking a sale, registering a
 * customer, and redeeming a voucher. Nothing else. Reports, the customer list, card
 * history, exports, backups and restores all keep working, and capturing invoices from
 * the register never stops. The merchant's data is never withheld.
 *
 * ## The clock, and the record of it
 *
 * The latest time this installation has seen is kept in three places — the
 * `installation_state` table, `HKCU\Software\LoyaltyPro`, and a hidden file in the data
 * folder — the latest winning. A clock more than two hours behind it is TAMPERED until
 * corrected. Every such event is written to the audit trail AND to an append-only file
 * beside the clock file, which is merged back after a restore: the record of a clock
 * wound back does not disappear with the database it was written to.
 */

const PRODUCTION_REGISTRY_KEY = 'Software\\LoyaltyPro';
const ANCHOR_FILE = '.license-clock';
const MIRROR_FILE = 'license-codes.json';
const EVENTS_FILE = 'license-events.log';
const MIRROR_FORMAT = 'loyalty-pro-license-codes-v2';
const TOLERANCE_SECONDS = 2 * 3600;
const TOUCH_INTERVAL_MS = 10 * 60 * 1000;
const DAY_MS = 86_400_000;
/** How long a till may hold a sale offline and still have it judged by when it happened. */
const OCCURRENCE_WINDOW_DAYS = 30;
/** A failing check is recorded at most this often — once is evidence, every request is noise. */
const CHECK_FAILED_RECORD_INTERVAL_MS = 3600_000;
const DAY_SECONDS = 86_400;
/**
 * How long the gate trusts a time-limited status it can no longer check: a week from the
 * last time the module confirmed it. Time to reinstall — not a way to run out a trial.
 */
const FALLBACK_DAYS = 7;
/** Working statuses that end. The fallback bounds each by its recorded end and `FALLBACK_DAYS`. */
const TIME_LIMITED: ReadonlySet<LicenseStatusName> = new Set(['TRIAL', 'EMERGENCY', 'GRACE']);
/** The data-folder clock file's first word (crates/loyalty-pro-license/src/anchors.rs). */
const ANCHOR_HEADER = 'walaa-clock-v1';

type Log = (message: string, extra?: Record<string, unknown>) => void;

let log: Log = (message, extra = {}) => {
  process.stdout.write(`${JSON.stringify({ level: 30, time: Date.now(), ...extra, msg: message })}\n`);
};

interface Installation {
  deviceId: string;
  latestSeen: number | null;
}

/** An open clock episode: a rollback recorded and not yet corrected. */
interface ClockEpisode {
  eventId: string;
  /** The latest recorded time when it was detected — the last moment known to be real. */
  latestSeen: number | null;
  /** Monotonic milliseconds at detection, when this process saw it happen. */
  sinceMono: number | null;
}

let installation: Installation | null = null;
let initialising: Promise<Installation> | null = null;
let lastTouchAt = 0;
let reportedInvalidCodes = false;
let rememberedStatus: string | null = null;
/** Successful checks since this process started: the first is at start-up. */
let checks = 0;
let lastWallMs = Date.now();
let lastMonoMs = performance.now();
let episode: ClockEpisode | null = null;
let refusedDuringEpisode = 0;
let lastCheckFailedRecordedAt = 0;
let failureForTests: Error | null = null;
/** Whether this installation is known to have held a licence — this run, or at its last recorded status. */
let licenceSeen = false;

const nowSeconds = (): number => Math.floor(Date.now() / 1000);
const iso = (seconds: number | null | undefined): string | null =>
  seconds === null || seconds === undefined ? null : new Date(seconds * 1000).toISOString();

function registryKey(): string {
  const env = loadEnv();
  return (env.NODE_ENV !== 'production' && env.LOYALTY_LICENSE_REGISTRY_KEY) || PRODUCTION_REGISTRY_KEY;
}

function licenseDirectory(): string {
  const env = loadEnv();
  return (env.NODE_ENV !== 'production' && env.LOYALTY_LICENSE_DIR) || resolveDataDir();
}

const anchorFile = (): string => join(licenseDirectory(), ANCHOR_FILE);
const mirrorFile = (): string => join(licenseDirectory(), MIRROR_FILE);
const eventsFile = (): string => join(licenseDirectory(), EVENTS_FILE);

async function firstMerchantId(): Promise<string | null> {
  const merchant = await prisma.merchant.findFirst({ select: { id: true } }).catch(() => null);
  return merchant?.id ?? null;
}

/* ── Licence events: the audit trail, and a file that survives a restore ────── */

interface StoredEvent {
  id: string;
  action: AuditAction;
  at: string;
  actorUserId: string | null;
  details: Record<string, unknown>;
}

function appendEventFile(event: StoredEvent): void {
  try {
    const path = eventsFile();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf8');
  } catch (error) {
    log('licence: an event could not be appended to the events file', { error: String(error), action: event.action });
  }
}

function readEventFile(): StoredEvent[] {
  try {
    const path = eventsFile();
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as StoredEvent;
          return typeof parsed.id === 'string' && typeof parsed.action === 'string' ? [parsed] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

async function writeEventRow(merchantId: string, event: StoredEvent): Promise<void> {
  await prisma.auditLog.create({
    data: {
      merchantId,
      actorUserId: event.actorUserId,
      action: event.action,
      entityType: 'license',
      entityId: event.id,
      afterJson: JSON.stringify(event.details),
      createdAt: new Date(event.at),
    },
  });
}

/**
 * Records a licence event in both places. The file first: it is the copy that survives
 * the database being replaced, and the one written even when the database cannot be.
 */
async function recordEvent(
  action: AuditAction,
  details: Record<string, unknown>,
  actor: { merchantId?: string; userId?: string | null } = {},
): Promise<string> {
  // Stamped with the best-known real time, not the system clock alone: an event recorded
  // while the clock reads 2001 must not sort to the start of the log the provider reads.
  // The wrong system time is kept in the event's own details where it matters.
  const at = Math.max(Date.now(), (installation?.latestSeen ?? 0) * 1000);
  const event: StoredEvent = {
    id: randomUUID(),
    action,
    at: new Date(at).toISOString(),
    actorUserId: actor.userId ?? null,
    details,
  };
  appendEventFile(event);
  const merchantId = actor.merchantId ?? (await firstMerchantId());
  if (merchantId) {
    await writeEventRow(merchantId, event).catch((error: unknown) =>
      log('licence: an event could not be written to the audit trail', { error: String(error), action }),
    );
  }
  return event.id;
}

/**
 * Puts back into the audit trail every event the file holds and the database does not —
 * after a restore of an older copy, or events recorded before the first account existed.
 */
async function mergeEventFile(): Promise<number> {
  const events = readEventFile();
  if (events.length === 0) return 0;
  const merchantId = await firstMerchantId();
  if (!merchantId) return 0;

  const present = new Set<string>();
  for (let i = 0; i < events.length; i += 400) {
    const rows = await prisma.auditLog.findMany({
      where: { entityType: 'license', entityId: { in: events.slice(i, i + 400).map((e) => e.id) } },
      select: { entityId: true },
    });
    for (const row of rows) present.add(row.entityId);
  }

  let merged = 0;
  for (const event of events) {
    if (present.has(event.id)) continue;
    // The person may not exist in the restored database; the event still does.
    const actor = event.actorUserId
      ? await prisma.user.findUnique({ where: { id: event.actorUserId }, select: { id: true } })
      : null;
    await writeEventRow(merchantId, {
      ...event,
      actorUserId: actor?.id ?? null,
      details: { ...event.details, restoredFromFile: true },
    }).catch(() => undefined);
    present.add(event.id);
    merged += 1;
  }
  if (merged > 0) log('licence: events put back from the events file', { merged });
  return merged;
}

/* ── The three clock anchors ────────────────────────────────────────────────── */

interface Readings {
  database: number | null;
  registry: number | null;
  file: number | null;
}

async function readAnchors(): Promise<Readings> {
  const row = await prisma.installationState.findUnique({ where: { id: 1 }, select: { lastSeenAt: true } });
  const readings: Readings = {
    database: row?.lastSeenAt ? Math.floor(row.lastSeenAt.getTime() / 1000) : null,
    registry: null,
    file: null,
  };
  try {
    readings.registry = readRegistryAnchor(registryKey()) ?? null;
  } catch (error) {
    log('licence: the registry clock anchor could not be read', { error: String(error) });
  }
  try {
    readings.file = readFileAnchor(anchorFile()) ?? null;
  } catch (error) {
    log('licence: the file clock anchor could not be read', { error: String(error) });
  }
  return readings;
}

/**
 * Writes the time to all three places. One that fails is logged and the others are
 * still written — the point of three is that losing one does not lose the record.
 */
async function writeAnchors(value: number): Promise<void> {
  const failures: string[] = [];
  try {
    await prisma.installationState.update({ where: { id: 1 }, data: { lastSeenAt: new Date(value * 1000) } });
  } catch (error) {
    failures.push(`database: ${String(error)}`);
  }
  try {
    writeRegistryAnchor(registryKey(), value);
  } catch (error) {
    failures.push(`registry: ${String(error)}`);
  }
  try {
    writeFileAnchor(anchorFile(), value);
  } catch (error) {
    failures.push(`file: ${String(error)}`);
  }
  if (failures.length > 0) log('licence: a clock anchor could not be written', { failures });
}

/** Moves the recorded time forward to now. Never backward: a clock set back must not drag it along. */
async function touch(force = false): Promise<void> {
  const current = installation;
  if (!current) return;
  if (!force && Date.now() - lastTouchAt < TOUCH_INTERVAL_MS) return;
  lastTouchAt = Date.now();
  current.latestSeen = Math.max(current.latestSeen ?? 0, nowSeconds());
  await writeAnchors(current.latestSeen);
}

/* ── The mirror of activated codes ──────────────────────────────────────────── */

/*
  Every activated licence and emergency code is also kept in a file beside the clock
  anchor. A restore puts back an older database — possibly one from before the shop's
  licence was activated — and a restore must never cost a merchant the licence. On
  start, codes found in the file and not in the database are re-verified and put back.
  The codes are signed or chained, so the file needs no secrecy.
*/

interface Mirror {
  codes: string[];
  unlocks: string[];
}

function readMirror(): Mirror {
  try {
    const path = mirrorFile();
    if (!existsSync(path)) return { codes: [], unlocks: [] };
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { format?: string; codes?: unknown; unlocks?: unknown };
    const strings = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
    if (parsed.format !== MIRROR_FORMAT && parsed.format !== 'loyalty-pro-license-codes-v1') return { codes: [], unlocks: [] };
    return { codes: strings(parsed.codes), unlocks: strings(parsed.unlocks) };
  } catch {
    return { codes: [], unlocks: [] };
  }
}

function writeMirror(mirror: Mirror): void {
  try {
    const path = mirrorFile();
    mkdirSync(dirname(path), { recursive: true });
    const partial = `${path}.partial`;
    writeFileSync(partial, JSON.stringify({ format: MIRROR_FORMAT, ...mirror }, null, 2), 'utf8');
    renameSync(partial, path);
  } catch (error) {
    log('licence: the mirror of activated codes could not be written', { error: String(error) });
  }
}

async function storedCodes(): Promise<Mirror> {
  const [codes, unlocks] = await Promise.all([
    prisma.licenseActivation.findMany({ select: { code: true } }),
    prisma.licenseUnlock.findMany({ select: { code: true } }),
  ]);
  return { codes: codes.map((r) => r.code), unlocks: unlocks.map((r) => r.code) };
}

async function refreshMirror(): Promise<void> {
  writeMirror(await storedCodes());
}

function activationData(license: LicenseInfo, code: string, merchantId: string, userId: string | null) {
  return {
    merchantId,
    licenseId: license.licenseId,
    kind: license.kind,
    deviceId: license.deviceId,
    issuedAt: new Date(license.issuedAt * 1000),
    expiresAt: license.expiresAt ? new Date(license.expiresAt * 1000) : null,
    features: JSON.stringify(license.features),
    note: license.note ?? null,
    code,
    activatedByUserId: userId,
  };
}

async function syncMirror(current: Installation): Promise<void> {
  const mirror = readMirror();
  const stored = await storedCodes();
  const knownCodes = new Set(stored.codes);
  const knownUnlocks = new Set(stored.unlocks);
  const storedIds = new Set(
    (await prisma.licenseActivation.findMany({ select: { licenseId: true } })).map((r) => r.licenseId),
  );
  const merchantId = (await firstMerchantId()) ?? 'installation';

  for (const code of mirror.codes) {
    if (knownCodes.has(code)) continue;
    const outcome = verifyLicense(code, current.deviceId);
    if (!outcome.ok || !outcome.license || !outcome.normalized) continue;
    if (storedIds.has(outcome.license.licenseId)) continue;
    await prisma.licenseActivation.create({ data: activationData(outcome.license, outcome.normalized, merchantId, null) });
    knownCodes.add(outcome.normalized);
    await recordEvent(AUDIT_ACTIONS.LICENSE_RESTORED_FROM_MIRROR, {
      licenseId: outcome.license.licenseId,
      kind: outcome.license.kind,
      expiresAt: iso(outcome.license.expiresAt),
    });
  }

  for (const code of mirror.unlocks) {
    if (knownUnlocks.has(code)) continue;
    const outcome = verifyUnlock(code, current.deviceId, nowSeconds(), current.latestSeen);
    if (!outcome.ok || !outcome.normalized || !outcome.validUntil) continue;
    await prisma.licenseUnlock.create({
      data: {
        merchantId,
        code: outcome.normalized,
        deviceId: current.deviceId,
        validUntil: new Date(outcome.validUntil * 1000),
      },
    });
    knownUnlocks.add(outcome.normalized);
    await recordEvent(AUDIT_ACTIONS.LICENSE_RESTORED_FROM_MIRROR, { emergencyUntil: iso(outcome.validUntil) });
  }

  writeMirror({ codes: [...knownCodes], unlocks: [...knownUnlocks] });
}

/* ── The installation: device ID and recorded time ──────────────────────────── */

async function loadInstallation(): Promise<Installation> {
  const identity = computeDeviceId();
  const stored = await prisma.installationState.findUnique({ where: { id: 1 } });

  let deviceId = identity.deviceId;
  if (!stored) {
    await prisma.installationState.create({
      data: {
        id: 1,
        deviceId,
        machineGuidDigest: identity.machineGuidDigest,
        volumeSerialDigest: identity.volumeSerialDigest,
        deviceComputedAt: new Date(),
      },
    });
    await recordEvent(AUDIT_ACTIONS.LICENSE_DEVICE_IDENTIFIED, { deviceId });
  } else {
    // The stored ID stays the ID. A replaced drive or a reinstalled Windows changes
    // the computed one; the rule is a warning in the trail, never a revoked licence.
    deviceId = stored.deviceId;
    const changed = [
      ...(stored.machineGuidDigest !== identity.machineGuidDigest ? ['machine_guid'] : []),
      ...(stored.volumeSerialDigest !== identity.volumeSerialDigest ? ['volume_serial'] : []),
    ];
    if (changed.length > 0) {
      await recordEvent(AUDIT_ACTIONS.LICENSE_DEVICE_SOURCES_CHANGED, {
        changed,
        storedDeviceId: stored.deviceId,
        computedDeviceId: identity.deviceId,
      });
      await prisma.installationState.update({
        where: { id: 1 },
        data: { machineGuidDigest: identity.machineGuidDigest, volumeSerialDigest: identity.volumeSerialDigest },
      });
      log('licence: the device ID sources changed; the stored device ID is kept', {
        changed,
        storedDeviceId: stored.deviceId,
        computedDeviceId: identity.deviceId,
      });
    }
  }

  // A licence-backed status recorded last time means a licence existed, whatever the
  // rows say now — so if they are gone, the trail can say so (`evaluateNow`).
  licenceSeen = stored?.lastStatus === 'PERPETUAL' || stored?.lastStatus === 'TRIAL';

  const readings = await readAnchors();
  const resolution = resolveAnchors([readings.database, readings.registry, readings.file]);
  const loaded: Installation = { deviceId, latestSeen: resolution.latest ?? null };

  await syncMirror(loaded);
  await mergeEventFile();
  if (resolution.conflict) {
    await recordEvent(AUDIT_ACTIONS.LICENSE_CLOCK_ANCHOR_CONFLICT, {
      database: iso(readings.database),
      registry: iso(readings.registry),
      file: iso(readings.file),
      chosen: iso(resolution.latest),
    });
  }
  await loadOpenEpisode();

  installation = loaded;
  await touch(true);
  return installation;
}

async function ensureInstallation(): Promise<Installation> {
  if (installation) return installation;
  if (!initialising) {
    initialising = loadInstallation().finally(() => {
      initialising = null;
    });
  }
  return initialising;
}

/* ── The clock record ───────────────────────────────────────────────────────── */

/** A clock episode left open by a previous run: the trail's last clock event is a rollback. */
async function loadOpenEpisode(): Promise<void> {
  const last = await prisma.auditLog.findFirst({
    where: { action: { in: [AUDIT_ACTIONS.LICENSE_CLOCK_ROLLBACK, AUDIT_ACTIONS.LICENSE_CLOCK_RESTORED] } },
    orderBy: { createdAt: 'desc' },
  });
  if (last?.action !== AUDIT_ACTIONS.LICENSE_CLOCK_ROLLBACK) {
    episode = null;
    return;
  }
  let latestSeen: number | null = null;
  try {
    const details = JSON.parse(last.afterJson ?? '{}') as { latestSeen?: string };
    latestSeen = details.latestSeen ? Math.floor(Date.parse(details.latestSeen) / 1000) : null;
  } catch {
    latestSeen = null;
  }
  episode = { eventId: last.entityId, latestSeen, sinceMono: null };
}

let keyCreatedAt: number | null = null;
function keyCreated(): number | null {
  if (keyCreatedAt === null) {
    try {
      keyCreatedAt = keyInfo().createdAt;
    } catch {
      return null;
    }
  }
  return keyCreatedAt;
}

/**
 * Records a clock set back, with what is needed to tell a merchant who wound it back
 * from one whose CMOS battery died — and records it again when it is put right.
 *
 * Runs on every check and whatever the licence: a perpetual licence ignores the clock,
 * but the event is still evidence, and still recorded.
 */
async function observeClock(rollbackBy: number | null, latestSeen: number | null, status: LicenseStatusName): Promise<void> {
  const wall = Date.now();
  const mono = performance.now();
  // Wall-clock time that went BACKWARD while monotonic time went forward: somebody
  // changed the date while this was running.
  const jumpedBack = checks > 0 && lastWallMs + (mono - lastMonoMs) - wall > TOLERANCE_SECONDS * 1000;
  lastWallMs = wall;
  lastMonoMs = mono;
  const now = Math.floor(wall / 1000);

  if (rollbackBy && !episode) {
    const created = keyCreated();
    const implausible = (created !== null && now < created) || new Date(wall).getUTCFullYear() < 2020;
    const cause: ClockRollbackCause = implausible
      ? 'FIRMWARE_RESET'
      : jumpedBack
        ? 'CHANGED_WHILE_RUNNING'
        : 'SET_BACK_WHILE_OFF';
    let uptime: number | null = null;
    try {
      uptime = uptimeSeconds();
    } catch {
      uptime = null;
    }
    const previousRollbacks = await prisma.auditLog
      .count({ where: { action: AUDIT_ACTIONS.LICENSE_CLOCK_ROLLBACK } })
      .catch(() => 0);
    const eventId = await recordEvent(AUDIT_ACTIONS.LICENSE_CLOCK_ROLLBACK, {
      cause,
      behindMinutes: Math.ceil(rollbackBy / 60),
      systemTime: new Date(wall).toISOString(),
      latestSeen: iso(latestSeen),
      phase: checks === 0 ? 'startup' : 'running',
      windowsUptimeMinutes: uptime === null ? null : Math.floor(uptime / 60),
      previousRollbacks,
      licenceStatus: status,
      stoppedSales: status === 'TAMPERED',
    });
    episode = { eventId, latestSeen, sinceMono: mono };
    refusedDuringEpisode = 0;
    log('licence: the clock is behind the latest recorded time', { cause, behindMinutes: Math.ceil(rollbackBy / 60) });
  } else if (!rollbackBy && episode) {
    const durationMinutes =
      episode.sinceMono !== null
        ? Math.round((mono - episode.sinceMono) / 60_000)
        : episode.latestSeen !== null
          ? Math.max(0, Math.round((now - episode.latestSeen) / 60))
          : null;
    await recordEvent(AUDIT_ACTIONS.LICENSE_CLOCK_RESTORED, {
      rollbackEventId: episode.eventId,
      durationMinutes,
      refusedDuring: refusedDuringEpisode,
      systemTime: new Date(wall).toISOString(),
    });
    log('licence: the clock is back in line', { durationMinutes });
    episode = null;
    refusedDuringEpisode = 0;
  }
  checks += 1;
}

/* ── Status ─────────────────────────────────────────────────────────────────── */

function toState(result: NativeStatus, deviceId: string): LicenseState {
  const license = result.license ?? null;
  const basis = result.basis ?? null;
  return {
    status: result.status,
    readOnly: result.readOnly,
    deviceId,
    kind: license ? (license.kind as 'trial' | 'perpetual') : null,
    basis,
    licenseId: license?.licenseId ?? null,
    issuedAt: iso(license?.issuedAt),
    expiresAt: iso(result.expiresAt ?? license?.expiresAt),
    graceEndsAt: iso(result.graceEndsAt),
    daysLeft: result.daysLeft ?? null,
    warning: result.warning,
    emergencyUntil: iso(result.emergencyUntil),
    clockBehindMinutes: result.clockBehindBy ? Math.ceil(result.clockBehindBy / 60) : null,
    storedLicenseInvalid: result.status === 'TAMPERED' && !license && result.invalidCodes > 0,
    degraded: false,
    degradedUntil: null,
    heldAtStations: null,
    // An emergency window over a destroyed licence keeps every feature: the shop's
    // Drive backups must not stop because its licence file did.
    features: license?.features ?? (basis === 'emergency' ? [...LICENSE_FEATURES] : []),
    note: license?.note ?? null,
  };
}

/** Records what the trail must know about stored codes, once per change rather than per request. */
async function noteStoredCodes(result: NativeStatus): Promise<void> {
  const invalid = result.invalidCodes + result.invalidUnlocks;
  if (invalid > 0 && !reportedInvalidCodes) {
    await recordEvent(AUDIT_ACTIONS.LICENSE_STORED_CODE_INVALID, {
      invalidCodes: result.invalidCodes,
      invalidUnlocks: result.invalidUnlocks,
      status: result.status,
    });
    log('licence: a stored code failed its own check', { status: result.status });
  }
  reportedInvalidCodes = invalid > 0;
}

let rememberWrite: Promise<void> | null = null;
let rememberedAt = 0;

/**
 * The last status, kept for the moment the check itself fails. Written when it changes,
 * and every ten minutes while it holds: `lastStatusAt` is when the module last confirmed
 * it, and the fallback trusts a time-limited status for a week from then, no longer.
 *
 * Claimed in memory before the write, so ten checks arriving together write once; and
 * not awaited, because this runs at the top of every scan. An awaited write here put
 * every concurrent scan behind SQLite's single writer, spread their arrival at the
 * invoice apart, and turned "another station claimed it" answers into replays of the
 * winner's result (concurrency.test.ts caught it). `degradedState` waits for it instead.
 */
function rememberStatus(state: LicenseState): void {
  const until = state.status === 'PERPETUAL' ? null : state.graceEndsAt;
  const key = `${state.status}|${until ?? ''}`;
  if (key === rememberedStatus && Date.now() - rememberedAt < TOUCH_INTERVAL_MS) return;
  rememberedStatus = key;
  rememberedAt = Date.now();
  rememberWrite = prisma.installationState
    .update({
      where: { id: 1 },
      data: { lastStatus: state.status, lastStatusUntil: until ? new Date(until) : null, lastStatusAt: new Date() },
    })
    .then(() => undefined)
    .catch(() => {
      rememberedStatus = null;
      rememberedAt = 0;
    });
}

async function evaluateNow(): Promise<LicenseState> {
  if (failureForTests) throw failureForTests;
  const current = await ensureInstallation();
  await touch();
  const stored = await storedCodes();
  const result = evaluateStatus(stored.codes, stored.unlocks, current.deviceId, nowSeconds(), current.latestSeen);
  const state = toState(result, current.deviceId);
  await observeClock(result.clockRollbackBy ?? null, current.latestSeen, state.status);
  await noteStoredCodes(result);
  // The licence vanished — rows deleted, a corrupted file, a restore of a copy older than
  // the mirror. Not a refusal of anything: a line for the provider, who otherwise sees
  // only "unlicensed" and cannot tell a shop that never paid from one that lost its file.
  if (licenceSeen && stored.codes.length === 0) {
    await recordEvent(AUDIT_ACTIONS.LICENSE_LOST, { status: state.status, emergencyActive: state.status === 'EMERGENCY' });
  }
  licenceSeen = stored.codes.length > 0;
  rememberStatus(state);
  return state;
}

/* ── The fallback: when the check itself fails ─────────────────────────────── */

/*
  The clock record, without the module. Deleting the module must not also delete the
  gate's sense of time — otherwise removing it and winding the clock back would stretch a
  trial for ever. The database and the data-folder file are plain enough to read and
  write from here; the registry value is the module's, and the fallback does without it.
*/

function readAnchorFileDirect(): number | null {
  try {
    const [header, value] = readFileSync(anchorFile(), 'utf8').trim().split(/\s+/);
    if (header !== ANCHOR_HEADER || !value) return null;
    const seconds = Number.parseInt(value, 10);
    return Number.isSafeInteger(seconds) ? seconds : null;
  } catch {
    return null;
  }
}

function writeAnchorFileDirect(value: number): void {
  const path = anchorFile();
  mkdirSync(dirname(path), { recursive: true });
  // Opened in place, never created over: Windows refuses to create over a hidden file,
  // and the module marks this one hidden (anchors.rs, `write_file`).
  let fd: number;
  try {
    fd = openSync(path, 'r+');
  } catch {
    fd = openSync(path, 'w');
  }
  try {
    ftruncateSync(fd, 0);
    writeSync(fd, `${ANCHOR_HEADER} ${value}\n`, 0, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

let lastFallbackTouchAt = 0;

/**
 * Moves the recorded time forward while the module is out, as `touch` does while it is
 * in: time spent without the module still counts. Never backward, and never while the
 * clock is behind the record.
 */
async function touchWithoutModule(recorded: number | null): Promise<void> {
  const now = nowSeconds();
  if (recorded !== null && now <= recorded) return;
  if (Date.now() - lastFallbackTouchAt < TOUCH_INTERVAL_MS) return;
  lastFallbackTouchAt = Date.now();
  if (installation) installation.latestSeen = Math.max(installation.latestSeen ?? 0, now);
  const at = new Date(now * 1000);
  await prisma.installationState
    .updateMany({ where: { id: 1, OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: at } }] }, data: { lastSeenAt: at } })
    .catch((error: unknown) => log('licence: the recorded time could not be moved on', { error: String(error) }));
  try {
    writeAnchorFileDirect(Math.max(now, readAnchorFileDirect() ?? 0));
  } catch (error) {
    log('licence: the file clock anchor could not be written without the module', { error: String(error) });
  }
}

interface FallbackVerdict {
  working: boolean;
  /** When the fallback stops recording, for a time-limited status. */
  until: number | null;
  /** The status the screens show. */
  shown: LicenseStatusName;
}

/**
 * What the last status the module recorded may still authorise while it cannot check.
 * Never more than the module itself would allow; often less.
 *
 *  - **PERPETUAL** — recording, until the module is back. The clock is ignored, as the
 *    module ignores it for a perpetual licence: there is no end to stretch, and the only
 *    way to have PERPETUAL recorded is for the module to have verified a perpetual
 *    licence here.
 *  - **TRIAL, EMERGENCY, GRACE** — recording until the EARLIER of the end the module
 *    recorded (grace included) and `FALLBACK_DAYS` after it last confirmed the status;
 *    judged by the later of the clock and the recorded time, and refused outright while
 *    the clock sits behind that record. Removing the module never adds a day.
 *  - **Anything else** — a read-only status, a time-limited one with no recorded end, or
 *    no record at all — authorises nothing.
 */
function fallbackVerdict(
  status: LicenseStatusName,
  recordedEnd: number | null,
  confirmedAt: number | null,
  now: number,
  recorded: number | null,
  behind: number | null,
): FallbackVerdict {
  if (status === 'PERPETUAL') return { working: true, until: null, shown: 'PERPETUAL' };
  if (!TIME_LIMITED.has(status)) return { working: false, until: null, shown: status };
  if (recordedEnd === null || confirmedAt === null) return { working: false, until: null, shown: 'EXPIRED' };
  const until = Math.min(recordedEnd, confirmedAt + FALLBACK_DAYS * DAY_SECONDS);
  if (behind !== null) return { working: false, until, shown: 'TAMPERED' };
  return Math.max(now, recorded ?? now) < until
    ? { working: true, until, shown: status }
    : { working: false, until, shown: 'EXPIRED' };
}

const toSeconds = (value: Date | null | undefined): number | null =>
  value ? Math.floor(value.getTime() / 1000) : null;

/**
 * When the check itself fails — the module is missing or corrupt, a bug — the gate does
 * not guess and does not stop. It applies `fallbackVerdict` to the last status the module
 * recorded: a paid shop keeps trading, a running trial or emergency window gets at most a
 * week and never past its own end, a read-only copy stays read-only. Every screen says
 * so in red. Deleting the module is not a way to get a licence, and a bug in it is not a
 * way to lose one.
 */
async function degradedState(error: unknown): Promise<LicenseState> {
  await rememberWrite;
  const last = await prisma.installationState.findUnique({ where: { id: 1 } }).catch(() => null);
  const status = (last?.lastStatus ?? 'UNLICENSED') as LicenseStatusName;
  const now = nowSeconds();

  // The latest time recorded anywhere this can read without the module.
  const readings = [toSeconds(last?.lastSeenAt), readAnchorFileDirect(), installation?.latestSeen ?? null].filter(
    (value): value is number => value !== null,
  );
  const recorded = readings.length > 0 ? Math.max(...readings) : null;
  const behind = recorded !== null && now + TOLERANCE_SECONDS < recorded ? recorded - now : null;

  const verdict = fallbackVerdict(
    status,
    toSeconds(last?.lastStatusUntil),
    toSeconds(last?.lastStatusAt),
    now,
    recorded,
    behind,
  );
  if (behind === null) await touchWithoutModule(recorded);

  if (Date.now() - lastCheckFailedRecordedAt > CHECK_FAILED_RECORD_INTERVAL_MS) {
    lastCheckFailedRecordedAt = Date.now();
    log('licence: the check failed; the last recorded status is used', {
      error: String(error),
      status,
      working: verdict.working,
    });
    await recordEvent(AUDIT_ACTIONS.LICENSE_CHECK_FAILED, {
      error: String(error).slice(0, 300),
      lastStatus: status,
      lastStatusAt: last?.lastStatusAt?.toISOString() ?? null,
      trading: verdict.working,
      tradingUntil: iso(verdict.until),
      clockBehindMinutes: behind ? Math.ceil(behind / 60) : null,
    }).catch(() => undefined);
  }

  const recordedEnd = iso(toSeconds(last?.lastStatusUntil));
  return {
    status: verdict.shown,
    readOnly: !verdict.working,
    deviceId: last?.deviceId ?? installation?.deviceId ?? '—',
    kind: null,
    basis: null,
    licenseId: null,
    issuedAt: null,
    expiresAt: recordedEnd,
    graceEndsAt: recordedEnd,
    daysLeft:
      verdict.working && verdict.until !== null ? Math.max(0, Math.ceil((verdict.until - now) / DAY_SECONDS)) : null,
    warning: 'urgent',
    emergencyUntil: null,
    clockBehindMinutes: behind ? Math.ceil(behind / 60) : null,
    storedLicenseInvalid: false,
    degraded: true,
    degradedUntil: verdict.working ? iso(verdict.until) : null,
    heldAtStations: null,
    features: verdict.working ? [...LICENSE_FEATURES] : [],
    note: null,
  };
}

/** The licence status now. Never throws: a failing check answers with `degradedState`. */
export async function licenseState(): Promise<LicenseState> {
  try {
    return await evaluateNow();
  } catch (error) {
    return degradedState(error);
  }
}

function humanDelay(minutes: number): string {
  if (minutes < 120) return `${minutes} دقيقة`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} ساعة`;
  return `${Math.round(minutes / 1440)} يوماً`;
}

const EMERGENCY_HINT = 'وإن تعذّر ذلك الآن، فاتصل بالمزوّد ليقرأ لك رمز طوارئ يعيد التشغيل الكامل فوراً.';

/** The sentence a refused sale, registration or redemption carries. */
export function readOnlyMessage(state: LicenseState): string {
  // No emergency-code hint here: a phone code is checked by the module, so it cannot be
  // entered until the program is reinstalled.
  if (state.degraded && state.clockBehindMinutes) {
    return (
      `لم تُسجَّل العملية: وحدة التحقق من الترخيص لا تعمل على جهاز المدير، وتاريخه ووقته متأخران عن آخر وقت سجّله البرنامج بنحو ${humanDelay(state.clockBehindMinutes)}. ` +
      'صحّح التاريخ والوقت في Windows، ثم أعد تثبيت البرنامج من ملف التثبيت الكامل. البيانات سليمة.'
    );
  }
  if (state.degraded) {
    return (
      'لم تُسجَّل العملية: وحدة التحقق من الترخيص لا تعمل على جهاز المدير، وآخر حالة سجّلتها لا تسمح بالتسجيل الآن. ' +
      'البيانات سليمة. أعد تثبيت البرنامج على جهاز المدير من ملف التثبيت الكامل — يُقرأ الترخيص المحفوظ بعدها كما هو.'
    );
  }
  switch (state.status) {
    case 'UNLICENSED':
      return (
        'لم تُسجَّل العملية: البرنامج غير مفعّل، فهو يعمل الآن للقراءة فقط — التقارير والزبائن والنسخ الاحتياطي متاحة كاملة. ' +
        'يُفعَّل من «الإعدادات ← الترخيص» على جهاز المدير، ' +
        EMERGENCY_HINT
      );
    case 'EXPIRED':
      return (
        'لم تُسجَّل العملية: انتهت الفترة التجريبية ومهلتها، فالبرنامج يعمل الآن للقراءة فقط — التقارير والزبائن والنسخ الاحتياطي متاحة كاملة. ' +
        'يُفعَّل برمز جديد من «الإعدادات ← الترخيص» على جهاز المدير، ' +
        EMERGENCY_HINT
      );
    case 'TAMPERED':
      if (state.storedLicenseInvalid) {
        return (
          'لم تُسجَّل العملية: بيانات الترخيص المحفوظة على جهاز المدير لا تطابق توقيعها. البيانات المسجّلة سليمة. ' +
          'أعد لصق رمز التفعيل في «الإعدادات ← الترخيص»، ' +
          EMERGENCY_HINT
        );
      }
      return (
        `لم تُسجَّل العملية: تاريخ جهاز المدير ووقته متأخران عن آخر وقت سجّله البرنامج${
          state.clockBehindMinutes ? ` بنحو ${humanDelay(state.clockBehindMinutes)}` : ''
        }. صحّح التاريخ والوقت في Windows على جهاز المدير — يعود التسجيل تلقائياً فور تصحيحهما، ` +
        EMERGENCY_HINT
      );
    default:
      return 'لم تُسجَّل العملية.';
  }
}

export type RecordingAction = 'SALE' | 'NEW_CUSTOMER' | 'VOUCHER_REDEMPTION';

/**
 * Whether a sale queued offline happened while recording was allowed. Judged by when it
 * happened (the till's own time, capped at now, honoured up to 30 days back) against
 * every licence and emergency code stored — a sale made while licensed was made while
 * licensed, whenever the till reconnects.
 */
async function allowedWhenItHappened(action: RecordingAction, occurredAt: Date, state: LicenseState): Promise<boolean> {
  const nowMs = Date.now();
  const t = Math.min(occurredAt.getTime(), nowMs);
  if (Number.isNaN(t) || nowMs - t > OCCURRENCE_WINDOW_DAYS * DAY_MS) return false;
  try {
    const current = await ensureInstallation();
    const stored = await storedCodes();
    if (!recordingAllowed(stored.codes, stored.unlocks, current.deviceId, Math.floor(t / 1000))) return false;
    const merchantId = await firstMerchantId();
    if (merchantId) {
      await recordAudit({
        merchantId,
        actorUserId: null,
        action: AUDIT_ACTIONS.LICENSE_ACCEPTED_BY_OCCURRENCE,
        entityType: 'license',
        entityId: action,
        after: { action, occurredAt: new Date(t).toISOString(), statusNow: state.status },
      }).catch(() => undefined);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuses a new sale, a new customer or a voucher redemption when read-only.
 *
 * Called at the top of those three services — so the Station's direct requests and the
 * replay of its offline queue meet the same check. `occurredAt` is set by the replay:
 * a queued item is accepted if recording was allowed when it happened OR is allowed
 * now. Anything refused reports as FAILED, which the Station does not settle — it stays
 * queued and is sent again, rather than being lost.
 */
export async function assertCanRecord(action: RecordingAction, options: { occurredAt?: Date } = {}): Promise<void> {
  const state = await licenseState();
  if (!state.readOnly) return;
  if (options.occurredAt && (await allowedWhenItHappened(action, options.occurredAt, state))) return;
  if (episode) refusedDuringEpisode += 1;
  throw new AppError('LICENSE_READ_ONLY', readOnlyMessage(state), {
    details: { status: state.status, action, degraded: state.degraded },
  });
}

/**
 * For the operations read-only does NOT refuse — card batches and invoice capture:
 * the status is still evaluated, and a read-only one is noted in the log.
 */
export async function observeLicense(
  requestLog: { info: (object: Record<string, unknown>, message: string) => void },
  action: 'CARD_BATCH' | 'INVOICE_CAPTURE',
): Promise<void> {
  const state = await licenseState();
  if (state.readOnly) {
    requestLog.info({ licenceStatus: state.status, action }, 'allowed while the licence is read-only');
  }
}

/** Whether the governing licence grants `feature`. */
export async function licensedFeature(feature: LicenseFeature): Promise<boolean> {
  const state = await licenseState();
  return state.features.includes(feature);
}

/* ── Activation ─────────────────────────────────────────────────────────────── */

const REFUSALS: Record<Exclude<LicenseRefusalReason, 'DEVICE_MISMATCH' | 'EXPIRED_CODE'>, string> = {
  MALFORMED:
    'هذا ليس رمز تفعيل كاملاً — تأكّد أنك نسخت رسالة المزوّد كاملة، من أول سطر في الرمز إلى آخر سطر، ثم الصقها هنا.',
  BAD_SIGNATURE:
    'هذا الرمز لا يطابق توقيع مزوّد البرنامج — إمّا تغيّر فيه حرف أثناء النسخ، أو لم يصدر من المزوّد. انسخه من الرسالة كما هو دون تعديل وأعد المحاولة.',
  UNSUPPORTED_VERSION:
    'هذا الرمز صادر بصيغة أحدث مما يقرؤه هذا الإصدار من البرنامج — حدّث البرنامج على هذا الجهاز، ثم فعّله بالرمز نفسه.',
  CLOCK_BEHIND:
    'تاريخ هذا الجهاز أقدم من تاريخ إصدار الرمز — صحّح التاريخ والوقت في Windows، ثم أعد التفعيل.',
  PERPETUAL_ACTIVE: 'هذا الجهاز مفعّل بترخيص دائم، فلا حاجة لهذا الرمز التجريبي — لم يتغيّر شيء.',
};

const dateOnly = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);

async function entryFor(row: {
  licenseId: string;
  kind: string;
  activatedAt: Date;
  issuedAt: Date;
  expiresAt: Date | null;
  features: string;
  note: string | null;
  activatedByUserId: string | null;
}): Promise<LicenseActivationEntry> {
  const user = row.activatedByUserId
    ? await prisma.user.findUnique({ where: { id: row.activatedByUserId }, select: { name: true } })
    : null;
  let features: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.features);
    features = Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === 'string') : [];
  } catch {
    features = [];
  }
  return {
    licenseId: row.licenseId,
    kind: row.kind === 'perpetual' ? 'perpetual' : 'trial',
    activatedAt: row.activatedAt.toISOString(),
    issuedAt: row.issuedAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    features,
    note: row.note,
    activatedByName: user?.name ?? null,
  };
}

/**
 * Activates a pasted code. Every attempt, refused or not, is recorded with its reason;
 * the status changes the moment this returns — no restart.
 */
export async function activateLicense(
  actor: { merchantId: string; userId: string | null },
  rawCode: string,
): Promise<ActivateLicenseResponse> {
  const current = await ensureInstallation();
  const outcome = verifyLicense(rawCode, current.deviceId);
  const now = nowSeconds();

  const refuse = async (
    reason: LicenseRefusalReason,
    message: string,
    extra: Record<string, unknown> = {},
  ): Promise<AppError> => {
    await recordEvent(AUDIT_ACTIONS.LICENSE_ACTIVATION_FAILED, { reason, deviceId: current.deviceId, ...extra }, actor);
    return new AppError('LICENSE_INVALID', message, { details: { reason, ...extra } });
  };

  if (!outcome.ok || !outcome.license || !outcome.normalized) {
    switch (outcome.reason) {
      case 'DEVICE_MISMATCH':
        throw await refuse(
          'DEVICE_MISMATCH',
          `هذا الرمز صادر لجهاز آخر (${outcome.licensedDevice ?? '—'})، ورقم هذا الجهاز ${current.deviceId}. أرسل رقم هذا الجهاز إلى المزوّد ليصدر رمزاً له.`,
          { licensedDevice: outcome.licensedDevice ?? null },
        );
      case 'BAD_SIGNATURE':
        throw await refuse('BAD_SIGNATURE', REFUSALS.BAD_SIGNATURE);
      case 'UNSUPPORTED_VERSION':
        throw await refuse('UNSUPPORTED_VERSION', REFUSALS.UNSUPPORTED_VERSION, { version: outcome.version ?? null });
      default:
        throw await refuse('MALFORMED', REFUSALS.MALFORMED);
    }
  }

  const license = outcome.license;
  const code = outcome.normalized;

  if (license.kind === 'trial') {
    if (now + TOLERANCE_SECONDS < license.issuedAt) {
      throw await refuse('CLOCK_BEHIND', REFUSALS.CLOCK_BEHIND, { licenseId: license.licenseId });
    }
    if (license.expiresAt && license.expiresAt <= now) {
      throw await refuse(
        'EXPIRED_CODE',
        `انتهت مدة هذا الرمز في ${dateOnly(license.expiresAt)}، فلا يضيف شيئاً — اطلب من المزوّد رمزاً جديداً.`,
        { licenseId: license.licenseId },
      );
    }
  }

  const existing = await prisma.licenseActivation.findUnique({ where: { licenseId: license.licenseId } });
  if (existing) {
    await recordEvent(AUDIT_ACTIONS.LICENSE_ACTIVATED, { kind: license.kind, repeat: true }, actor);
    return { state: await licenseState(), activation: await entryFor(existing), alreadyActive: true };
  }

  const before = await licenseState();
  if (before.kind === 'perpetual' && license.kind === 'trial') {
    throw await refuse('PERPETUAL_ACTIVE', REFUSALS.PERPETUAL_ACTIVE, { licenseId: license.licenseId });
  }

  const row = await prisma.licenseActivation.create({
    data: activationData(license, code, actor.merchantId, actor.userId),
  });
  await refreshMirror();

  // The vendor's clock signed this code. A recorded time well after the moment it was
  // issued is not a time this machine can have seen — the clock once ran in the future
  // — and it would otherwise keep the shop TAMPERED until that date comes round.
  if (current.latestSeen !== null && current.latestSeen > license.issuedAt + TOLERANCE_SECONDS) {
    const was = current.latestSeen;
    current.latestSeen = Math.max(now, license.issuedAt);
    await writeAnchors(current.latestSeen);
    await recordEvent(
      AUDIT_ACTIONS.LICENSE_CLOCK_ANCHOR_RESET,
      { was: iso(was), issuedAt: iso(license.issuedAt), now: iso(current.latestSeen), licenseId: license.licenseId },
      actor,
    );
  }

  await recordEvent(
    AUDIT_ACTIONS.LICENSE_ACTIVATED,
    {
      licenseId: license.licenseId,
      kind: license.kind,
      expiresAt: iso(license.expiresAt),
      features: license.features,
      deviceId: license.deviceId,
    },
    actor,
  );

  return { state: await licenseState(), activation: await entryFor(row), alreadyActive: false };
}

/* ── Emergency codes read over the phone ────────────────────────────────────── */

const UNLOCK_REFUSALS: Record<Exclude<UnlockRefusalReason, 'NOT_VALID' | 'EXPIRED'>, string> = {
  MALFORMED:
    'رمز الطوارئ خمسة عشر حرفاً ورقماً في ثلاث مجموعات من خمسة — تأكّد أنك كتبته كاملاً كما قرأه المزوّد.',
  TYPO: 'في الرمز حرف مكتوب خطأً — اطلب من المزوّد أن يعيد قراءته، وقارن المجموعات الثلاث حرفاً حرفاً.',
};

/**
 * Enters an emergency code the provider read over the phone. Full operation returns
 * with this request — whatever else is wrong — until the code's window ends.
 */
export async function enterUnlock(
  actor: { merchantId: string; userId: string | null },
  rawCode: string,
): Promise<EnterUnlockResponse> {
  const current = await ensureInstallation();
  const outcome = verifyUnlock(rawCode, current.deviceId, nowSeconds(), current.latestSeen);

  if (!outcome.ok || !outcome.normalized || !outcome.validUntil) {
    const reason = (outcome.reason ?? 'MALFORMED') as UnlockRefusalReason;
    const message =
      reason === 'NOT_VALID'
        ? `هذا الرمز ليس لهذا الجهاز — تأكّد أن المزوّد أصدره لرقم الجهاز ${current.deviceId}، ثم اطلب منه إعادة قراءته.`
        : reason === 'EXPIRED'
          ? `انتهت مدة هذا الرمز${outcome.validUntil ? ` في ${dateOnly(outcome.validUntil)}` : ''} — اطلب من المزوّد رمزاً جديداً.`
          : UNLOCK_REFUSALS[reason];
    await recordEvent(AUDIT_ACTIONS.LICENSE_UNLOCK_FAILED, { reason, deviceId: current.deviceId }, actor);
    throw new AppError('LICENSE_INVALID', message, { details: { reason } });
  }

  const validUntil = new Date(outcome.validUntil * 1000).toISOString();
  const existing = await prisma.licenseUnlock.findUnique({ where: { code: outcome.normalized } });
  if (existing) {
    return { state: await licenseState(), validUntil, alreadyEntered: true };
  }

  await prisma.licenseUnlock.create({
    data: {
      merchantId: actor.merchantId,
      code: outcome.normalized,
      deviceId: current.deviceId,
      validUntil: new Date(validUntil),
      enteredByUserId: actor.userId,
    },
  });
  await refreshMirror();
  await recordEvent(AUDIT_ACTIONS.LICENSE_UNLOCK_ENTERED, { validUntil, deviceId: current.deviceId }, actor);

  return { state: await licenseState(), validUntil, alreadyEntered: false };
}

export async function licenseOverview(): Promise<LicenseOverview> {
  const state = await licenseState();
  const rows = await prisma.licenseActivation.findMany({ orderBy: { activatedAt: 'desc' } });
  return { state, activations: await Promise.all(rows.map(entryFor)) };
}

const EVENT_TYPES: ReadonlySet<string> = new Set(LICENSE_EVENT_TYPES);

/** Every licence event recorded here, newest first — the file merged in first. */
export async function listLicenseEvents(): Promise<LicenseEventsResponse> {
  await mergeEventFile().catch(() => 0);
  const rows = await prisma.auditLog.findMany({
    where: { action: { startsWith: 'license.' } },
    orderBy: { createdAt: 'desc' },
    take: 500,
    include: { actor: { select: { name: true } } },
  });
  const events: LicenseEvent[] = rows.flatMap((row) => {
    const type = row.action.slice('license.'.length).toUpperCase();
    if (!EVENT_TYPES.has(type)) return [];
    let details: Record<string, unknown> = {};
    try {
      details = JSON.parse(row.afterJson ?? '{}') as Record<string, unknown>;
    } catch {
      details = {};
    }
    return [{ id: row.id, type: type as LicenseEventType, at: row.createdAt.toISOString(), actorName: row.actor?.name ?? null, details }];
  });
  const clockRollbacks = await prisma.auditLog.count({ where: { action: AUDIT_ACTIONS.LICENSE_CLOCK_ROLLBACK } });
  return { events, clockRollbacks };
}

/* ── Start-up ───────────────────────────────────────────────────────────────── */

/**
 * Called by `main.ts` once the database is open. Logs the device, the key and the
 * status. Never throws: a licensing module that will not load must not keep the shop's
 * service — and its data — from starting.
 */
export async function initLicensing(bootLog: Log): Promise<LicenseState> {
  log = bootLog;
  let key: { kind: string; fingerprint: string } | null = null;
  try {
    key = keyInfo();
  } catch (error) {
    bootLog('licence: the licensing module is unavailable — the gate uses the last recorded status', {
      error: String(error),
    });
  }
  const state = await licenseState();
  bootLog('licence', {
    status: state.status,
    deviceId: state.deviceId,
    degraded: state.degraded,
    key: key?.kind ?? 'unavailable',
    keyFingerprint: key?.fingerprint ?? null,
  });
  return state;
}

/**
 * Keeps the recorded time moving while the service runs, and runs `onTick` on the same
 * beat (the held-sales pass — injected, because that service imports this one). Returns
 * the stop function.
 */
export function startLicenseClock(onTick?: () => Promise<unknown>): () => void {
  const timer = setInterval(() => {
    void touch(true).catch((error: unknown) => log('licence: clock anchor refresh failed', { error: String(error) }));
    if (onTick) void onTick().catch((error: unknown) => log('licence: a periodic task failed', { error: String(error) }));
  }, TOUCH_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/* ── Test seams ─────────────────────────────────────────────────────────────── */

/** Forgets every cache, as a restart would: the next check re-reads the database and anchors. */
export function reloadLicensingForTests(): void {
  installation = null;
  initialising = null;
  lastTouchAt = 0;
  reportedInvalidCodes = false;
  rememberedStatus = null;
  rememberedAt = 0;
  rememberWrite = null;
  lastFallbackTouchAt = 0;
  checks = 0;
  lastWallMs = Date.now();
  lastMonoMs = performance.now();
  episode = null;
  refusedDuringEpisode = 0;
  lastCheckFailedRecordedAt = 0;
  failureForTests = null;
  licenceSeen = false;
}

/** As above, and removes the anchors, the mirror and the events file — a clean installation. */
export function resetLicensingForTests(): void {
  reloadLicensingForTests();
  for (const path of [anchorFile(), mirrorFile(), eventsFile()]) rmSync(path, { force: true });
  try {
    deleteRegistryKeyForTests(registryKey());
  } catch {
    /* Only the test build provides it; nothing else calls this. */
  }
}

/** Makes every check fail with `error` — a missing module, a bug — until cleared. */
export function failLicensingForTests(error: Error | null): void {
  failureForTests = error;
}

/** The events file's path — tests read it to prove events outlive the database. */
export function licenseEventsFileForTests(): string {
  return eventsFile();
}
