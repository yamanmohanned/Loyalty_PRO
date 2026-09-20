import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '../config/env';
import { AppError } from '../lib/errors';
import { AUDIT_ACTIONS } from '../services/audit.service';
import { driveClient } from '../services/backup/drive';
import { beginConnect, resetConnectState } from '../services/backup/drive-connect.service';
import {
  clearDriveClient,
  driveStatus,
  saveDriveClient,
  testDriveConnection,
} from '../services/backup/drive-status.service';
import {
  clearClient,
  clearConnection,
  driveStateDirectory,
  readClient,
  readConnection,
} from '../services/backup/drive-store';
import { resetDatabase } from './helpers/db';
import { createWorld, type World } from './helpers/fixtures';
import { startFakeGoogle, type FakeGoogle } from './helpers/fake-google';

/**
 * Setting Google Drive up from Settings (docs/legacy/CLAUDE_v3.md §7.3, §7.6).
 *
 * The owner types the OAuth client in; it must be stored encrypted and never appear in
 * a config file, a log line, an audit row or a response. «اختبار الاتصال» must prove the
 * whole chain — authorise, upload, read back, delete — not merely that a list call works.
 *
 * Run against the local stand-in for Google (`helpers/fake-google.ts`). **Nothing here
 * has touched Google's real servers.**
 */

const prisma = new PrismaClient();
const scratch: string[] = [];
let world: World;
let google: FakeGoogle;

const CLIENT_ID = '123456789012-abcdefghijklmnop0123456789.apps.googleusercontent.com';
const CLIENT_SECRET = 'stand-in-secret-value-7f3a';

beforeAll(async () => {
  google = await startFakeGoogle();
  const stateDir = mkdtempSync(join(tmpdir(), 'walaa-drive-setup-'));
  scratch.push(stateDir);

  // No client in the environment: the Settings path is the one under test.
  delete process.env.GOOGLE_DRIVE_CLIENT_ID;
  delete process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  delete process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
  process.env.GOOGLE_DRIVE_STATE_DIR = stateDir;
  process.env.GOOGLE_OAUTH_BASE = google.origin;
  process.env.GOOGLE_DRIVE_API_BASE = google.origin;
  resetEnvCache();
});

afterAll(async () => {
  resetConnectState();
  await google.close();
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
  await prisma.$disconnect();
  delete process.env.GOOGLE_DRIVE_STATE_DIR;
  delete process.env.GOOGLE_OAUTH_BASE;
  delete process.env.GOOGLE_DRIVE_API_BASE;
  resetEnvCache();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  world = await createWorld(prisma);
  google.reset();
  clearConnection();
  clearClient();
  resetConnectState();
});

afterEach(() => google.fail('none'));

const owner = () => ({ merchantId: world.merchantId, actorUserId: world.ownerId });

async function connect(): Promise<void> {
  const start = await beginConnect({ merchantId: world.merchantId, actorUserId: null });
  await (await fetch(start.authUrl, { redirect: 'follow' })).text();
}

describe('the OAuth client, typed into Settings', () => {
  it('is what makes Drive configured — nothing is read from a config file', async () => {
    expect((await driveStatus(world.merchantId, { probe: false })).configured).toBe(false);

    const status = await saveDriveClient(owner(), { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });

    expect(status.configured).toBe(true);
    expect(status.client).toMatchObject({ clientId: CLIENT_ID, source: 'settings' });
    // The response carries the id and never the secret.
    expect(JSON.stringify(status)).not.toContain(CLIENT_SECRET);
  });

  it('stores the secret encrypted: no file in the state directory contains it', async () => {
    await saveDriveClient(owner(), { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });

    expect(readClient()?.clientSecret).toBe(CLIENT_SECRET);
    for (const name of readdirSync(driveStateDirectory())) {
      expect(readFileSync(join(driveStateDirectory(), name), 'utf8')).not.toContain(CLIENT_SECRET);
    }
  });

  it('records who saved it, with the id and never the secret', async () => {
    await saveDriveClient(owner(), { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: AUDIT_ACTIONS.BACKUP_DRIVE_CLIENT_SAVED },
    });
    expect(row.afterJson).toContain(CLIENT_ID);
    expect(row.afterJson).not.toContain(CLIENT_SECRET);
  });

  it('ignores a client in the environment on a production machine', () => {
    // A secret in loyalty-pro.env is a secret in a plain config file (§7.6).
    expect(
      driveClient({ NODE_ENV: 'production', GOOGLE_DRIVE_CLIENT_ID: CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET: 'x-secret-x' }),
    ).toBeNull();
    expect(
      driveClient({ NODE_ENV: 'test', GOOGLE_DRIVE_CLIENT_ID: CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET: 'x-secret-x' })
        ?.source,
    ).toBe('environment');
  });

  it('refuses to swap the client under a connected account, and refuses to delete it', async () => {
    await saveDriveClient(owner(), { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    await connect();
    expect(readConnection()).not.toBeNull();

    await expect(
      saveDriveClient(owner(), {
        clientId: '999999999999-zzzzzzzz.apps.googleusercontent.com',
        clientSecret: CLIENT_SECRET,
      }),
    ).rejects.toBeInstanceOf(AppError);
    await expect(clearDriveClient(owner())).rejects.toBeInstanceOf(AppError);

    // A rotated secret for the SAME client is fine.
    await expect(
      saveDriveClient(owner(), { clientId: CLIENT_ID, clientSecret: 'rotated-secret-value-1' }),
    ).resolves.toMatchObject({ configured: true });
  });
});

describe('connecting, and whose account it is', () => {
  it('uses the client from Settings and shows the linked account', async () => {
    await saveDriveClient(owner(), { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    await connect();

    const status = await driveStatus(world.merchantId, { probe: false });
    expect(status.connected).toBe(true);
    expect(status.account).toEqual({ email: 'shop.owner@example.test', name: 'حساب المتجر التجريبي' });
  });

  it('keeps the client when the account is disconnected, so reconnecting needs no retyping', async () => {
    await saveDriveClient(owner(), { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    await connect();
    const { disconnect } = await import('../services/backup/drive-connect.service');
    await disconnect({ merchantId: world.merchantId, actorUserId: null });

    const status = await driveStatus(world.merchantId, { probe: false });
    expect(status.connected).toBe(false);
    expect(status.configured).toBe(true);
    expect(google.liveTokens()).toHaveLength(0);
  });
});

describe('«اختبار الاتصال» proves the whole chain', () => {
  beforeEach(async () => {
    await saveDriveClient(owner(), { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  });

  it('authorises, uploads, reads back, deletes — and leaves nothing behind', async () => {
    await connect();
    const before = google.files().length;

    const result = await testDriveConnection();

    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => [step.step, step.ok])).toEqual([
      ['AUTHORISE', true],
      ['UPLOAD', true],
      ['READ_BACK', true],
      ['DELETE', true],
    ]);
    expect(result.account?.email).toBe('shop.owner@example.test');
    expect(google.files()).toHaveLength(before);
  });

  it('stops at the step that failed and says why, in the words backups use', async () => {
    await connect();
    google.fail('quota');

    const result = await testDriveConnection();

    expect(result.ok).toBe(false);
    // The token endpoint answers 429 for 'quota' too — so the chain stops at the first step.
    const failed = result.steps.find((step) => step.ok === false);
    expect(failed?.failure?.code).toBe('QUOTA');
    expect(failed?.failure?.message).toMatch(/ممتلئة/);
    const after = result.steps.slice(result.steps.indexOf(failed!) + 1);
    expect(after.every((step) => step.ok === null)).toBe(true);
  });

  it('names a Drive that refuses the write, which a list call would have passed', async () => {
    await connect();
    google.fail('permission');

    const result = await testDriveConnection();

    expect(result.steps[0]).toMatchObject({ step: 'AUTHORISE', ok: true });
    expect(result.steps[1]).toMatchObject({ step: 'UPLOAD', ok: false });
    expect(result.steps[1]?.failure?.code).toBe('PERMISSION');
  });

  it('says what is missing when no account is connected yet', async () => {
    const result = await testDriveConnection();

    expect(result.ok).toBe(false);
    expect(result.steps[0]?.failure?.code).toBe('NOT_CONNECTED');
  });
});
