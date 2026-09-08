import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../config/env';
import { AUDIT_ACTIONS } from '../services/audit.service';
import { readArchive, writeArchive } from '../services/backup/archive';
import { restoreArchive, runBackup } from '../services/backup/backup.service';
import { LocalDirectoryDestination } from '../services/backup/destinations';
import { parseBackupKey } from '../services/backup/key';
import { confirmKey } from '../services/backup/key-ceremony.service';
import { redeemVoucher, voidVoucher } from '../services/voucher.service';
import { scanCard } from '../services/scan.service';
import { ingestInvoice } from '../services/ingestion.service';
import { parseArgs, requiredFreeBytes } from '../tools/restore';
import { resetDatabase } from './helpers/db';
import { capturedInvoice, createWorld, type World } from './helpers/fixtures';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  DURABILITY — what survives an interruption, and what must never be left behind
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every case here was found by killing a real process with `Stop-Process -Force` at a
 * chosen moment and looking at what was on disk afterwards. A unit test cannot kill a
 * process, so what it can do instead is pin the *property* that made each of those
 * failures possible — the missing transaction boundary, the file left at the
 * destination, the scratch nobody swept — so a future change cannot quietly restore it.
 *
 * The kill experiments themselves, with their observed outputs, are recorded in the
 * doc comments of the code they belong to: `voucher.service.redeemVoucher`,
 * `backup.service.prepareStaging`, `backup.service.restoreArchive`, and
 * `archive.readArchive`.
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
  await confirmKey(world.merchantId, world.ownerId, loadEnv().BACKUP_KEY!);
});

afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
  await prisma.$disconnect();
});

const stationContext = () => ({
  merchantId: world.merchantId,
  userId: world.stationUserId,
  branchId: world.branchId,
});

const agentContext = () => ({
  merchantId: world.merchantId,
  userId: world.agentUserId,
  userBranchId: world.branchId,
});

/** Captures an invoice and attributes it, returning the voucher that was issued. */
async function sellAndQualify(invoiceId: string, amountGross = 100_000) {
  await ingestInvoice(agentContext(), capturedInvoice({ invoice_id: invoiceId, amount_gross: amountGross }));
  const scan = await scanCard(stationContext(), { barcodeToken: world.customerBarcode, invoiceId });
  expect(scan.outcome).toBe('QUALIFIED');
  expect(scan.voucher).not.toBeNull();
  return scan.voucher!;
}

/* ── A money movement and its audit row commit together ───────────────────────── */

describe('a voucher state change and its audit row are one commit', () => {
  /**
   * The gap this pins was reproduced, not theorised. With a delay inserted between the
   * conditional UPDATE and `recordAudit`, a force-kill left voucher `UJQY-7JA7` at
   * `status = REDEEMED` with no `voucher.redeemed` row anywhere — money out of the
   * drawer with nothing in the append-only trail to explain it, and unrecoverable,
   * because the next attempt is correctly refused as "already used" and writes nothing
   * either.
   */
  it('writes the redemption audit row in the same transaction as the redemption', async () => {
    const voucher = await sellAndQualify('DUR-REDEEM-1');

    await redeemVoucher({
      merchantId: world.merchantId,
      voucherId: voucher.id,
      actorUserId: world.ownerId,
    });

    const [row, audits] = await Promise.all([
      prisma.voucher.findUniqueOrThrow({ where: { id: voucher.id } }),
      prisma.auditLog.count({
        where: { entityId: voucher.id, action: AUDIT_ACTIONS.VOUCHER_REDEEMED },
      }),
    ]);

    expect(row.status).toBe('REDEEMED');
    expect(audits).toBe(1);
  });

  it('leaves no audit row behind when the redemption is refused', async () => {
    const voucher = await sellAndQualify('DUR-REDEEM-2');
    await redeemVoucher({
      merchantId: world.merchantId,
      voucherId: voucher.id,
      actorUserId: world.ownerId,
    });

    await expect(
      redeemVoucher({
        merchantId: world.merchantId,
        voucherId: voucher.id,
        actorUserId: world.ownerId,
      }),
    ).rejects.toMatchObject({ code: 'COUPON_NOT_REDEEMABLE' });

    // Still exactly one: the refusal wrote nothing, so the trail says the slip was
    // settled once.
    expect(
      await prisma.auditLog.count({
        where: { entityId: voucher.id, action: AUDIT_ACTIONS.VOUCHER_REDEEMED },
      }),
    ).toBe(1);
  });

  it('writes the void audit row in the same transaction as the void', async () => {
    const voucher = await sellAndQualify('DUR-VOID-1');

    await voidVoucher({
      merchantId: world.merchantId,
      voucherId: voucher.id,
      actorUserId: world.ownerId,
      reason: 'الزبون غادر قبل إتمام البيع',
    });

    const [row, audits] = await Promise.all([
      prisma.voucher.findUniqueOrThrow({ where: { id: voucher.id } }),
      prisma.auditLog.findMany({
        where: { entityId: voucher.id, action: AUDIT_ACTIONS.VOUCHER_VOIDED },
      }),
    ]);

    expect(row.status).toBe('VOID');
    expect(audits).toHaveLength(1);
    // The reason is the whole point of auditing a void: it is what distinguishes a
    // walked-away customer from a cashier quietly erasing a slip.
    expect(JSON.parse(audits[0]!.afterJson!)).toMatchObject({
      reason: 'الزبون غادر قبل إتمام البيع',
    });
  });
});

/* ── A sale is whole or it is absent ──────────────────────────────────────────── */

describe('a sale never lands half-recorded', () => {
  it('records the discount, the voucher and both audit rows together', async () => {
    const voucher = await sellAndQualify('DUR-ATOMIC-1');

    const transaction = await prisma.transaction.findFirstOrThrow({
      where: { merchantId: world.merchantId, invoiceId: 'DUR-ATOMIC-1' },
      include: { vouchers: true },
    });

    expect(transaction.customerId).toBe(world.customerId);
    expect(transaction.discountValue).toBeGreaterThan(0);
    expect(transaction.amountNet).toBe(transaction.amountGross - transaction.discountValue);
    expect(transaction.vouchers).toHaveLength(1);
    expect(transaction.vouchers[0]!.id).toBe(voucher.id);

    const attributed = await prisma.auditLog.count({
      where: { entityId: transaction.id, action: AUDIT_ACTIONS.INVOICE_ATTRIBUTED },
    });
    const issued = await prisma.auditLog.count({
      where: { entityId: voucher.id, action: AUDIT_ACTIONS.VOUCHER_ISSUED },
    });
    expect([attributed, issued]).toEqual([1, 1]);
  });

  /**
   * The invariant a half-recorded sale breaks, asserted over the whole table rather
   * than over one row: a discount with no voucher is a drawer short by an amount
   * nothing explains, which reads as theft (§0 rule 3).
   */
  it('has no discount anywhere without a voucher to explain it', async () => {
    for (const id of ['DUR-INV-1', 'DUR-INV-2', 'DUR-INV-3']) await sellAndQualify(id);

    const orphans = await prisma.$queryRawUnsafe<Array<{ invoice_id: string }>>(
      `SELECT t.invoice_id FROM "transaction" t
        WHERE t.discount_value > 0
          AND NOT EXISTS (SELECT 1 FROM voucher v WHERE v.transaction_id = t.id)`,
    );
    expect(orphans).toEqual([]);
  });
});

/* ── The archive reader ───────────────────────────────────────────────────────── */

describe('a damaged archive', () => {
  /** A real archive, and a copy of it with one bit flipped in the middle. */
  async function archives(): Promise<{ dir: string; good: string; bitflip: string; truncated: string }> {
    const dir = tempDir('walaa-durability-');
    const source = join(dir, 'source.db');
    // Not a real database: `readArchive` never opens it, and its own SHA-256 is what is
    // being checked. Random so gzip cannot flatten it to nothing.
    writeFileSync(source, Buffer.from(Array.from({ length: 64 * 1024 }, (_, i) => (i * 37) % 251)));

    const good = join(dir, 'good.walaabk');
    await writeArchive(source, good, KEY);

    const bytes = readFileSync(good);
    const flipped = Buffer.from(bytes);
    // `noUncheckedIndexedAccess` types an index read as possibly-undefined, and `^=`
    // is a read as well as a write. Explicit, so the intent survives the strictness.
    const middle = Math.floor(flipped.length / 2);
    flipped[middle] = (flipped[middle] ?? 0) ^ 0x01;
    const bitflip = join(dir, 'bitflip.walaabk');
    writeFileSync(bitflip, flipped);

    const truncated = join(dir, 'truncated.walaabk');
    writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length * 0.6)));

    return { dir, good, bitflip, truncated };
  }

  it('fails in Arabic naming the file, not with a Node crypto phrase', async () => {
    const { dir, bitflip } = await archives();
    const out = join(dir, 'out.db');

    await expect(readArchive(bitflip, out, KEY)).rejects.toThrow(/bitflip\.walaabk/);
    await expect(readArchive(bitflip, out, KEY)).rejects.toThrow(/تالفة/);
  });

  /**
   * The dangerous half. GCM cannot detect tampering until `final()`, so the decrypt
   * pipeline had already written plaintext to the destination — a 16 KB `walaa.db`
   * sitting exactly where the operator aimed the restore, beside an error they may not
   * have read, and the runbook's next instruction is to copy that file into place.
   */
  it('leaves nothing at the destination', async () => {
    const { dir, bitflip, truncated } = await archives();

    for (const [name, archive] of [
      ['bitflip', bitflip],
      ['truncated', truncated],
    ] as const) {
      const out = join(dir, `${name}-out.db`);
      await expect(readArchive(archive, out, KEY)).rejects.toThrow();
      expect(existsSync(out)).toBe(false);
    }
  });

  it('says the file is not a Walaa backup, with its size, when the magic is wrong', async () => {
    const dir = tempDir('walaa-durability-notours-');
    const path = join(dir, 'random.walaabk');
    writeFileSync(path, Buffer.alloc(0));

    await expect(readArchive(path, join(dir, 'out.db'), KEY)).rejects.toThrow(
      /random\.walaabk.*0 بايت/s,
    );
  });
});

/* ── Restoring ────────────────────────────────────────────────────────────────── */

describe('restoring an archive', () => {
  async function backupTo(dir: string): Promise<string> {
    await sellAndQualify('DUR-RESTORE-1');
    const run = await runBackup(
      { merchantId: world.merchantId, actorUserId: world.ownerId },
      [new LocalDirectoryDestination('local', dir, 'local')],
    );
    expect(run.ok).toBe(true);
    return join(dir, run.name);
  }

  it('reports integrity, foreign keys, schema and recency', async () => {
    const dir = tempDir('walaa-restore-report-');
    const archive = await backupTo(dir);

    const result = await restoreArchive(archive, join(dir, 'restored.db'), KEY);

    expect(result.integrity).toBe('ok');
    expect(result.foreignKeyViolations).toBe(0);
    expect(result.schemaMatchesBuild).toBe(true);
    expect(result.counts.transactions).toBeGreaterThan(0);
    expect(result.counts.vouchers).toBeGreaterThan(0);
    // The §12.17 assertion: the backup carries work committed before it ran.
    expect(result.latestAuditAt).not.toBeNull();
  });

  /**
   * A restore killed part-way used to leave the destination holding an unverified file
   * — at t+3.5s against a 420 MB archive, a full-length one that opened cleanly and
   * passed `quick_check`. The destination now appears only after every check has
   * passed, so a killed restore leaves `<destination>.partial` and no destination.
   */
  it('writes through a .partial file and leaves none behind on success', async () => {
    const dir = tempDir('walaa-restore-partial-');
    const archive = await backupTo(dir);
    const destination = join(dir, 'restored.db');

    await restoreArchive(archive, destination, KEY);

    expect(existsSync(destination)).toBe(true);
    expect(existsSync(`${destination}.partial`)).toBe(false);
    // The inspection opens the working file; its sidecars must not survive to confuse
    // SQLite when the finished file is opened somewhere else.
    expect(existsSync(`${destination}.partial-wal`)).toBe(false);
    expect(existsSync(`${destination}.partial-shm`)).toBe(false);
  });

  it('refuses an archive encrypted with a different key, naming the one it needs', async () => {
    const dir = tempDir('walaa-restore-key-');
    const archive = await backupTo(dir);
    const wrong = Buffer.alloc(32, 7);

    await expect(restoreArchive(archive, join(dir, 'out.db'), wrong)).rejects.toThrow(
      /مفتاح آخر/,
    );
    expect(existsSync(join(dir, 'out.db'))).toBe(false);
  });

  /**
   * An archive from a different build restores perfectly and then cannot be served.
   * Whoever is recovering has to learn that here, holding a file they can still keep,
   * rather than from a service that refuses to start after they have overwritten the
   * original.
   */
  it('reports a schema that does not match this build', async () => {
    const dir = tempDir('walaa-restore-schema-');
    const archive = await backupTo(dir);
    const restored = join(dir, 'restored.db');
    await restoreArchive(archive, restored, KEY);

    // Change the shape the way a migration between versions would.
    const altered = join(dir, 'altered.db');
    const url = `file:${restored.split('\\').join('/')}`;
    const client = new PrismaClient({ datasources: { db: { url } } });
    await client.$executeRawUnsafe('ALTER TABLE "voucher" ADD COLUMN "legacy_note" TEXT');
    await client.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)');
    await client.$disconnect();

    const alteredArchive = join(dir, 'altered.walaabk');
    await writeArchive(restored, alteredArchive, KEY);

    const result = await restoreArchive(alteredArchive, altered, KEY);
    expect(result.integrity).toBe('ok');
    expect(result.schemaMatchesBuild).toBe(false);
  });
});

/* ── The staging sweep ────────────────────────────────────────────────────────── */

describe('scratch left by a killed backup', () => {
  /**
   * `runBackup` clears its snapshot and archive in a `finally`, which covers an error
   * and nothing at all for a killed process. Three force-kills part-way through backups
   * of a 400 MB database left 571,223,796 bytes of orphaned scratch that nothing would
   * ever have removed — §12.15's full disk, manufactured by the mechanism meant to
   * prevent it, in a directory the Backup screen does not show.
   */
  it('is reclaimed by the next run, and the run records how much', async () => {
    const local = tempDir('walaa-staging-sweep-');
    const staging = join(loadEnv().BACKUP_LOCAL_DIR!, '.staging');

    // Exactly what a killed run leaves: a snapshot and a uniquely-named partial archive.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, 'snapshot.db'), Buffer.alloc(64 * 1024, 1));
    writeFileSync(join(staging, 'walaa-2026-01-01T00-00-00-000Z.walaabk'), Buffer.alloc(32 * 1024, 2));
    const orphaned = 96 * 1024;

    await sellAndQualify('DUR-SWEEP-1');
    const run = await runBackup({ merchantId: world.merchantId, actorUserId: world.ownerId }, [
      new LocalDirectoryDestination('local', local, 'local'),
    ]);
    expect(run.ok).toBe(true);

    // Nothing of the previous run's is still there. The current run cleans up after
    // itself too, so the directory is empty rather than merely smaller.
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(staging)).toEqual([]);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: AUDIT_ACTIONS.BACKUP_COMPLETED, entityId: run.name },
    });
    expect(JSON.parse(audit.afterJson!).staleStagingReclaimedBytes).toBe(orphaned);
  });

  it('does not record a reclaim when there was nothing to reclaim', async () => {
    const local = tempDir('walaa-staging-clean-');
    await sellAndQualify('DUR-SWEEP-2');
    const run = await runBackup({ merchantId: world.merchantId, actorUserId: world.ownerId }, [
      new LocalDirectoryDestination('local', local, 'local'),
    ]);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: AUDIT_ACTIONS.BACKUP_COMPLETED, entityId: run.name },
    });
    expect(JSON.parse(audit.afterJson!)).not.toHaveProperty('staleStagingReclaimedBytes');
  });
});

/* ── The restore command's own guards ─────────────────────────────────────────── */

describe('the restore command', () => {
  it('rejects an unknown option rather than ignoring it', () => {
    expect(() => parseArgs(['a.walaabk', '--too'])).toThrow(/خيار غير معروف/);
  });

  it('rejects an option whose value is missing', () => {
    expect(() => parseArgs(['a.walaabk', '--to'])).toThrow(/يحتاج قيمة/);
    expect(() => parseArgs(['a.walaabk', '--key', '--force'])).toThrow(/يحتاج قيمة/);
  });

  it('parses the shape a recovery actually uses', () => {
    expect(parseArgs(['a.walaabk', '--to', 'out.db', '--key', 'AAA=', '--force'])).toEqual({
      archive: 'a.walaabk',
      to: 'out.db',
      key: 'AAA=',
      force: true,
      list: false,
      help: false,
    });
  });

  /**
   * The space guard is proportional to the archive and has no fixed floor.
   * `backup/snapshot.ts` records what a fixed floor cost: a 2 GiB constant refused to
   * boot a shop whose database was 5.4 MB. A restore has even less tolerance for that,
   * because the person running it has already lost their database.
   */
  it('asks for twice the archive contents and nothing more', () => {
    expect(requiredFreeBytes(5_400_000)).toBe(10_800_000);
    expect(requiredFreeBytes(400 * 1024 * 1024)).toBe(800 * 1024 * 1024);
    // Small databases are not held to a constant a small machine cannot meet.
    expect(requiredFreeBytes(64 * 1024)).toBe(128 * 1024);
  });
});

/* ── The snapshot carries the WAL ─────────────────────────────────────────────── */

describe('a backup taken while the shop is trading', () => {
  /**
   * The §12.17 loss, stated as the difference between two files. Measured against the
   * live development database: a plain copy of `walaa.db` held 25 transactions and none
   * of the three sales committed ten seconds earlier, while the product's own
   * `VACUUM INTO` backup restored 28. `PRAGMA integrity_check` says `ok` on the
   * deficient copy, because that check answers *is this sound*, never *is this current*.
   */
  it('contains sales committed moments before it ran', async () => {
    const dir = tempDir('walaa-wal-recency-');
    await sellAndQualify('DUR-WAL-1');

    const run = await runBackup({ merchantId: world.merchantId, actorUserId: world.ownerId }, [
      new LocalDirectoryDestination('local', dir, 'local'),
    ]);
    const result = await restoreArchive(join(dir, run.name), join(dir, 'restored.db'), KEY);

    const restoredUrl = `file:${join(dir, 'restored.db').split('\\').join('/')}`;
    const client = new PrismaClient({ datasources: { db: { url: restoredUrl } } });
    try {
      const found = await client.transaction.findFirst({ where: { invoiceId: 'DUR-WAL-1' } });
      expect(found).not.toBeNull();
      expect(found!.discountValue).toBeGreaterThan(0);
      expect(await client.voucher.count({ where: { transactionId: found!.id } })).toBe(1);
    } finally {
      await client.$disconnect();
    }

    expect(result.counts.transactions).toBeGreaterThan(0);
    expect(statSync(join(dir, 'restored.db')).size).toBeGreaterThan(0);
  });
});
