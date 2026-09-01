import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { copyFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv, resetEnvCache } from '../config/env';
import { AUDIT_ACTIONS } from '../services/audit.service';
import {
  readArchive,
  readArchiveHeader,
  writeArchive,
  type ArchiveHeader,
} from '../services/backup/archive';
import {
  listBackups,
  localBackupDirectory,
  restoreArchive,
  runBackup,
  verifyRestore,
} from '../services/backup/backup.service';
import { LocalDirectoryDestination, archiveName } from '../services/backup/destinations';
import { generateBackupKey, keyFingerprint, parseBackupKey } from '../services/backup/key';
import { confirmKey } from '../services/backup/key-ceremony.service';
import { liveDatabasePath } from '../config/paths';
import { checkFreeSpace, takeSnapshot } from '../services/backup/snapshot';
import { resetDatabase } from './helpers/db';
import { createWorld, type World } from './helpers/fixtures';

/**
 * Backup, and the property that makes one worth having (CLAUDE_v3.md §7.3, §12.17).
 *
 * §7.3: "an untested backup is not a backup — this is the most commonly skipped step and
 * the most costly." The suite is arranged around the one assertion that makes a restore
 * test worth running: that a backup contains work committed moments before it was taken.
 * A check that only proves the file opens would pass against a backup silently missing
 * the most recent day of sales, which is the day anyone restoring actually needs.
 */

const prisma = new PrismaClient();
const scratch: string[] = [];
let world: World;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

const KEY = parseBackupKey(loadEnv().BACKUP_KEY)!;

beforeEach(async () => {
  await resetDatabase(prisma);
  world = await createWorld(prisma);

  // The §12.19 gate: backups do not run until a human has confirmed they hold the
  // encryption key somewhere other than this machine. Completed here so these tests are
  // about backup rather than about the ceremony, which has its own suite.
  await confirmKey(world.merchantId, world.ownerId, loadEnv().BACKUP_KEY!);
});

afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
  await prisma.$disconnect();
});

/** Somewhere for a backup to land that is not the developer's data directory. */
function destinations(label = 'local') {
  return [new LocalDirectoryDestination('local', tempDir(`walaa-dest-${label}-`), label)];
}

const context = () => ({ merchantId: world.merchantId, actorUserId: world.ownerId });

/* ── The archive format ───────────────────────────────────────────────────────── */

describe('the on-machine backup directory', () => {
  /** The suite pins BACKUP_LOCAL_DIR (vitest.config.ts), so the default is only
   *  observable with it unset — which is also the shape a developer runs in. */
  function withoutOverride<T>(fn: () => T): T {
    const previous = process.env.BACKUP_LOCAL_DIR;
    delete process.env.BACKUP_LOCAL_DIR;
    resetEnvCache();
    try {
      return fn();
    } finally {
      if (previous === undefined) delete process.env.BACKUP_LOCAL_DIR;
      else process.env.BACKUP_LOCAL_DIR = previous;
      resetEnvCache();
    }
  }

  it('stays inside the checkout in development, never under ProgramData', () => {
    // The scheduled run used to fail EPERM every five minutes here: a dev process is
    // unelevated and %PROGRAMDATA%\Walaa is locked to SYSTEM and Administrators. The
    // cost was not the failure but the noise — 507 is the code a genuinely full volume
    // reports (§12.22), and a developer trained to scroll past it misses the real one.
    const directory = withoutOverride(() => localBackupDirectory());

    expect(directory).toContain('.walaa-dev');
    expect(directory.toLowerCase()).not.toContain('programdata');
  });

  it('lets BACKUP_LOCAL_DIR win wherever it is set', () => {
    const override = join(tmpdir(), 'walaa-explicit-backup-dir');
    const previous = process.env.BACKUP_LOCAL_DIR;
    process.env.BACKUP_LOCAL_DIR = override;
    resetEnvCache();

    try {
      expect(localBackupDirectory()).toBe(override);
    } finally {
      if (previous === undefined) delete process.env.BACKUP_LOCAL_DIR;
      else process.env.BACKUP_LOCAL_DIR = previous;
      resetEnvCache();
    }
  });
});

describe('the archive format', () => {
  it('round-trips a file byte for byte', async () => {
    const dir = tempDir('walaa-archive-');
    const source = join(dir, 'source.bin');
    const payload = randomBytes(64 * 1024);
    writeFileSync(source, payload);

    const archive = join(dir, 'out.walaabk');
    await writeArchive(source, archive, KEY);

    const restored = join(dir, 'restored.bin');
    await readArchive(archive, restored, KEY);

    expect(readFileSync(restored).equals(payload)).toBe(true);
  });

  it('compresses, so what leaves the shop is smaller than what it holds', async () => {
    const dir = tempDir('walaa-archive-');
    const source = join(dir, 'source.bin');
    // A database is highly repetitive; random bytes would prove nothing about gzip.
    writeFileSync(source, Buffer.alloc(256 * 1024, 0x41));

    const archive = join(dir, 'out.walaabk');
    const { archiveBytes } = await writeArchive(source, archive, KEY);

    expect(archiveBytes).toBeLessThan(256 * 1024 / 10);
  });

  it('refuses a tampered ciphertext', async () => {
    const dir = tempDir('walaa-archive-');
    const source = join(dir, 'source.bin');
    writeFileSync(source, randomBytes(4096));
    const archive = join(dir, 'out.walaabk');
    await writeArchive(source, archive, KEY);

    // Flip one byte in the middle of the body.
    const bytes = readFileSync(archive);
    const middle = Math.floor(bytes.byteLength / 2);
    bytes[middle] = bytes[middle]! ^ 0xff;
    writeFileSync(archive, bytes);

    await expect(readArchive(archive, join(dir, 'restored.bin'), KEY)).rejects.toThrow();
  });

  it('refuses a tampered header, which is plaintext but not unprotected', async () => {
    const dir = tempDir('walaa-archive-');
    const source = join(dir, 'source.bin');
    writeFileSync(source, randomBytes(4096));
    const archive = join(dir, 'out.walaabk');
    const { header } = await writeArchive(source, archive, KEY);

    // Rewrite the header with a lie of exactly the same length, so only the AAD check
    // can catch it — the sizes and offsets all still line up.
    const bytes = readFileSync(archive);
    const forged: ArchiveHeader = {
      ...header,
      plaintextSha256: header.plaintextSha256.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')),
    };
    const encoded = Buffer.from(JSON.stringify(forged), 'utf8');
    expect(encoded.byteLength).toBe(bytes.readUInt32BE(8));
    encoded.copy(bytes, 12);
    writeFileSync(archive, bytes);

    await expect(readArchive(archive, join(dir, 'restored.bin'), KEY)).rejects.toThrow();
  });

  it('tells the operator a wrong key is a wrong key, not a corrupt file', async () => {
    const dir = tempDir('walaa-archive-');
    const source = join(dir, 'source.bin');
    writeFileSync(source, randomBytes(1024));
    const archive = join(dir, 'out.walaabk');
    await writeArchive(source, archive, KEY);

    const otherKey = Buffer.from(generateBackupKey(), 'base64');

    // The distinction matters at the worst moment there is: the shop is gone, someone is
    // trying keys against a folder of archives, and "corrupt" would send them away from
    // the one that opens.
    await expect(readArchive(archive, join(dir, 'restored.bin'), otherKey)).rejects.toThrow(
      /مفتاح آخر/,
    );
  });

  it('lets a header be read without the key, and puts nothing identifying in it', async () => {
    const dir = tempDir('walaa-archive-');
    const source = join(dir, 'source.bin');
    writeFileSync(source, randomBytes(1024));
    const archive = join(dir, 'out.walaabk');
    await writeArchive(source, archive, KEY);

    const header = await readArchiveHeader(archive);
    expect(header.version).toBe(1);
    expect(header.algorithm).toBe('aes-256-gcm');
    expect(header.keyFingerprint).toBe(keyFingerprint(KEY));

    // Whoever can see the file in Drive learns when it was taken and how big it is.
    // Not whose it is.
    const fields = Object.keys(header).join(' ').toLowerCase();
    for (const forbidden of ['merchant', 'shop', 'name', 'phone', 'branch', 'customer']) {
      expect(fields).not.toContain(forbidden);
    }
  });
});

/* ── Snapshot and free space ──────────────────────────────────────────────────── */

describe('taking a snapshot', () => {
  it('resolves the live database even from a relative Prisma URL', () => {
    const path = liveDatabasePath(loadEnv().DATABASE_URL);
    expect(path).toBeTruthy();
    // Per-run name (see vitest.config.ts), so this matches the family, not one file.
    expect(path).toMatch(/walaa_test.*\.db$/);
  });

  it('produces a self-contained database that opens and reads', async () => {
    const dir = tempDir('walaa-snap-');
    const target = join(dir, 'snapshot.db');

    const result = await takeSnapshot(loadEnv().DATABASE_URL, target, prisma);
    expect(result.bytes).toBeGreaterThan(0);

    const client = new PrismaClient({
      datasources: { db: { url: `file:${target.split('\\').join('/')}` } },
    });
    try {
      expect(await client.merchant.count()).toBe(1);
    } finally {
      await client.$disconnect();
    }
  });

  it('demands headroom proportional to the database, with an absolute floor', () => {
    const dir = tempDir('walaa-space-');

    // A tiny database still requires the §12.15 CRITICAL floor: proportional-only would
    // let a 20 MB database back itself up onto a volume with 200 MB left.
    expect(checkFreeSpace(20 * 1024 * 1024, dir).requiredBytes).toBe(2 * 1024 ** 3);

    // A large one scales past the floor.
    expect(checkFreeSpace(4 * 1024 ** 3, dir).requiredBytes).toBe(12 * 1024 ** 3);
  });

  it('would refuse to run when the requirement exceeds what is free', () => {
    const dir = tempDir('walaa-space-');
    // Modelled rather than staged: filling a real volume is not something a test suite
    // should do to a developer's machine (§12.15 is about that machine).
    const space = checkFreeSpace(Number.MAX_SAFE_INTEGER / 4, dir);
    expect(space.freeBytes).toBeLessThan(space.requiredBytes);
  });
});

/* ── Does the recency check actually have teeth ───────────────────────────────── */

describe('the failure §12.17 is about', () => {
  /**
   * A destination that hands back an archive taken BEFORE the sentinel was written.
   *
   * This is the shape of the §12.17 failure, staged directly: a stored backup that
   * restores cleanly, passes an integrity check, holds every table — and is older than
   * it appears. A naive copy that missed the WAL would present exactly like this.
   *
   * Staged rather than reproduced, and the distinction is worth stating. Attempting to
   * reproduce real WAL loss through this stack did not work: `PRAGMA wal_checkpoint` and
   * a subsequent write leave the sidecar at 0 bytes, so Prisma's committed writes are in
   * the main database file almost immediately and a naive copy picks them up. That makes
   * the hazard harder to trigger here than §12.17 assumed — it does not make the check
   * unnecessary, and it is not a licence to copy the file naively. `VACUUM INTO` is
   * correct by construction and costs nothing; this test is what proves the verification
   * would catch a backup that is quietly behind, whatever caused it to be.
   */
  class StaleDestination extends LocalDirectoryDestination {
    constructor(directory: string, private readonly staleArchive: string) {
      super('local', directory, 'وجهة قديمة');
    }

    override async fetch(_id: string, localPath: string): Promise<void> {
      await copyFile(this.staleArchive, localPath);
    }
  }

  it('a backup that is quietly older than it claims fails verification', async () => {
    const dir = tempDir('walaa-stale-');

    // An archive of the world as it is now, before any sentinel exists.
    const snapshot = join(dir, 'stale.db');
    await takeSnapshot(loadEnv().DATABASE_URL, snapshot, prisma);
    const staleArchive = join(dir, 'stale.walaabk');
    await writeArchive(snapshot, staleArchive, KEY);

    const verification = await verifyRestore(context(), [
      new StaleDestination(tempDir('walaa-stale-dest-'), staleArchive),
    ]);

    // Everything about the archive is valid. It decrypts, its checksum matches, SQLite
    // is happy with it. Only the recency assertion catches it — which is the entire
    // argument of §12.17 for making that assertion mandatory.
    expect(verification.restore.integrity).toBe('ok');
    expect(verification.restore.counts.customers).toBe(1);
    expect(verification.recencyProven).toBe(false);
    expect(verification.ok).toBe(false);
    expect(verification.failure).toMatch(/أحدث العمليات/);

    // And it is not recorded as a verified backup.
    expect(
      await prisma.auditLog.count({ where: { action: AUDIT_ACTIONS.BACKUP_VERIFIED } }),
    ).toBe(0);
  });
});

/* ── The run, and the verification ────────────────────────────────────────────── */

describe('running a backup', () => {
  it('stores an archive and records it in the audit trail', async () => {
    const targets = destinations();
    const run = await runBackup(context(), targets);

    expect(run.ok).toBe(true);
    expect(run.destinations[0]?.ok).toBe(true);
    expect(run.archiveBytes).toBeGreaterThan(0);

    const stored = await targets[0]!.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.name).toBe(run.name);

    const audited = await prisma.auditLog.count({
      where: { action: AUDIT_ACTIONS.BACKUP_COMPLETED, entityId: run.name },
    });
    expect(audited).toBe(1);
  });

  it('leaves no snapshot or archive behind in staging', async () => {
    const run = await runBackup(context(), destinations());
    const staging = join(loadEnv().BACKUP_LOCAL_DIR!, '.staging');

    // The snapshot is a second copy of the whole database. Left behind, backups would
    // themselves become the thing that fills the disk (§12.15).
    await expect(stat(join(staging, 'snapshot.db'))).rejects.toThrow();
    await expect(stat(join(staging, run.name))).rejects.toThrow();
  });

  it('keeps going when one destination is unavailable', async () => {
    const working = new LocalDirectoryDestination('local', tempDir('walaa-ok-'), 'محلي');
    const broken = new LocalDirectoryDestination(
      'usb',
      // A file where the directory should be — the USB stick that is not plugged in.
      (() => {
        const dir = tempDir('walaa-usb-');
        const path = join(dir, 'not-a-directory');
        writeFileSync(path, 'x');
        return path;
      })(),
      'قرص خارجي',
    );

    const run = await runBackup(context(), [working, broken]);

    // 3-2-1 means partial success is ordinary. A run reported as failed because the USB
    // stick was in someone's pocket is a run nobody reads the report of.
    expect(run.ok).toBe(true);
    expect(run.destinations.find((d) => d.kind === 'local')?.ok).toBe(true);
    expect(run.destinations.find((d) => d.kind === 'usb')?.ok).toBe(false);
    expect(await working.list()).toHaveLength(1);
  });

  it('prunes to the retention limit', async () => {
    const target = new LocalDirectoryDestination('local', tempDir('walaa-keep-'), 'محلي');
    const keep = loadEnv().BACKUP_KEEP;

    for (let i = 0; i < keep + 3; i += 1) {
      await runBackup(context(), [target], new Date(Date.UTC(2026, 0, 1 + i, 3)));
    }

    expect(await target.list()).toHaveLength(keep);
  });

  it('restores an archive without touching the live database', async () => {
    const target = destinations()[0]!;
    const run = await runBackup(context(), [target]);

    const dir = tempDir('walaa-restore-');
    const fetched = join(dir, 'fetched.walaabk');
    await target.fetch(run.name, fetched);

    const restored = await restoreArchive(fetched, join(dir, 'restored.db'));

    expect(restored.integrity).toBe('ok');
    expect(restored.counts.customers).toBe(1);
    expect(restored.header.keyFingerprint).toBe(keyFingerprint(KEY));

    // The live database is still there and still serving.
    expect(await prisma.customer.count()).toBe(1);
  });

  it('refuses a path that escapes the backup directory', async () => {
    const target = destinations()[0]!;
    const dir = tempDir('walaa-escape-');
    await expect(
      target.fetch('../../../etc/passwd.walaabk', join(dir, 'out')),
    ).rejects.toThrow();
  });

  it('lists what each destination holds', async () => {
    const target = destinations()[0]!;
    await runBackup(context(), [target]);

    const listing = await listBackups([target]);
    expect(listing[0]?.available).toBe(true);
    expect(listing[0]?.backups).toHaveLength(1);
  });
});

describe('verifyRestore — the monthly test of §7.3, as one call', () => {
  it('proves a transaction written moments before the backup survived it', async () => {
    const target = destinations()[0]!;

    const verification = await verifyRestore(context(), [target]);

    expect(verification.ok).toBe(true);
    // The assertion §12.17 requires by name. Not "the file opened" — that would pass
    // against a backup missing the most recent day of sales.
    expect(verification.recencyProven).toBe(true);
    expect(verification.restore.integrity).toBe('ok');
    expect(verification.failure).toBeUndefined();

    // Verified from a destination, not from the staging file that never left the machine.
    expect(verification.verifiedFrom).toBe('local');

    const audited = await prisma.auditLog.count({
      where: { action: AUDIT_ACTIONS.BACKUP_VERIFIED, entityId: verification.run.name },
    });
    expect(audited).toBe(1);
  });

  it('records the attempt even before it knows the outcome', async () => {
    const target = destinations()[0]!;
    const verification = await verifyRestore(context(), [target]);

    // The sentinel is written first and named for what it is — an attempt — so the trail
    // reads truthfully whether or not the verification went on to succeed.
    const started = await prisma.auditLog.count({
      where: {
        action: AUDIT_ACTIONS.BACKUP_VERIFICATION_STARTED,
        entityId: verification.sentinelId,
      },
    });
    expect(started).toBe(1);
  });
});

describe('the encryption key', () => {
  it('generates a key of the right size', () => {
    expect(Buffer.from(generateBackupKey(), 'base64')).toHaveLength(32);
  });

  it('rejects a key of the wrong size rather than padding it', () => {
    expect(() => parseBackupKey(Buffer.from('short').toString('base64'))).toThrow(/32/);
  });

  it('treats an unset key as "not configured" rather than as an error', () => {
    expect(parseBackupKey(undefined)).toBeNull();
    expect(parseBackupKey('   ')).toBeNull();
  });

  it('fingerprints differently for different keys, and stably for the same one', () => {
    const a = Buffer.from(generateBackupKey(), 'base64');
    const b = Buffer.from(generateBackupKey(), 'base64');
    expect(keyFingerprint(a)).toBe(keyFingerprint(a));
    expect(keyFingerprint(a)).not.toBe(keyFingerprint(b));
  });
});

describe('archive naming', () => {
  it('sorts chronologically as a plain string', () => {
    const older = archiveName(new Date('2026-08-30T03:00:00Z'));
    const newer = archiveName(new Date('2026-09-01T03:00:00Z'));

    // Ordering by name rather than by filesystem timestamp is what keeps a folder of
    // archives sorted correctly after being copied onto a USB stick, which resets
    // birthtime to the moment of the copy.
    expect([newer, older].sort((x, y) => y.localeCompare(x))[0]).toBe(newer);
  });
});
