import {
  DEFAULT_FEATURE_FLAGS,
  FeatureFlagKeySchema,
  type FeatureFlagKey,
} from '@walaa/shared-types';
import { prisma } from '../lib/prisma';
import { AUDIT_ACTIONS, recordAudit } from './audit.service';

/**
 * Feature flags (CLAUDE_v3.md §8).
 *
 * Every optional module checks a flag before rendering or executing, so one binary
 * serves every merchant and enabling a module is a settings toggle rather than a
 * separate build.
 *
 * An unknown or missing flag falls back to the shipping default rather than
 * throwing. A merchant whose database predates a new flag must keep working, and
 * the safe answer for a module nobody has opted into is "off".
 */

export async function isEnabled(merchantId: string, key: FeatureFlagKey): Promise<boolean> {
  const flag = await prisma.featureFlag.findUnique({
    where: { merchantId_key: { merchantId, key } },
  });
  return flag?.isEnabled ?? DEFAULT_FEATURE_FLAGS[key];
}

/** Every flag for a merchant, with defaults filled in for any not yet stored. */
export async function getAllFlags(merchantId: string): Promise<Record<FeatureFlagKey, boolean>> {
  const stored = await prisma.featureFlag.findMany({ where: { merchantId } });
  const byKey = new Map(stored.map((f) => [f.key, f.isEnabled]));

  const result = { ...DEFAULT_FEATURE_FLAGS };
  for (const key of Object.keys(DEFAULT_FEATURE_FLAGS) as FeatureFlagKey[]) {
    const value = byKey.get(key);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/** Toggles a flag. Audited — enabling a module changes what the system does. */
export async function setFlag(params: {
  merchantId: string;
  key: string;
  isEnabled: boolean;
  actorUserId: string;
}): Promise<{ key: FeatureFlagKey; isEnabled: boolean }> {
  const key = FeatureFlagKeySchema.parse(params.key);

  const before = await prisma.featureFlag.findUnique({
    where: { merchantId_key: { merchantId: params.merchantId, key } },
  });

  await prisma.$transaction(async (db) => {
    await db.featureFlag.upsert({
      where: { merchantId_key: { merchantId: params.merchantId, key } },
      update: { isEnabled: params.isEnabled, updatedByUserId: params.actorUserId },
      create: {
        merchantId: params.merchantId,
        key,
        isEnabled: params.isEnabled,
        updatedByUserId: params.actorUserId,
      },
    });

    await recordAudit(
      {
        merchantId: params.merchantId,
        actorUserId: params.actorUserId,
        action: AUDIT_ACTIONS.FEATURE_FLAG_TOGGLED,
        entityType: 'feature_flag',
        entityId: key,
        before: { isEnabled: before?.isEnabled ?? DEFAULT_FEATURE_FLAGS[key] },
        after: { isEnabled: params.isEnabled },
      },
      db,
    );
  });

  return { key, isEnabled: params.isEnabled };
}
