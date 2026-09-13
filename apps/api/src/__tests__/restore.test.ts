import { rmSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../config/env';
import { liveDatabasePath } from '../config/paths';
import { AppError } from '../lib/errors';
import { restoreDirectoryFor } from '../lib/restore-apply';
import { AUDIT_ACTIONS } from '../services/audit.service';
import { runBackup } from '../services/backup/backup.service';
import { generateBackupKey } from '../services/backup/key';
import { confirmKey } from '../services/backup/key-ceremony.service';
import {
  cancelStagedRestore,
  requestApply,
  restoreStatus,
  stageRestore,
} from '../services/backup/restore.service';
import { resetDatabase } from './helpers/db';
import { createWorld, type World } from './helpers/fixtures';

/**
 * Restoring a copy from the Backup screen (services/backup/restore.service.ts).
 *
 * Staging must never touch the live database, and a copy that cannot be opened with the
 * key at hand must turn into a request for the key from paper — not into a dead end.
 */

const prisma = new PrismaClient();
let world: World;
const restoreDirectory = restoreDirectoryFor(liveDatabasePath(loadEnv().DATABASE_URL)!);

beforeEach(async () => {
  await resetDatabase(prisma);
  world = await createWorld(prisma);
  await confirmKey(world.merchantId, world.ownerId, loadEnv().BACKUP_KEY!);
});

afterEach(() => cancelStagedRestore());

afterAll(async () => {
  rmSync(restoreDirectory, { recursive: true, force: true });
  await prisma.$disconnect();
});

const owner = () => ({ merchantId: world.merchantId, actorUserId: world.ownerId, actorName: 'مالك' });

async function newestLocalCopy(): Promise<{ kind: string; id: string }> {
  const run = await runBackup({ merchantId: world.merchantId, actorUserId: world.ownerId });
  const landed = run.destinations.find((d) => d.kind === 'local' && d.ok);
  return { kind: 'local', id: landed!.id! };
}

async function refusalOf(work: Promise<unknown>): Promise<{ reason?: string; message: string }> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppError && error.code === 'RESTORE_REFUSED') {
      return { reason: (error.details as { reason?: string }).reason, message: error.message };
    }
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('staging a copy', () => {
  it('checks the copy and describes it — and replaces nothing', async () => {
    const copy = await newestLocalCopy();
    const customers = await prisma.customer.count();

    const staged = await stageRestore(owner(), copy);

    expect(staged.source.kind).toBe('local');
    expect(staged.copy.customers).toBe(customers);
    expect(staged.current.customers).toBe(customers);
    expect(staged.applyRequested).toBe(false);
    expect(restoreStatus().staged?.source.name).toBe(staged.source.name);
    // The live database is exactly as it was.
    expect(await prisma.customer.count()).toBe(customers);
    expect(
      await prisma.auditLog.count({ where: { action: AUDIT_ACTIONS.BACKUP_RESTORE_STAGED } }),
    ).toBe(1);
  });

  it('turns a key that does not open the copy into a question about the key on paper', async () => {
    const copy = await newestLocalCopy();

    const refused = await refusalOf(stageRestore(owner(), copy, generateBackupKey()));

    expect(refused.reason).toBe('KEY_MISMATCH');
    expect(refused.message).toMatch(/المفتاح الذي أدخلته لا يفتح هذه النسخة/);
    expect(restoreStatus().staged).toBeNull();
  });

  it('says a mistyped key is not a key, rather than trying it', async () => {
    const copy = await newestLocalCopy();

    const refused = await refusalOf(stageRestore(owner(), copy, 'not a key'));

    expect(refused.reason).toBe('KEY_INVALID');
  });

  it('refuses a copy that is no longer where the list said it was', async () => {
    const refused = await refusalOf(
      stageRestore(owner(), { kind: 'local', id: 'walaa-1999-01-01T00-00-00-000Z.walaabk' }),
    );

    expect(refused.reason).toBe('NOT_FOUND');
  });
});

describe('applying a staged copy', () => {
  it('backs up the present first, then records the request for the next start', async () => {
    const copy = await newestLocalCopy();
    await stageRestore(owner(), copy);
    const backupsBefore = await prisma.auditLog.count({
      where: { action: AUDIT_ACTIONS.BACKUP_COMPLETED },
    });

    const outcome = await requestApply(owner());

    // Nothing supervises the test process, so nothing will restart it — and it says so
    // rather than promising a restart.
    expect(outcome.restarting).toBe(false);
    expect(restoreStatus().staged?.applyRequested).toBe(true);
    // The undo: the present state as an ordinary backup, taken before anything else.
    expect(
      await prisma.auditLog.count({ where: { action: AUDIT_ACTIONS.BACKUP_COMPLETED } }),
    ).toBe(backupsBefore + 1);
  });

  it('refuses when nothing is staged', async () => {
    const refused = await refusalOf(requestApply(owner()));

    expect(refused.reason).toBe('NOTHING_STAGED');
  });
});
