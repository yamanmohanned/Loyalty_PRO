import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import {
  computeDeviceId,
  signForTests,
  writeFileAnchor,
  writeRegistryAnchor,
} from '@walaa/license-native';
import { reloadLicensingForTests } from '../../services/license.service';

/**
 * Licences for the test suite.
 *
 * Signed with the published TEST key through the native module's test build — the only
 * build that trusts that key, and one staging never ships. So these exercise the real
 * Rust verification, not a stub.
 */

export interface TestPayload {
  v?: number;
  lid?: string;
  did?: string;
  type?: 'trial' | 'perpetual';
  iat?: number;
  exp?: number | null;
  feat?: string[];
  note?: string;
}

const DAY = 86_400;

export function thisDeviceId(): string {
  return computeDeviceId().deviceId;
}

/** A code for `overrides`, signed with the test key. Field order is the spec's. */
export function testCode(overrides: TestPayload = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: overrides.v ?? 1,
    lid: overrides.lid ?? randomUUID(),
    did: overrides.did ?? thisDeviceId(),
    type: overrides.type ?? 'perpetual',
    iat: overrides.iat ?? now - 60,
    exp: overrides.exp === undefined ? (overrides.type === 'trial' ? now + 14 * DAY : null) : overrides.exp,
    feat: overrides.feat ?? ['drive_backup', 'multi_device'],
    ...(overrides.note ? { note: overrides.note } : {}),
  };
  return signForTests(JSON.stringify(payload));
}

/**
 * A perpetual licence with every feature, stored as if activated — the state the
 * pre-licensing suite assumed. `resetDatabase` installs it; licensing tests remove it.
 */
export async function installTestLicense(prisma: PrismaClient, overrides: TestPayload = {}): Promise<string> {
  await ensureInstallationRow(prisma);
  const code = testCode(overrides);
  const payloadJson = Buffer.from(code.split('.')[0]!, 'base64url').toString('utf8');
  const payload = JSON.parse(payloadJson) as Required<Omit<TestPayload, 'note'>> & { note?: string };
  await prisma.licenseActivation.create({
    data: {
      merchantId: 'test-installation',
      licenseId: payload.lid,
      kind: payload.type,
      deviceId: payload.did,
      issuedAt: new Date(payload.iat * 1000),
      expiresAt: payload.exp ? new Date(payload.exp * 1000) : null,
      features: JSON.stringify(payload.feat),
      note: payload.note ?? null,
      code,
    },
  });
  return code;
}

/**
 * The installation row as first start leaves it, written up front so that a test's
 * first request does not add a `license.device_identified` row to an audit trail the
 * test is counting. No recorded time: with all three anchors empty there is nothing
 * to disagree about.
 */
export async function ensureInstallationRow(prisma: PrismaClient): Promise<void> {
  const identity = computeDeviceId();
  await prisma.installationState.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      deviceId: identity.deviceId,
      machineGuidDigest: identity.machineGuidDigest,
      volumeSerialDigest: identity.volumeSerialDigest,
      deviceComputedAt: new Date(),
    },
  });
}

/**
 * An installation with no licence: the rows, and the mirror that would otherwise put
 * them straight back on the next check — which is exactly what the mirror is for.
 */
export async function removeLicenses(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe('DELETE FROM "license_activation"');
  const dir = process.env.WALAA_LICENSE_DIR;
  if (dir) rmSync(join(dir, 'license-codes.json'), { force: true });
  reloadLicensingForTests();
}

/** Replaces whatever licence is installed with one built from `overrides`. */
export async function useLicense(prisma: PrismaClient, overrides: TestPayload): Promise<string> {
  await removeLicenses(prisma);
  return installTestLicense(prisma, overrides);
}

/**
 * Writes the recorded time to all three places, as a service that had run at that
 * time would have, and makes the service re-read them.
 */
export async function setAnchors(
  prisma: PrismaClient,
  seconds: { database?: number | null; registry?: number | null; file?: number | null },
): Promise<void> {
  if (seconds.database !== undefined) {
    await prisma.installationState.update({
      where: { id: 1 },
      data: { lastSeenAt: seconds.database === null ? null : new Date(seconds.database * 1000) },
    });
  }
  if (typeof seconds.registry === 'number') {
    writeRegistryAnchor(process.env.WALAA_LICENSE_REGISTRY_KEY!, seconds.registry);
  }
  if (typeof seconds.file === 'number') {
    writeFileAnchor(join(process.env.WALAA_LICENSE_DIR!, '.license-clock'), seconds.file);
  }
  reloadLicensingForTests();
}
