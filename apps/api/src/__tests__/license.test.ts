import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readRegistryAnchor } from '@walaa/license-native';
import { API_PREFIX, buildApp } from '../app';
import { loadEnv } from '../config/env';
import { AUDIT_ACTIONS } from '../services/audit.service';
import { runBackup, verifyRestore } from '../services/backup/backup.service';
import { LocalDirectoryDestination } from '../services/backup/destinations';
import { driveEndpoints, GoogleDriveDestination } from '../services/backup/drive';
import { DriveError } from '../services/backup/drive-errors';
import { driveStatus } from '../services/backup/drive-status.service';
import { confirmKey } from '../services/backup/key-ceremony.service';
import { reloadLicensingForTests } from '../services/license.service';
import { resetDatabase } from './helpers/db';
import { capturedInvoice, createTransaction, createWorld, TEST_PASSWORD, type World } from './helpers/fixtures';
import { removeLicenses, setAnchors, testCode, thisDeviceId, useLicense } from './helpers/license';

/**
 * Offline licensing, through the API (packaging/LICENSING.md).
 *
 * Every code here is signed with the published test key and checked by the real Rust
 * verifier — the native module's test build — so a pass means the service, the
 * binding and the cryptography agree, not that a stub said yes.
 *
 * The properties that carry the weight:
 *
 *  1. **Read-only refuses exactly three things** — a sale, a new customer, a voucher
 *     redemption — and keeps everything else open, backups and restores included.
 *  2. **Every refusal of a code names its own reason**, in Arabic, and is audited.
 *  3. **The clock cannot be wound back to stretch a trial**, and the lock lifts the
 *     moment the clock is right again.
 *  4. **Nothing ordinary loses the licence**: a restore, a changed drive, a repeat paste.
 */

const prisma = new PrismaClient();
const scratch: string[] = [];
let app: FastifyInstance;
let world: World;

const DAY = 86_400;
const now = (): number => Math.floor(Date.now() / 1000);
const url = (path: string) => `${API_PREFIX}${path}`;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

async function tokenFor(username: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: url('/auth/login'),
    payload: { username, password: TEST_PASSWORD },
  });
  if (response.statusCode !== 200) throw new Error(`login failed for ${username}: ${response.body}`);
  return response.json().tokens.accessToken as string;
}

const state = async (token?: string) =>
  (
    await app.inject({ method: 'GET', url: url('/license'), headers: bearer(token ?? (await tokenFor('owner'))) })
  ).json();

const activate = async (code: string) =>
  app.inject({
    method: 'POST',
    url: url('/license/activate'),
    headers: bearer(await tokenFor('owner')),
    payload: { code },
  });

/** A sale: the till's attribute call. With nothing captured yet it answers NO_PENDING_INVOICE. */
const sell = async () =>
  app.inject({
    method: 'POST',
    url: url('/scan/card'),
    headers: bearer(await tokenFor('station')),
    payload: { barcodeToken: world.customerBarcode },
  });

const register = async (phone = '07801112233') =>
  app.inject({
    method: 'POST',
    url: url('/customers'),
    headers: bearer(await tokenFor('station')),
    payload: { name: 'زينب عبد الرزاق', phone },
  });

async function aVoucher(): Promise<string> {
  const transaction = await createTransaction(prisma, world, {
    invoiceId: `INV-V-${randomUUID().slice(0, 8)}`,
    amountGross: 100_000,
  });
  const voucher = await prisma.voucher.create({
    data: {
      merchantId: world.merchantId,
      transactionId: transaction.id,
      customerId: world.customerId,
      code: `V-${randomUUID().slice(0, 8)}`,
      value: 2_000,
      settlementStrategy: 'VOUCHER_AS_PAYMENT',
      issuedAt: new Date(),
    },
  });
  return voucher.id;
}

const redeem = async (voucherId: string) =>
  app.inject({
    method: 'POST',
    url: url(`/vouchers/${voucherId}/redeem`),
    headers: bearer(await tokenFor('station')),
    payload: {},
  });

const capture = async (invoiceId: string) =>
  app.inject({
    method: 'POST',
    url: url('/ingest/invoice'),
    headers: bearer(await tokenFor('agent')),
    payload: { agentId: 'till-1', invoice: capturedInvoice({ invoice_id: invoiceId, amount_gross: 50_000 }) },
  });

const audits = (action: string) => prisma.auditLog.findMany({ where: { action }, orderBy: { createdAt: 'asc' } });

/** Flips one character of the payload half, keeping it valid base64url. */
function corrupt(code: string): string {
  const [payload, signature] = code.split('.') as [string, string];
  const flipped = payload[10] === 'A' ? 'B' : 'A';
  return `${payload.slice(0, 10)}${flipped}${payload.slice(11)}.${signature}`;
}

beforeAll(async () => {
  app = await buildApp({ rateLimit: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  world = await createWorld(prisma);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the device ID', () => {
  it('is computed in Rust from this machine, shown as WL-XXXX-XXXX, and stored', async () => {
    const deviceId = thisDeviceId();
    // Base-30: no I, L, O, U, 0 or 1 — the characters people misread off a screen.
    expect(deviceId).toMatch(/^WL-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/);

    expect((await state()).deviceId).toBe(deviceId);
    const row = await prisma.installationState.findUniqueOrThrow({ where: { id: 1 } });
    expect(row.deviceId).toBe(deviceId);
  });

  it('keeps the stored ID and only warns when a source changes — a new drive never revokes a licence', async () => {
    await state();
    await prisma.installationState.update({ where: { id: 1 }, data: { machineGuidDigest: '0'.repeat(64) } });
    reloadLicensingForTests();

    const after = await state();
    expect(after.status).toBe('PERPETUAL');
    expect(after.deviceId).toBe(thisDeviceId());
    expect((await sell()).statusCode).toBe(200);

    const warnings = await audits(AUDIT_ACTIONS.LICENSE_DEVICE_SOURCES_CHANGED);
    expect(warnings).toHaveLength(1);
    expect(JSON.parse(warnings[0]!.afterJson ?? '{}').changed).toEqual(['machine_guid']);
  });
});

describe('activating a code', () => {
  it('turns an unlicensed, read-only installation into a trading one at once, with no restart', async () => {
    await removeLicenses(prisma);
    const before = await state();
    expect(before.status).toBe('UNLICENSED');
    expect(before.readOnly).toBe(true);

    const refused = await sell();
    expect(refused.statusCode).toBe(423);
    expect(refused.json().error.code).toBe('LICENSE_READ_ONLY');

    const response = await activate(testCode({ note: 'سوبرماركت الاختبار' }));
    expect(response.statusCode).toBe(200);
    expect(response.json().state.status).toBe('PERPETUAL');
    expect(response.json().activation.kind).toBe('perpetual');
    expect(response.json().activation.note).toBe('سوبرماركت الاختبار');
    expect(response.json().alreadyActive).toBe(false);

    expect((await sell()).statusCode).toBe(200);
    expect(await audits(AUDIT_ACTIONS.LICENSE_ACTIVATED)).toHaveLength(1);

    const history = await app.inject({
      method: 'GET',
      url: url('/license/activations'),
      headers: bearer(await tokenFor('owner')),
    });
    expect(history.json().activations).toHaveLength(1);
    expect(history.json().activations[0].activatedByName).toBe('المالك');
  });

  it('accepts the code the way a message delivers it — 60-character lines, CRLF, spaces, RTL marks', async () => {
    await removeLicenses(prisma);
    const code = testCode({ type: 'trial' });
    const pasted = `‏  ${(code.match(/.{1,60}/g) as string[]).join('\r\n   ')}\n‎`;

    const response = await activate(pasted);
    expect(response.statusCode).toBe(200);
    expect(response.json().state.status).toBe('TRIAL');
    expect(response.json().state.daysLeft).toBe(14);
  });

  it('refuses each kind of bad code with its own Arabic sentence, and audits every attempt with its reason', async () => {
    await removeLicenses(prisma);
    const attempts: Array<[string, string]> = [
      ['MALFORMED', 'هذا ليس رمزاً'],
      ['BAD_SIGNATURE', corrupt(testCode())],
      ['DEVICE_MISMATCH', testCode({ did: 'WL-2222-2222' })],
      ['UNSUPPORTED_VERSION', testCode({ v: 2 })],
      ['EXPIRED_CODE', testCode({ type: 'trial', iat: now() - 20 * DAY, exp: now() - DAY })],
    ];

    const messages = new Set<string>();
    for (const [reason, code] of attempts) {
      const response = await activate(code);
      expect(response.statusCode, reason).toBe(422);
      expect(response.json().error.code, reason).toBe('LICENSE_INVALID');
      expect(response.json().error.details.reason, reason).toBe(reason);
      const message = response.json().error.message as string;
      messages.add(message);
      if (reason === 'DEVICE_MISMATCH') {
        // The one sentence that must carry Latin text: both device numbers, so the
        // merchant can read the right one back to the provider.
        expect(message).toContain('WL-2222-2222');
        expect(message).toContain(thisDeviceId());
      } else {
        expect(message, reason).not.toMatch(/[A-Za-z]/);
      }
    }
    expect(messages.size).toBe(attempts.length);

    const failed = await audits(AUDIT_ACTIONS.LICENSE_ACTIVATION_FAILED);
    expect(failed.map((row) => JSON.parse(row.afterJson ?? '{}').reason)).toEqual(attempts.map(([r]) => r));
    // Nothing was stored, and the installation is still read-only.
    expect(await prisma.licenseActivation.count()).toBe(0);
    expect((await state()).status).toBe('UNLICENSED');
  });

  it('treats pasting the same code twice as a no-op', async () => {
    await removeLicenses(prisma);
    const code = testCode();
    expect((await activate(code)).json().alreadyActive).toBe(false);
    expect((await activate(code)).json().alreadyActive).toBe(true);
    expect(await prisma.licenseActivation.count()).toBe(1);
  });

  it('refuses a trial code on an installation that already holds a perpetual licence', async () => {
    const response = await activate(testCode({ type: 'trial' }));
    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.reason).toBe('PERPETUAL_ACTIVE');
    expect((await state()).status).toBe('PERPETUAL');
  });

  it('extends a trial: the later expiry governs, and an older code cannot shorten it', async () => {
    await useLicense(prisma, { type: 'trial', exp: now() + 3 * DAY });
    await activate(testCode({ type: 'trial', exp: now() + 20 * DAY }));
    expect((await state()).daysLeft).toBe(20);

    await activate(testCode({ type: 'trial', exp: now() + 5 * DAY }));
    expect((await state()).daysLeft).toBe(20);
  });
});

describe('read-only refuses exactly three things', () => {
  beforeEach(async () => {
    await removeLicenses(prisma);
  });

  it('refuses a sale, a new customer and a voucher redemption — and writes none of them', async () => {
    const customersBefore = await prisma.customer.count();
    const voucherId = await aVoucher();

    for (const [what, response] of [
      ['sale', await sell()],
      ['new customer', await register()],
      ['voucher', await redeem(voucherId)],
    ] as const) {
      expect(response.statusCode, what).toBe(423);
      expect(response.json().error.code, what).toBe('LICENSE_READ_ONLY');
      expect(response.json().error.message, what).toContain('للقراءة فقط');
      expect(response.json().error.message, what).not.toMatch(/[A-Za-z]/);
    }

    expect(await prisma.customer.count()).toBe(customersBefore);
    expect((await prisma.voucher.findUniqueOrThrow({ where: { id: voucherId } })).redeemedAt).toBeNull();
  });

  it('keeps everything else open: capture, card batches, reports, the customer list, backups and the restore test', async () => {
    expect((await capture('INV-RO-1')).statusCode).toBe(201);

    const owner = await tokenFor('owner');
    const batch = await app.inject({
      method: 'POST',
      url: url('/cards/batches'),
      headers: bearer(owner),
      payload: { quantity: 2 },
    });
    expect(batch.statusCode).toBe(201);

    for (const path of ['/reports/overview', '/customers?page=1', '/cards/batches', '/backup']) {
      const response = await app.inject({ method: 'GET', url: url(path), headers: bearer(owner) });
      expect(response.statusCode, path).toBe(200);
    }

    // Backups have their own gate — the key ceremony — which has nothing to do with the
    // licence. Passed here so that what is measured is the licence alone.
    await confirmKey(world.merchantId, world.ownerId, loadEnv().BACKUP_KEY!);
    const destination = new LocalDirectoryDestination('local', tempDir('walaa-lic-backup-'), 'محلي');
    const context = { merchantId: world.merchantId, actorUserId: world.ownerId };
    const run = await runBackup(context, [destination]);
    expect(run.ok).toBe(true);

    const verification = await verifyRestore(context, [destination]);
    expect(verification.ok).toBe(true);
  });

  it('keeps a sale queued offline in the queue rather than dropping it, and applies it after activation', async () => {
    expect((await capture('INV-Q-1')).statusCode).toBe(201);
    const batch = {
      deviceId: 'station-1',
      operations: [
        {
          type: 'SCAN_CARD',
          operationId: randomUUID(),
          queuedAt: new Date().toISOString(),
          payload: { barcodeToken: world.customerBarcode, invoiceId: 'INV-Q-1' },
        },
      ],
    };
    const send = async () =>
      app.inject({ method: 'POST', url: url('/sync/batch'), headers: bearer(await tokenFor('station')), payload: batch });

    const refused = (await send()).json().results[0];
    // FAILED is the one status the Station does not settle: the item stays queued.
    expect(refused.status).toBe('FAILED');
    expect(refused.errorCode).toBe('LICENSE_READ_ONLY');

    await activate(testCode());
    expect((await send()).json().results[0].status).toBe('APPLIED');
  });
});

describe('the trial', () => {
  it('warns days out, not hours, and louder as the end comes', async () => {
    const levels: Array<[number, string]> = [
      [20, 'none'],
      [10, 'notice'],
      [5, 'warning'],
      [3, 'urgent'],
    ];
    for (const [daysLeft, warning] of levels) {
      await useLicense(prisma, { type: 'trial', exp: now() + daysLeft * DAY - 60 });
      const current = await state();
      expect(current.status, `${daysLeft} days`).toBe('TRIAL');
      expect(current.daysLeft, `${daysLeft} days`).toBe(daysLeft);
      expect(current.warning, `${daysLeft} days`).toBe(warning);
    }
    expect((await sell()).statusCode).toBe(200);
  });

  it('keeps working through five days of grace after expiry', async () => {
    await useLicense(prisma, { type: 'trial', iat: now() - 15 * DAY, exp: now() - DAY });
    const current = await state();
    expect(current.status).toBe('GRACE');
    expect(current.basis).toBe('trial');
    expect(current.warning).toBe('urgent');
    expect(current.readOnly).toBe(false);
    expect(current.graceEndsAt).not.toBeNull();
    expect((await sell()).statusCode).toBe(200);
  });

  it('becomes read-only when the grace ends', async () => {
    await useLicense(prisma, { type: 'trial', iat: now() - 20 * DAY, exp: now() - 6 * DAY });
    expect((await state()).status).toBe('EXPIRED');
    const refused = await sell();
    expect(refused.statusCode).toBe(423);
    expect(refused.json().error.message).toContain('انتهت الفترة التجريبية');
  });
});

describe('the clock', () => {
  const trial = () => useLicense(prisma, { type: 'trial', iat: now() - DAY, exp: now() + 14 * DAY });

  it('is TAMPERED when set more than two hours behind the latest recorded time, and recovers the moment it is right', async () => {
    await trial();
    const ahead = now() + 3 * DAY;
    await setAnchors(prisma, { database: ahead, registry: ahead, file: ahead });

    const tampered = await state();
    expect(tampered.status).toBe('TAMPERED');
    expect(tampered.readOnly).toBe(true);
    expect(tampered.clockBehindMinutes).toBeGreaterThanOrEqual(3 * 24 * 60 - 1);
    const refused = await sell();
    expect(refused.statusCode).toBe(423);
    expect(refused.json().error.message).toContain('صحّح التاريخ والوقت');
    expect(await audits(AUDIT_ACTIONS.LICENSE_CLOCK_ROLLBACK)).toHaveLength(1);

    // The merchant corrects the clock. Nothing else — no code, no restart.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime((ahead + 60) * 1000);
    const recovered = await state();
    expect(recovered.status).toBe('TRIAL');
    expect((await sell()).statusCode).toBe(200);
    // The detection stays in the trail.
    expect(await audits(AUDIT_ACTIONS.LICENSE_CLOCK_ROLLBACK)).toHaveLength(1);
  });

  it('tolerates two hours of drift', async () => {
    await trial();
    const ahead = now() + 90 * 60;
    await setAnchors(prisma, { database: ahead, registry: ahead, file: ahead });
    expect((await state()).status).toBe('TRIAL');
  });

  it('takes the latest of three records that disagree, and audits the disagreement', async () => {
    await trial();
    await state();
    // Only the registry remembers a later time — as if the database had been restored
    // from an older copy and the file deleted.
    await setAnchors(prisma, { database: now(), registry: now() + 3 * DAY });

    expect((await state()).status).toBe('TAMPERED');
    expect(await audits(AUDIT_ACTIONS.LICENSE_CLOCK_ANCHOR_CONFLICT)).toHaveLength(1);
  });

  it('does not touch a perpetual licence, which has no expiry to stretch', async () => {
    const ahead = now() + 3 * DAY;
    await setAnchors(prisma, { database: ahead, registry: ahead, file: ahead });
    expect((await state()).status).toBe('PERPETUAL');
    expect((await sell()).statusCode).toBe(200);
  });

  it('accepts a freshly issued code as proof that a far-future recorded time was never real', async () => {
    await trial();
    const ahead = now() + 30 * DAY;
    await setAnchors(prisma, { database: ahead, registry: ahead, file: ahead });
    expect((await state()).status).toBe('TAMPERED');

    const response = await activate(testCode({ type: 'trial', iat: now(), exp: now() + 14 * DAY }));
    expect(response.statusCode).toBe(200);
    expect(response.json().state.status).toBe('TRIAL');
    expect(await audits(AUDIT_ACTIONS.LICENSE_CLOCK_ANCHOR_RESET)).toHaveLength(1);
    expect(readRegistryAnchor(process.env.WALAA_LICENSE_REGISTRY_KEY!)).toBeLessThanOrEqual(now() + 60);
  });
});

describe('the stored licence', () => {
  it('is TAMPERED when the stored code no longer matches its signature, until a good one is pasted', async () => {
    const row = await prisma.licenseActivation.findFirstOrThrow();
    await prisma.licenseActivation.update({ where: { id: row.id }, data: { code: corrupt(row.code) } });

    const current = await state();
    expect(current.status).toBe('TAMPERED');
    expect(current.storedLicenseInvalid).toBe(true);
    const refused = await sell();
    expect(refused.statusCode).toBe(423);
    expect(refused.json().error.message).toContain('توقيعها');

    expect((await activate(testCode())).json().state.status).toBe('PERPETUAL');
    expect((await sell()).statusCode).toBe(200);
  });

  it('survives a restore of a database from before the activation', async () => {
    await state();
    // What a restore of an older copy does to this table.
    await prisma.$executeRawUnsafe('DELETE FROM "license_activation"');
    reloadLicensingForTests();

    expect((await state()).status).toBe('PERPETUAL');
    expect(await prisma.licenseActivation.count()).toBe(1);
    expect(await audits(AUDIT_ACTIONS.LICENSE_RESTORED_FROM_MIRROR)).toHaveLength(1);
  });
});

describe('features', () => {
  const file = () => {
    const path = join(tempDir('walaa-lic-drive-'), 'a.walaabk');
    writeFileSync(path, Buffer.alloc(16, 1));
    return path;
  };
  const drive = () =>
    new GoogleDriveDestination(
      { clientId: 'id', clientSecret: 'secret', refreshToken: 'token', endpoints: driveEndpoints(loadEnv()) },
      fetch,
      Date.now,
      () => {},
    );

  it('uploads to Google Drive only with drive_backup, and says so rather than failing at 23:30', async () => {
    await useLicense(prisma, { feat: ['multi_device'] });

    const error = (await drive().put(file(), 'a.walaabk').catch((thrown: unknown) => thrown)) as DriveError;
    expect(error).toBeInstanceOf(DriveError);
    expect(error.code).toBe('NOT_LICENSED');
    expect((await driveStatus(world.merchantId, { probe: false })).licensed).toBe(false);
  });

  it('reports Drive as licensed when the licence includes it', async () => {
    expect((await driveStatus(world.merchantId, { probe: false })).licensed).toBe(true);
  });

  it('keeps Drive listing and restore open with no licence at all', async () => {
    await removeLicenses(prisma);
    // No licence check stands in front of reading back: the call gets as far as the
    // network (here, a refused connection), not as far as a NOT_LICENSED refusal.
    const error = (await drive().list().catch((thrown: unknown) => thrown)) as DriveError;
    expect(error.code).not.toBe('NOT_LICENSED');
  });
});
