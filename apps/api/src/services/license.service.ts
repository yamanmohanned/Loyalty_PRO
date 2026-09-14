import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  computeDeviceId,
  deleteRegistryKeyForTests,
  keyInfo,
  licenseStatus as evaluateStatus,
  readFileAnchor,
  readRegistryAnchor,
  resolveAnchors,
  verifyLicense,
  writeFileAnchor,
  writeRegistryAnchor,
  type LicenseInfo,
  type LicenseStatus as NativeStatus,
} from '@walaa/license-native';
import type {
  ActivateLicenseResponse,
  LicenseActivationEntry,
  LicenseFeature,
  LicenseOverview,
  LicenseRefusalReason,
  LicenseState,
} from '@walaa/shared-types';
import { loadEnv } from '../config/env';
import { resolveDataDir } from '../config/paths';
import { AppError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { AUDIT_ACTIONS, recordAudit, type AuditAction } from './audit.service';

/**
 * Offline licensing, as the service applies it (packaging/LICENSING.md).
 *
 * ## Where the decisions are made
 *
 * Every decision about a licence is made in Rust (`@walaa/license-native`, built from
 * `crates/walaa-license`): computing the device ID, checking a code's signature
 * against the embedded public key, choosing the governing licence and evaluating its
 * status against the clock. This file stores codes and times, asks, and applies the
 * answer — on every sale, new customer and voucher redemption, here in the service,
 * because a lock in a screen is gone the moment somebody opens the API in a browser.
 *
 * ## What read-only means
 *
 * UNLICENSED, EXPIRED and TAMPERED refuse three things: linking a sale, registering a
 * customer, and redeeming a voucher. Nothing else. Reports, the customer list, card
 * history, exports, backups, restore tests and restores all keep working, and capturing
 * invoices from the register never stops — those invoices happened at the till and are
 * the merchant's record. The merchant's data is never withheld.
 *
 * ## The clock
 *
 * The latest time this installation has seen is kept in three places — the
 * `installation_state` table, `HKCU\Software\Walaa`, and a hidden file in the data
 * folder — written together, read together, the latest winning. A clock more than two
 * hours behind it is TAMPERED until corrected. A code issued later than that recorded
 * time, activated here, is proof the recorded time was wrong, and resets it.
 */

const PRODUCTION_REGISTRY_KEY = 'Software\\Walaa';
const ANCHOR_FILE = '.license-clock';
const MIRROR_FILE = 'license-codes.json';
const MIRROR_FORMAT = 'walaa-license-codes-v1';
const TOLERANCE_SECONDS = 2 * 3600;
const TOUCH_INTERVAL_MS = 10 * 60 * 1000;

type Log = (message: string, extra?: Record<string, unknown>) => void;

let log: Log = (message, extra = {}) => {
  process.stdout.write(`${JSON.stringify({ level: 30, time: Date.now(), ...extra, msg: message })}\n`);
};

interface Installation {
  deviceId: string;
  latestSeen: number | null;
}

let installation: Installation | null = null;
let initialising: Promise<Installation> | null = null;
let lastTouchAt = 0;
let lastStatus: string | null = null;
let reportedInvalidCodes = false;

const nowSeconds = (): number => Math.floor(Date.now() / 1000);
const iso = (seconds: number | null | undefined): string | null =>
  seconds === null || seconds === undefined ? null : new Date(seconds * 1000).toISOString();

function registryKey(): string {
  const env = loadEnv();
  return (env.NODE_ENV !== 'production' && env.WALAA_LICENSE_REGISTRY_KEY) || PRODUCTION_REGISTRY_KEY;
}

function licenseDirectory(): string {
  const env = loadEnv();
  return (env.NODE_ENV !== 'production' && env.WALAA_LICENSE_DIR) || resolveDataDir();
}

const anchorFile = (): string => join(licenseDirectory(), ANCHOR_FILE);
const mirrorFile = (): string => join(licenseDirectory(), MIRROR_FILE);

/** An audit row with no person behind it — against the installation's merchant, if there is one yet. */
async function auditSystem(action: AuditAction, entityId: string, after: Record<string, unknown>): Promise<void> {
  const merchant = await prisma.merchant.findFirst({ select: { id: true } }).catch(() => null);
  if (!merchant) return;
  await recordAudit({
    merchantId: merchant.id,
    actorUserId: null,
    action,
    entityType: 'license',
    entityId,
    after,
  }).catch(() => undefined);
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
  Every activated code is also kept in a file beside the clock anchor. A restore puts
  back an older database — possibly one from before the shop's licence was activated —
  and a restore must never cost the merchant his licence. On start, codes found in the
  file and not in the database are re-verified and put back. The codes are signed, so
  the file needs no secrecy: a code for another device fails its check.
*/

function readMirror(): string[] {
  try {
    const path = mirrorFile();
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { format?: string; codes?: unknown };
    if (parsed.format !== MIRROR_FORMAT || !Array.isArray(parsed.codes)) return [];
    return parsed.codes.filter((code): code is string => typeof code === 'string');
  } catch {
    return [];
  }
}

function writeMirror(codes: string[]): void {
  try {
    const path = mirrorFile();
    mkdirSync(dirname(path), { recursive: true });
    const partial = `${path}.partial`;
    writeFileSync(partial, JSON.stringify({ format: MIRROR_FORMAT, codes }, null, 2), 'utf8');
    renameSync(partial, path);
  } catch (error) {
    log('licence: the mirror of activated codes could not be written', { error: String(error) });
  }
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

async function syncMirror(deviceId: string): Promise<void> {
  const rows = await prisma.licenseActivation.findMany({ select: { code: true, licenseId: true } });
  const stored = new Set(rows.map((row) => row.code));
  const storedIds = new Set(rows.map((row) => row.licenseId));
  const merchant = await prisma.merchant.findFirst({ select: { id: true } });

  for (const code of readMirror()) {
    if (stored.has(code)) continue;
    const outcome = verifyLicense(code, deviceId);
    if (!outcome.ok || !outcome.license || !outcome.normalized) continue;
    if (storedIds.has(outcome.license.licenseId)) continue;
    await prisma.licenseActivation.create({
      data: activationData(outcome.license, outcome.normalized, merchant?.id ?? 'installation', null),
    });
    stored.add(outcome.normalized);
    await auditSystem(AUDIT_ACTIONS.LICENSE_RESTORED_FROM_MIRROR, outcome.license.licenseId, {
      kind: outcome.license.kind,
      expiresAt: iso(outcome.license.expiresAt),
    });
    log('licence: an activated code was put back from the mirror', { licenseId: outcome.license.licenseId });
  }

  writeMirror([...stored]);
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
    await auditSystem(AUDIT_ACTIONS.LICENSE_DEVICE_IDENTIFIED, deviceId, { deviceId });
  } else {
    // The stored ID stays the ID. A replaced drive or a reinstalled Windows changes
    // the computed one; the rule is a warning in the trail, never a revoked licence.
    deviceId = stored.deviceId;
    const changed = [
      ...(stored.machineGuidDigest !== identity.machineGuidDigest ? ['machine_guid'] : []),
      ...(stored.volumeSerialDigest !== identity.volumeSerialDigest ? ['volume_serial'] : []),
    ];
    if (changed.length > 0) {
      await auditSystem(AUDIT_ACTIONS.LICENSE_DEVICE_SOURCES_CHANGED, stored.deviceId, {
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

  await syncMirror(deviceId);

  const readings = await readAnchors();
  const resolution = resolveAnchors([readings.database, readings.registry, readings.file]);
  if (resolution.conflict) {
    await auditSystem(AUDIT_ACTIONS.LICENSE_CLOCK_ANCHOR_CONFLICT, 'clock', {
      database: iso(readings.database),
      registry: iso(readings.registry),
      file: iso(readings.file),
      chosen: iso(resolution.latest),
    });
  }

  installation = { deviceId, latestSeen: resolution.latest ?? null };
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

/* ── Status ─────────────────────────────────────────────────────────────────── */

function toState(result: NativeStatus, deviceId: string): LicenseState {
  const license = result.license ?? null;
  return {
    status: result.status,
    readOnly: result.readOnly,
    deviceId,
    kind: license ? (license.kind as 'trial' | 'perpetual') : null,
    licenseId: license?.licenseId ?? null,
    issuedAt: iso(license?.issuedAt),
    expiresAt: iso(result.expiresAt ?? license?.expiresAt),
    graceEndsAt: iso(result.graceEndsAt),
    daysLeft: result.daysLeft ?? null,
    showExpiryWarning: result.showExpiryWarning,
    clockBehindMinutes: result.clockBehindBy ? Math.ceil(result.clockBehindBy / 60) : null,
    storedLicenseInvalid: result.status === 'TAMPERED' && !license && result.invalidCodes > 0,
    features: license?.features ?? [],
    note: license?.note ?? null,
  };
}

/** Records what the trail must know about a status, once per change rather than per request. */
async function noteStatus(state: LicenseState, invalidCodes: number): Promise<void> {
  if (state.status === 'TAMPERED' && lastStatus !== 'TAMPERED') {
    if (state.storedLicenseInvalid) {
      await auditSystem(AUDIT_ACTIONS.LICENSE_STORED_CODE_INVALID, 'license', { invalidCodes });
    } else {
      await auditSystem(AUDIT_ACTIONS.LICENSE_CLOCK_ROLLBACK, 'clock', {
        behindMinutes: state.clockBehindMinutes,
        now: new Date().toISOString(),
      });
    }
    log('licence: TAMPERED — recording is refused until corrected', {
      storedLicenseInvalid: state.storedLicenseInvalid,
      clockBehindMinutes: state.clockBehindMinutes,
    });
  } else if (invalidCodes > 0 && !reportedInvalidCodes) {
    await auditSystem(AUDIT_ACTIONS.LICENSE_STORED_CODE_INVALID, 'license', { invalidCodes });
  }
  reportedInvalidCodes = invalidCodes > 0;
  lastStatus = state.status;
}

/**
 * The licence status now — every stored code re-verified in Rust, the governing one
 * evaluated against the clock and the latest recorded time.
 */
export async function licenseState(): Promise<LicenseState> {
  const current = await ensureInstallation();
  await touch();
  const rows = await prisma.licenseActivation.findMany({ select: { code: true } });
  const result = evaluateStatus(
    rows.map((row) => row.code),
    current.deviceId,
    nowSeconds(),
    current.latestSeen,
  );
  const state = toState(result, current.deviceId);
  await noteStatus(state, result.invalidCodes);
  return state;
}

function humanDelay(minutes: number): string {
  if (minutes < 120) return `${minutes} دقيقة`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} ساعة`;
  return `${Math.round(minutes / 1440)} يوماً`;
}

/** The sentence a refused sale, registration or redemption carries — to the till and the dashboard. */
export function readOnlyMessage(state: LicenseState): string {
  switch (state.status) {
    case 'UNLICENSED':
      return (
        'لم تُسجَّل العملية: البرنامج غير مفعّل بعد، فهو يعمل الآن للقراءة فقط — التقارير والزبائن والنسخ الاحتياطي متاحة كاملة. ' +
        'لتسجيل المبيعات يُفعَّل البرنامج من «الإعدادات ← الترخيص» على جهاز المدير.'
      );
    case 'EXPIRED':
      return (
        'لم تُسجَّل العملية: انتهت الفترة التجريبية ومهلتها، فالبرنامج يعمل الآن للقراءة فقط — التقارير والزبائن والنسخ الاحتياطي متاحة كاملة. ' +
        'لتسجيل المبيعات يُفعَّل البرنامج برمز جديد من «الإعدادات ← الترخيص» على جهاز المدير.'
      );
    case 'TAMPERED':
      if (state.storedLicenseInvalid) {
        return (
          'لم تُسجَّل العملية: بيانات الترخيص المحفوظة على جهاز المدير لا تطابق توقيعها، فتوقّف تسجيل العمليات الجديدة. ' +
          'أعد لصق رمز التفعيل في «الإعدادات ← الترخيص»، أو اطلب رمزاً من المزوّد. البيانات المسجّلة سليمة.'
        );
      }
      return (
        `لم تُسجَّل العملية: تاريخ جهاز المدير ووقته متأخران عن آخر وقت سجّله البرنامج${
          state.clockBehindMinutes ? ` بنحو ${humanDelay(state.clockBehindMinutes)}` : ''
        }، فتوقّف تسجيل العمليات الجديدة. ` +
        'صحّح التاريخ والوقت في Windows على جهاز المدير — يعود التسجيل تلقائياً فور تصحيحهما.'
      );
    default:
      return 'لم تُسجَّل العملية.';
  }
}

export type RecordingAction = 'SALE' | 'NEW_CUSTOMER' | 'VOUCHER_REDEMPTION';

/**
 * Refuses a new sale, a new customer or a voucher redemption when read-only.
 *
 * Called at the top of those three services — so the Station's direct requests and the
 * replay of its offline queue meet the same check. A refused queued item reports as
 * FAILED, which the Station does not settle: it stays queued and is sent again after
 * activation, rather than being lost.
 */
export async function assertCanRecord(action: RecordingAction): Promise<void> {
  const state = await licenseState();
  if (!state.readOnly) return;
  throw new AppError('LICENSE_READ_ONLY', readOnlyMessage(state), {
    details: { status: state.status, action },
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
 * Activates a pasted code. Every attempt, refused or not, is written to the audit trail
 * with its reason; the status changes the moment this returns — no restart.
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
    await recordAudit({
      merchantId: actor.merchantId,
      actorUserId: actor.userId,
      action: AUDIT_ACTIONS.LICENSE_ACTIVATION_FAILED,
      entityType: 'license',
      entityId: typeof extra.licenseId === 'string' ? extra.licenseId : 'unknown',
      after: { reason, deviceId: current.deviceId, ...extra },
    });
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
    await recordAudit({
      merchantId: actor.merchantId,
      actorUserId: actor.userId,
      action: AUDIT_ACTIONS.LICENSE_ACTIVATED,
      entityType: 'license',
      entityId: license.licenseId,
      after: { kind: license.kind, repeat: true },
    });
    return { state: await licenseState(), activation: await entryFor(existing), alreadyActive: true };
  }

  const before = await licenseState();
  if (before.kind === 'perpetual' && license.kind === 'trial') {
    throw await refuse('PERPETUAL_ACTIVE', REFUSALS.PERPETUAL_ACTIVE, { licenseId: license.licenseId });
  }

  const row = await prisma.licenseActivation.create({
    data: activationData(license, code, actor.merchantId, actor.userId),
  });
  const codes = await prisma.licenseActivation.findMany({ select: { code: true } });
  writeMirror(codes.map((c) => c.code));

  // The vendor's clock signed this code. A recorded time well after the moment it was
  // issued is not a time this machine can have seen — the clock once ran in the future
  // — and it would otherwise keep the shop TAMPERED until that date comes round.
  if (current.latestSeen !== null && current.latestSeen > license.issuedAt + TOLERANCE_SECONDS) {
    const was = current.latestSeen;
    current.latestSeen = Math.max(now, license.issuedAt);
    await writeAnchors(current.latestSeen);
    await recordAudit({
      merchantId: actor.merchantId,
      actorUserId: actor.userId,
      action: AUDIT_ACTIONS.LICENSE_CLOCK_ANCHOR_RESET,
      entityType: 'license',
      entityId: license.licenseId,
      after: { was: iso(was), issuedAt: iso(license.issuedAt), now: iso(current.latestSeen) },
    });
  }

  await recordAudit({
    merchantId: actor.merchantId,
    actorUserId: actor.userId,
    action: AUDIT_ACTIONS.LICENSE_ACTIVATED,
    entityType: 'license',
    entityId: license.licenseId,
    after: {
      kind: license.kind,
      expiresAt: iso(license.expiresAt),
      features: license.features,
      deviceId: license.deviceId,
    },
  });

  return { state: await licenseState(), activation: await entryFor(row), alreadyActive: false };
}

export async function licenseOverview(): Promise<LicenseOverview> {
  const state = await licenseState();
  const rows = await prisma.licenseActivation.findMany({ orderBy: { activatedAt: 'desc' } });
  return { state, activations: await Promise.all(rows.map(entryFor)) };
}

/* ── Start-up ───────────────────────────────────────────────────────────────── */

/** Called by `main.ts` once the database is open. Logs the device, the key and the status. */
export async function initLicensing(bootLog: Log): Promise<LicenseState> {
  log = bootLog;
  const key = keyInfo();
  const state = await licenseState();
  bootLog('licence', {
    status: state.status,
    deviceId: state.deviceId,
    key: key.kind,
    keyFingerprint: key.fingerprint,
  });
  return state;
}

/** Keeps the recorded time moving while the service runs. Returns the stop function. */
export function startLicenseClock(): () => void {
  const timer = setInterval(() => {
    void touch(true).catch((error: unknown) => log('licence: clock anchor refresh failed', { error: String(error) }));
  }, TOUCH_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/* ── Test seams ─────────────────────────────────────────────────────────────── */

/** Forgets the cached installation so the next check re-reads the database and anchors. */
export function reloadLicensingForTests(): void {
  installation = null;
  initialising = null;
  lastTouchAt = 0;
  lastStatus = null;
  reportedInvalidCodes = false;
}

/** As above, and removes the anchors and the mirror — a clean installation. */
export function resetLicensingForTests(): void {
  reloadLicensingForTests();
  rmSync(anchorFile(), { force: true });
  rmSync(mirrorFile(), { force: true });
  try {
    deleteRegistryKeyForTests(registryKey());
  } catch {
    /* Only the test build provides it; nothing else calls this. */
  }
}
