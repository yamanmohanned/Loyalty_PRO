import type { Prisma, PrismaClient } from '@prisma/client';
import {
  type ResolvedSettings,
  type SettingValue,
  type WritableSettingScope,
  resolveSettings,
  validateSettingValues,
  type SettingRejection,
} from '@loyalty-pro/shared-types';
import { prisma as defaultClient } from '../lib/prisma';
import { AUDIT_ACTIONS, recordAudit } from './audit.service';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  DRAFT → PUBLISH → ROLL BACK, AND THE LIVE VALUES ARE NEVER EDITED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PRD §4 point 3: «لا يسري التعديل إلا بعد «نشر»، مع معاينة حية … وإمكانية الرجوع
 * إلى إصدار سابق».
 *
 * ── Why a draft exists at all ────────────────────────────────────────────────
 *
 * The alternative — save each field as it is typed — means a manager half-way through
 * reconfiguring the station is running a shop on half of yesterday's settings and half
 * of tomorrow's. The states in between are not ones anybody chose, and some of them
 * are wrong in ways the endpoints are not: a lockout window raised before the attempt
 * count is lowered is a different policy from either.
 *
 * So editing writes to a draft nothing reads, and one deliberate act promotes the whole
 * set at once.
 *
 * ── Why versions are append-only ─────────────────────────────────────────────
 *
 * The live values ARE the highest version; there is no mutable "current" row to
 * disagree with the history. Rolling back copies an old version forward as a new one,
 * so the record keeps saying what was in force and when — which is the only form in
 * which it answers the question it gets asked, three weeks later, about a day that has
 * already gone wrong.
 *
 * It also means rollback is not a second code path. It is a publish whose values came
 * from a row instead of a draft, so it versions, audits and resolves identically.
 *
 * ── Why only the overridden keys are stored ──────────────────────────────────
 *
 * A layer stores the keys it overrides and nothing else. Writing the fully resolved
 * set would freeze today's defaults into every shop: change a default later and no
 * existing merchant would ever see it, because each would be carrying an explicit copy
 * of the old one that nobody chose and nobody can see they are carrying.
 */

/** A scope and, for STATION, which station. Null everywhere else. */
export interface SettingsLayerRef {
  readonly scope: WritableSettingScope;
  readonly scopeId?: string | null;
}

export interface SettingsView {
  /** Effective values with the layer each came from. */
  readonly resolved: ResolvedSettings;
  /** The unpublished working copy for this layer, if one exists. */
  readonly draft: Readonly<Record<string, SettingValue>> | null;
  /** True when the draft differs from what is published — what the "نشر" button reads. */
  readonly draftDiffers: boolean;
  readonly version: number | null;
}

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Stored as TEXT because SQLite has no JSON column. Anything unparseable is treated as
 * an empty layer rather than thrown: a corrupt settings row must not stop a shop from
 * trading, and every value in the registry has a default that is safe to fall back to.
 */
function parseValues(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function normaliseScopeId(ref: SettingsLayerRef): string | null {
  return ref.scope === 'STATION' ? (ref.scopeId ?? null) : null;
}

/** The published values of one layer: the highest version, or nothing. */
async function publishedLayer(
  db: Db,
  merchantId: string,
  ref: SettingsLayerRef,
): Promise<{ values: Record<string, unknown>; version: number } | null> {
  const row = await db.settingVersion.findFirst({
    where: { merchantId, scope: ref.scope, scopeId: normaliseScopeId(ref) },
    orderBy: { version: 'desc' },
    select: { values: true, version: true },
  });
  return row ? { values: parseValues(row.values), version: row.version } : null;
}

/**
 * The settings in force, for a station or for the merchant as a whole.
 *
 * `stationId` narrows it: with one, the STATION layer of that station is applied over
 * the merchant's; without, the merchant's alone. Callers that do not belong to a
 * station — reports, the manager's own screens — pass nothing and get the wider answer,
 * which is the correct one for them rather than an approximation of some station's.
 */
export async function effectiveSettings(
  merchantId: string,
  stationId?: string | null,
  db: Db = defaultClient,
): Promise<ResolvedSettings> {
  const merchant = await publishedLayer(db, merchantId, { scope: 'MERCHANT' });
  const station = stationId
    ? await publishedLayer(db, merchantId, { scope: 'STATION', scopeId: stationId })
    : null;

  return resolveSettings({
    MERCHANT: merchant?.values,
    STATION: station?.values,
  });
}

/** What one layer's editing screen needs: the effective values, the draft, and whether it differs. */
export async function settingsView(
  merchantId: string,
  ref: SettingsLayerRef,
  db: Db = defaultClient,
): Promise<SettingsView> {
  const scopeId = normaliseScopeId(ref);

  const [draftRow, published] = await Promise.all([
    db.settingDraft.findFirst({
      where: { merchantId, scope: ref.scope, scopeId },
      select: { values: true },
    }),
    publishedLayer(db, merchantId, ref),
  ]);

  const draft = draftRow ? (parseValues(draftRow.values) as Record<string, SettingValue>) : null;
  const resolved = await effectiveSettings(
    merchantId,
    ref.scope === 'STATION' ? scopeId : null,
    db,
  );

  return {
    resolved,
    draft,
    draftDiffers: draft !== null && !sameValues(draft, published?.values ?? {}),
    version: published?.version ?? null,
  };
}

/** Order-insensitive comparison; two layers with the same pairs are the same layer. */
function sameValues(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

export interface DraftResult {
  readonly rejected: readonly SettingRejection[];
  readonly draft: Readonly<Record<string, SettingValue>>;
}

/**
 * Merges values into a layer's draft. Nothing published changes.
 *
 * A `null` value REMOVES the override, which is the only way back to inheriting — and
 * it has to be distinct from "set it to the default", because a value equal to today's
 * default is still an override and would survive a later change to that default.
 *
 * Rejections are returned rather than thrown so a screen can keep the accepted fields
 * and mark the rest. The draft is written with the accepted values even when some were
 * rejected: losing five good edits because the sixth was out of range is the behaviour
 * that teaches people to distrust a settings screen.
 */
export async function saveDraft(
  merchantId: string,
  ref: SettingsLayerRef,
  values: Readonly<Record<string, unknown>>,
  actorUserId: string | null,
  db: Db = defaultClient,
): Promise<DraftResult> {
  const scopeId = normaliseScopeId(ref);

  const clearing = Object.entries(values)
    .filter(([, v]) => v === null)
    .map(([k]) => k);
  const proposed = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null));

  const { accepted, rejected } = validateSettingValues(ref.scope, proposed);

  const existing = await db.settingDraft.findFirst({
    where: { merchantId, scope: ref.scope, scopeId },
    select: { id: true, values: true },
  });

  const base = existing ? parseValues(existing.values) : {};
  for (const key of clearing) delete base[key];
  const merged = { ...base, ...accepted } as Record<string, SettingValue>;
  const serialised = JSON.stringify(merged);

  if (existing) {
    await db.settingDraft.update({
      where: { id: existing.id },
      data: { values: serialised, updatedByUserId: actorUserId },
    });
  } else {
    await db.settingDraft.create({
      data: {
        merchantId,
        scope: ref.scope,
        scopeId,
        values: serialised,
        updatedByUserId: actorUserId,
      },
    });
  }

  return { rejected, draft: merged };
}

/** Throws with a message a manager can act on. Used where there is nothing sensible to return. */
export class SettingsError extends Error {
  constructor(
    readonly code: 'NO_DRAFT' | 'NO_SUCH_VERSION' | 'NOTHING_TO_PUBLISH',
    message: string,
  ) {
    super(message);
    this.name = 'SettingsError';
  }
}

export interface PublishResult {
  readonly version: number;
  readonly values: Readonly<Record<string, SettingValue>>;
}

/**
 * Promotes the draft to a new published version, inside one transaction.
 *
 * The version number is read and written in the same transaction, and the partial
 * unique index in the migration is what actually stops two concurrent publishes from
 * both becoming version 4 — a check alone would not, and two rows with the same version
 * would make "the settings in force" depend on row order.
 *
 * Re-validated at publish even though the draft was validated when it was saved. The
 * two are separated in time by however long the manager spent looking at the preview,
 * and the registry can change underneath a draft when a build ships.
 */
export async function publishDraft(
  merchantId: string,
  ref: SettingsLayerRef,
  actorUserId: string | null,
  note: string | undefined,
  db: Db = defaultClient,
): Promise<PublishResult> {
  const scopeId = normaliseScopeId(ref);

  const draftRow = await db.settingDraft.findFirst({
    where: { merchantId, scope: ref.scope, scopeId },
    select: { id: true, values: true },
  });
  if (!draftRow) {
    throw new SettingsError('NO_DRAFT', 'لا توجد مسودة لنشرها. عدّل إعداداً أولاً ثم انشر.');
  }

  const { accepted } = validateSettingValues(ref.scope, parseValues(draftRow.values));
  const previous = await publishedLayer(db, merchantId, ref);

  if (previous && sameValues(accepted, previous.values)) {
    throw new SettingsError(
      'NOTHING_TO_PUBLISH',
      'المسودة مطابقة للمنشور حالياً، فلا شيء لنشره.',
    );
  }

  const version = (previous?.version ?? 0) + 1;

  await db.settingVersion.create({
    data: {
      merchantId,
      scope: ref.scope,
      scopeId,
      version,
      values: JSON.stringify(accepted),
      note,
      publishedByUserId: actorUserId,
    },
  });

  await db.settingDraft.delete({ where: { id: draftRow.id } });

  await recordAudit(
    {
      merchantId,
      actorUserId,
      action: AUDIT_ACTIONS.SETTINGS_PUBLISHED,
      entityType: 'setting_version',
      entityId: `${ref.scope}:${scopeId ?? '-'}:${version}`,
      before: previous?.values ?? null,
      after: accepted,
    },
    db,
  );

  return { version, values: accepted };
}

/**
 * Restores an earlier version by publishing it again as the newest one.
 *
 * Nothing is deleted and no version is resurrected in place. `rolledBackFrom` records
 * where the values came from, so the history reads as what happened rather than as a
 * settings change that appeared from nowhere.
 */
export async function rollbackTo(
  merchantId: string,
  ref: SettingsLayerRef,
  targetVersion: number,
  actorUserId: string | null,
  db: Db = defaultClient,
): Promise<PublishResult> {
  const scopeId = normaliseScopeId(ref);

  const target = await db.settingVersion.findFirst({
    where: { merchantId, scope: ref.scope, scopeId, version: targetVersion },
    select: { values: true, version: true },
  });
  if (!target) {
    throw new SettingsError('NO_SUCH_VERSION', `لا يوجد إصدار رقم ${targetVersion} لهذه الإعدادات.`);
  }

  const { accepted } = validateSettingValues(ref.scope, parseValues(target.values));
  const previous = await publishedLayer(db, merchantId, ref);
  const version = (previous?.version ?? 0) + 1;

  await db.settingVersion.create({
    data: {
      merchantId,
      scope: ref.scope,
      scopeId,
      version,
      values: JSON.stringify(accepted),
      note: `رجوع إلى الإصدار ${targetVersion}`,
      rolledBackFrom: targetVersion,
      publishedByUserId: actorUserId,
    },
  });

  // A draft left over from before the rollback would silently re-apply the change the
  // rollback just undid, the next time anybody pressed publish.
  await db.settingDraft.deleteMany({ where: { merchantId, scope: ref.scope, scopeId } });

  await recordAudit(
    {
      merchantId,
      actorUserId,
      action: AUDIT_ACTIONS.SETTINGS_ROLLED_BACK,
      entityType: 'setting_version',
      entityId: `${ref.scope}:${scopeId ?? '-'}:${version}`,
      before: previous?.values ?? null,
      after: accepted,
    },
    db,
  );

  return { version, values: accepted };
}

export interface VersionSummary {
  readonly version: number;
  readonly note: string | null;
  readonly rolledBackFrom: number | null;
  readonly publishedAt: Date;
  readonly publishedByUserId: string | null;
}

/** Newest first — the order a person scans a history in. */
export async function listVersions(
  merchantId: string,
  ref: SettingsLayerRef,
  limit = 50,
  db: Db = defaultClient,
): Promise<VersionSummary[]> {
  return db.settingVersion.findMany({
    where: { merchantId, scope: ref.scope, scopeId: normaliseScopeId(ref) },
    orderBy: { version: 'desc' },
    take: limit,
    select: {
      version: true,
      note: true,
      rolledBackFrom: true,
      publishedAt: true,
      publishedByUserId: true,
    },
  });
}

/** Discards the working copy. Published values are untouched. */
export async function discardDraft(
  merchantId: string,
  ref: SettingsLayerRef,
  db: Db = defaultClient,
): Promise<void> {
  await db.settingDraft.deleteMany({
    where: { merchantId, scope: ref.scope, scopeId: normaliseScopeId(ref) },
  });
}
