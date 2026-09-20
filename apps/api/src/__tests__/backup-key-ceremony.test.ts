import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv, resetEnvCache } from '../config/env';
import { EnvFileError, setEnvValue } from '../config/env-file';
import { AUDIT_ACTIONS } from '../services/audit.service';
import { runBackup } from '../services/backup/backup.service';
import { LocalDirectoryDestination } from '../services/backup/destinations';
import { generateBackupKey, keyFingerprint, parseBackupKey } from '../services/backup/key';
import {
  confirmKey,
  ensureKeyGenerated,
  keyStatus,
  revealKey,
} from '../services/backup/key-ceremony.service';
import { resetDatabase } from './helpers/db';
import { createWorld, type World } from './helpers/fixtures';

/**
 * The backup key ceremony (docs/legacy/CLAUDE_v3.md §7.3, §12.19).
 *
 * The failure under test is not a crash. It is a merchant who completes setup, sees
 * green ticks, and holds a folder of intact, encrypted, permanently unopenable archives
 * — because the only copy of the key burned with the machine. Every assertion here is
 * about making that state unreachable rather than merely discouraged.
 */

const prisma = new PrismaClient();
const scratch: string[] = [];
let world: World;

/** The key the suite is configured with (vitest.config.ts). */
const CONFIGURED_KEY = loadEnv().BACKUP_KEY!;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/**
 * Points the env-file writer at a throwaway file.
 *
 * Without this the ceremony would write `BACKUP_KEY` into the developer's real
 * repository `.env`, which `resolveEnvFile()` returns during development.
 */
function useScratchEnvFile(contents = ''): string {
  const path = join(tempDir('walaa-env-'), 'loyalty-pro.env');
  writeFileSync(path, contents);
  process.env.LOYALTY_ENV_FILE = path;
  return path;
}

beforeEach(async () => {
  await resetDatabase(prisma);
  world = await createWorld(prisma);
});

afterEach(() => {
  // Restore the suite-wide configuration for whatever runs next.
  delete process.env.LOYALTY_ENV_FILE;
  process.env.BACKUP_KEY = CONFIGURED_KEY;
  resetEnvCache();
});

afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
  await prisma.$disconnect();
});

/** Simulates a machine on which the ceremony has never been run. */
function withNoKey(): void {
  delete process.env.BACKUP_KEY;
  resetEnvCache();
}

const owner = () => ({ merchantId: world.merchantId, actorUserId: world.ownerId });

describe('a fresh installation', () => {
  it('reports backup as not configured rather than pretending', async () => {
    withNoKey();

    const status = await keyStatus(world.merchantId);
    expect(status.configured).toBe(false);
    expect(status.confirmed).toBe(false);
    expect(status.backupsEnabled).toBe(false);
    expect(status.fingerprint).toBeNull();
  });

  it('refuses to take a backup', async () => {
    withNoKey();

    await expect(
      runBackup(owner(), [new LocalDirectoryDestination('local', tempDir('walaa-d-'), 'محلي')]),
    ).rejects.toThrow(/لم يتم إعداد مفتاح/);
  });
});

describe('generating the key', () => {
  it('writes it to the environment file and makes it live immediately', async () => {
    withNoKey();
    const envFile = useScratchEnvFile('JWT_ACCESS_SECRET="x"\n');

    const status = await ensureKeyGenerated(world.merchantId, world.ownerId);

    expect(status.configured).toBe(true);
    expect(status.fingerprint).toHaveLength(16);
    // Live in this process, not only on disk: a manager who has just generated a key
    // must not be told it has not been configured.
    expect(loadEnv().BACKUP_KEY).toBeTruthy();
    expect(readFileSync(envFile, 'utf8')).toContain('BACKUP_KEY=');
  });

  it('still does not enable backups', async () => {
    withNoKey();
    useScratchEnvFile();

    const status = await ensureKeyGenerated(world.merchantId, world.ownerId);

    // Having a key is not the point. Having it somewhere other than this machine is.
    expect(status.confirmed).toBe(false);
    expect(status.backupsEnabled).toBe(false);
  });

  it('never replaces a key that already exists', async () => {
    const before = await keyStatus(world.merchantId);
    useScratchEnvFile();

    const after = await ensureKeyGenerated(world.merchantId, world.ownerId);

    // Replacing it would leave every archive ever taken permanently unopenable.
    expect(after.fingerprint).toBe(before.fingerprint);
  });

  it('records the generation against the fingerprint, never the key', async () => {
    withNoKey();
    useScratchEnvFile();

    const status = await ensureKeyGenerated(world.merchantId, world.ownerId);

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: AUDIT_ACTIONS.BACKUP_KEY_GENERATED },
    });
    expect(row.entityId).toBe(status.fingerprint);

    const trail = JSON.stringify(
      await prisma.auditLog.findMany({ where: { entityType: 'backup_key' } }),
    );
    expect(trail).not.toContain(loadEnv().BACKUP_KEY);
  });
});

describe('confirming the key', () => {
  it('rejects a key that does not match, and says only that', async () => {
    const wrong = generateBackupKey();

    await expect(confirmKey(world.merchantId, world.ownerId, wrong)).rejects.toThrow(
      /لا يطابق/,
    );

    // Nothing about length, position, or how close it was: the confirmation box must
    // not become an oracle for anyone who can reach the dashboard.
    expect((await keyStatus(world.merchantId)).confirmed).toBe(false);
  });

  it('rejects rubbish that is not even base64 of the right size', async () => {
    await expect(confirmKey(world.merchantId, world.ownerId, 'not-a-key')).rejects.toThrow();
  });

  it('records who confirmed and when, and enables backups', async () => {
    const status = await confirmKey(world.merchantId, world.ownerId, CONFIGURED_KEY);

    expect(status.confirmed).toBe(true);
    expect(status.backupsEnabled).toBe(true);
    expect(status.confirmedAt).toBeTruthy();
    // "Who has the key" is a question a shop will need answered years later.
    expect(status.confirmedBy).toBeTruthy();

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: AUDIT_ACTIONS.BACKUP_KEY_CONFIRMED },
    });
    expect(row.actorUserId).toBe(world.ownerId);
    expect(row.entityId).toBe(status.fingerprint);
  });

  it('records once however many times it is confirmed', async () => {
    await confirmKey(world.merchantId, world.ownerId, CONFIGURED_KEY);
    await confirmKey(world.merchantId, world.ownerId, CONFIGURED_KEY);

    // The trail answers "when was this key confirmed", not "how many times was the
    // button pressed".
    expect(
      await prisma.auditLog.count({ where: { action: AUDIT_ACTIONS.BACKUP_KEY_CONFIRMED } }),
    ).toBe(1);
  });

  it('lets a backup run once confirmed', async () => {
    await confirmKey(world.merchantId, world.ownerId, CONFIGURED_KEY);

    const destination = new LocalDirectoryDestination('local', tempDir('walaa-d-'), 'محلي');
    const run = await runBackup(owner(), [destination]);

    expect(run.ok).toBe(true);
    expect(await destination.list()).toHaveLength(1);
  });
});

describe('a key that is replaced', () => {
  it('reopens the ceremony instead of inheriting the old confirmation', async () => {
    await confirmKey(world.merchantId, world.ownerId, CONFIGURED_KEY);
    expect((await keyStatus(world.merchantId)).backupsEnabled).toBe(true);

    // Someone edits loyalty-pro.env and puts a different key in it — a migration, a restore
    // onto new hardware, a well-meaning fix.
    process.env.BACKUP_KEY = generateBackupKey();
    resetEnvCache();

    const status = await keyStatus(world.merchantId);

    // The confirmation belonged to the OLD key's fingerprint. A stale "confirmed" flag
    // would now vouch for a key nobody has ever written down.
    expect(status.configured).toBe(true);
    expect(status.confirmed).toBe(false);
    expect(status.backupsEnabled).toBe(false);
  });

  it('blocks backups again', async () => {
    await confirmKey(world.merchantId, world.ownerId, CONFIGURED_KEY);
    process.env.BACKUP_KEY = generateBackupKey();
    resetEnvCache();

    await expect(
      runBackup(owner(), [new LocalDirectoryDestination('local', tempDir('walaa-d-'), 'محلي')]),
    ).rejects.toThrow(/لم يتم تأكيد/);
  });
});

describe('revealing the key', () => {
  it('returns it and records that it was shown', async () => {
    const revealed = await revealKey(world.merchantId, world.ownerId);

    expect(revealed).toBe(CONFIGURED_KEY);
    expect(parseBackupKey(revealed)).toHaveLength(32);

    // A secret displayed has left the vault, and "who has seen this" is worth being
    // able to answer.
    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: AUDIT_ACTIONS.BACKUP_KEY_REVEALED },
    });
    expect(row.actorUserId).toBe(world.ownerId);
    expect(row.entityId).toBe(keyFingerprint(parseBackupKey(CONFIGURED_KEY)!));
  });
});

describe('writing to the environment file', () => {
  it('replaces a value in place, keeping everything else', async () => {
    const path = useScratchEnvFile('A="1"\nBACKUP_KEY=""\nB="2"\n');
    setEnvValue('BACKUP_KEY', 'abc', { path });

    const contents = readFileSync(path, 'utf8');
    expect(contents).toContain('A="1"');
    expect(contents).toContain('BACKUP_KEY="abc"');
    expect(contents).toContain('B="2"');
  });

  it('appends when the key is absent, without gluing onto the last line', async () => {
    const path = useScratchEnvFile('A="1"');
    setEnvValue('BACKUP_KEY', 'abc', { path });

    expect(readFileSync(path, 'utf8')).toMatch(/A="1"\r?\n/);
  });

  it('refuses to overwrite a value that is already set', async () => {
    const path = useScratchEnvFile('BACKUP_KEY="existing"\n');

    // The second line of defence behind `ensureKeyGenerated`. Silently replacing this
    // one value orphans every archive the shop has ever taken.
    expect(() => setEnvValue('BACKUP_KEY', 'new', { path })).toThrow(EnvFileError);
    expect(readFileSync(path, 'utf8')).toContain('existing');
  });

  it('refuses a value that would need quoting', async () => {
    const path = useScratchEnvFile();
    // Guessing at dotenv's escaping is how a config file silently starts meaning
    // something else — including, potentially, a different database.
    expect(() => setEnvValue('X', 'has "quotes" and\nnewlines', { path })).toThrow(EnvFileError);
  });

  it('refuses a variable name that is not one', async () => {
    const path = useScratchEnvFile();
    expect(() => setEnvValue('not a name', randomBytes(8).toString('hex'), { path })).toThrow(
      EnvFileError,
    );
  });
});
