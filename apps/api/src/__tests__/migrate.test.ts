import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import {
  findRepoEnvFile,
  resolveDataDir,
  resolveMigrationsDir,
  resolveStationDir,
  sqlitePathFromUrl,
} from '../config/paths';
import {
  applyPendingMigrations,
  migrationChecksum,
  readMigrationDirectory,
  splitSqlStatements,
} from '../lib/migrate';

/**
 * The packaging spike's central claim, tested rather than asserted: a machine with
 * **no Prisma CLI, no repository and no database file** can be brought to a working
 * schema by the service itself (CLAUDE_v3.md §12.3, §12.11).
 *
 * The interesting case is the fresh one. `prisma migrate deploy` is what provisions
 * every database in development and in CI, so nothing else in the suite would notice
 * if the runtime migrator quietly disagreed with it.
 */

const temporaryDirectories: string[] = [];
const clients: PrismaClient[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'walaa-migrate-'));
  temporaryDirectories.push(dir);
  return dir;
}

/** A client bound to its own file, so these tests never touch the shared test DB. */
function clientFor(databaseFile: string): PrismaClient {
  // Forward slashes: Prisma takes everything after `file:` as a literal path, and a
  // Windows backslash inside a connection string is read as an escape.
  const client = new PrismaClient({
    datasourceUrl: `file:${databaseFile.replace(/\\/g, '/')}`,
  });
  clients.push(client);
  return client;
}

afterAll(async () => {
  for (const client of clients) await client.$disconnect();
  for (const dir of temporaryDirectories) rmSync(dir, { recursive: true, force: true });
});

describe('statement splitting', () => {
  it('splits on semicolons and drops comments', () => {
    const statements = splitSqlStatements(`
      -- CreateTable
      CREATE TABLE "a" ("id" TEXT NOT NULL PRIMARY KEY);

      /* block comment; with a semicolon */
      CREATE UNIQUE INDEX "a_id_key" ON "a"("id");
    `);

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('CREATE TABLE');
    expect(statements[0]).not.toContain('CreateTable');
    expect(statements[1]).toContain('CREATE UNIQUE INDEX');
  });

  it('does not split on a semicolon inside a string literal', () => {
    const statements = splitSqlStatements(`INSERT INTO "a" VALUES ('x;y'); SELECT 1;`);

    expect(statements).toHaveLength(2);
    expect(statements[0]).toBe(`INSERT INTO "a" VALUES ('x;y')`);
  });

  it('keeps an escaped quote inside a literal', () => {
    const statements = splitSqlStatements(`INSERT INTO "a" VALUES ('it''s; fine');`);

    expect(statements).toHaveLength(1);
    expect(statements[0]).toBe(`INSERT INTO "a" VALUES ('it''s; fine')`);
  });

  it('parses the committed migration into executable statements', () => {
    const directory = resolveMigrationsDir();
    expect(directory).not.toBeNull();

    const migrations = readMigrationDirectory(directory as string);
    expect(migrations.length).toBeGreaterThan(0);

    for (const migration of migrations) {
      const statements = splitSqlStatements(migration.sql);
      expect(statements.length).toBeGreaterThan(0);
      // A stray separator would leave an empty fragment that SQLite rejects.
      expect(statements.every((statement) => statement.trim().length > 0)).toBe(true);
    }
  });
});

describe('checksum compatibility with the Prisma CLI', () => {
  it('computes the same checksum the CLI recorded for the committed migration', async () => {
    // The shared test database was provisioned by `prisma migrate deploy`
    // (helpers/db.ts). If our algorithm differed, the runtime migrator would either
    // re-apply a migration that is already applied or flag phantom drift on a
    // database the CLI had touched.
    const prisma = new PrismaClient();
    try {
      const rows = await prisma.$queryRawUnsafe<{ migration_name: string; checksum: string }[]>(
        'SELECT migration_name, checksum FROM "_prisma_migrations"',
      );
      expect(rows.length).toBeGreaterThan(0);

      const directory = resolveMigrationsDir() as string;
      const onDisk = new Map(
        readMigrationDirectory(directory).map((m) => [m.name, migrationChecksum(m.sql)]),
      );

      for (const row of rows) {
        expect(onDisk.get(row.migration_name)).toBe(row.checksum);
      }
    } finally {
      await prisma.$disconnect();
    }
  });
});

describe('provisioning a database that does not exist yet', () => {
  it('creates the file, applies every migration, and records them', async () => {
    const dir = scratch();
    const file = join(dir, 'fresh.db');
    expect(existsSync(file)).toBe(false);

    const client = clientFor(file);
    const outcome = await applyPendingMigrations({ client });

    expect(outcome.applied.length).toBeGreaterThan(0);
    expect(outcome.skipped).toHaveLength(0);
    expect(existsSync(file)).toBe(true);

    // The schema is real: the core tables of the v3 model are queryable.
    const tables = await client.$queryRawUnsafe<{ name: string }[]>(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    );
    const names = tables.map((t) => t.name);
    for (const expected of [
      'merchant',
      'branch',
      'user',
      'customer',
      'transaction',
      'discount_rule',
      'voucher',
      'audit_log',
      '_prisma_migrations',
    ]) {
      expect(names).toContain(expected);
    }

    // And it is writable end to end, not merely present.
    await client.merchant.create({
      data: { id: 'm-fresh', name: 'سوبرماركت الاختبار', updatedAt: new Date() },
    });
    expect(await client.merchant.count()).toBe(1);
  });

  it('is idempotent — a second run applies nothing', async () => {
    const dir = scratch();
    const client = clientFor(join(dir, 'twice.db'));

    const first = await applyPendingMigrations({ client });
    const second = await applyPendingMigrations({ client });

    expect(second.applied).toHaveLength(0);
    expect(second.skipped).toEqual(first.applied);
  });

  it('refuses to boot when an applied migration file has changed', async () => {
    const dir = scratch();
    const client = clientFor(join(dir, 'drift.db'));

    // A private copy of the real migrations, so the tampering stays in the temp dir.
    const source = resolveMigrationsDir() as string;
    const migrations = readMigrationDirectory(source);
    const copy = join(dir, 'migrations');
    mkdirSync(copy, { recursive: true });
    writeFileSync(join(copy, 'migration_lock.toml'), 'provider = "sqlite"\n');
    for (const migration of migrations) {
      mkdirSync(join(copy, migration.name), { recursive: true });
      writeFileSync(join(copy, migration.name, 'migration.sql'), migration.sql);
    }

    await applyPendingMigrations({ client, directory: copy });

    const tampered = join(copy, migrations[0]?.name ?? '', 'migration.sql');
    writeFileSync(tampered, `${readFileSync(tampered, 'utf8')}\n-- edited after the fact\n`);

    await expect(applyPendingMigrations({ client, directory: copy })).rejects.toThrow(/البصمة/);
  });

  it('rolls the whole migration back when one statement fails', async () => {
    const dir = scratch();
    const client = clientFor(join(dir, 'partial.db'));

    const broken = join(dir, 'broken');
    mkdirSync(join(broken, '20260101000000_broken'), { recursive: true });
    writeFileSync(join(broken, 'migration_lock.toml'), 'provider = "sqlite"\n');
    writeFileSync(
      join(broken, '20260101000000_broken', 'migration.sql'),
      `CREATE TABLE "good" ("id" TEXT NOT NULL PRIMARY KEY);\nTHIS IS NOT SQL;\n`,
    );

    await expect(applyPendingMigrations({ client, directory: broken })).rejects.toThrow();

    // The first statement must not have survived: a half-applied migration would make
    // every subsequent boot fail on "table already exists" with no way forward.
    const tables = await client.$queryRawUnsafe<{ name: string }[]>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'good'`,
    );
    expect(tables).toHaveLength(0);
  });
});

describe('finding the built Loyalty Station', () => {
  it('accepts a directory that holds a built bundle', () => {
    const dir = scratch();
    mkdirSync(join(dir, 'station', 'assets'), { recursive: true });
    writeFileSync(join(dir, 'station', 'index.html'), '<!doctype html>');

    expect(resolveStationDir(dir)).toBe(join(dir, 'station'));
  });

  it('refuses a SOURCE directory that merely has an index.html', () => {
    // Vite keeps an index.html in the project root as its dev template, and its only
    // script tag points at `/src/main.tsx` — unbundled TypeScript no browser can run.
    // Matching on the HTML alone served that file in development, and in production
    // would have surfaced as a blank screen on a merchant's tablet.
    const dir = scratch();
    mkdirSync(join(dir, 'apps', 'station', 'src'), { recursive: true });
    writeFileSync(join(dir, 'apps', 'station', 'index.html'), '<script src="/src/main.tsx">');

    expect(resolveStationDir(dir)).toBeNull();
  });

  it('prefers the build output when both exist', () => {
    const dir = scratch();
    mkdirSync(join(dir, 'apps', 'station', 'dist', 'assets'), { recursive: true });
    writeFileSync(join(dir, 'apps', 'station', 'index.html'), '<script src="/src/main.tsx">');
    writeFileSync(join(dir, 'apps', 'station', 'dist', 'index.html'), '<!doctype html>');

    expect(resolveStationDir(dir)).toBe(join(dir, 'apps', 'station', 'dist'));
  });

  it('returns null when nothing is built — a normal state, not an error', () => {
    // During development the Station runs on its own Vite server, and the API has no
    // business serving a stale copy of it.
    expect(resolveStationDir(scratch())).toBeNull();
  });
});

describe('path resolution', () => {
  it('finds the repository .env only next to the workspace marker', () => {
    const found = findRepoEnvFile();
    expect(found).not.toBeNull();
    expect(found as string).toMatch(/\.env$/);

    // From a directory outside the repo there is no development fallback — which is
    // what stops an installed service from picking up a stray .env off a drive root.
    expect(findRepoEnvFile(scratch())).toBeNull();
  });

  it('falls back to a real ProgramData path when PROGRAMDATA is not set', () => {
    // `'C:\ProgramData'` written with one backslash evaluates to `C:ProgramData`,
    // a relative path — the service would then create its database beside whatever
    // directory it happened to start in. The bug is invisible on any machine where
    // PROGRAMDATA is set, which is every machine except a stripped service host.
    const previousData = process.env.WALAA_DATA_DIR;
    const previousProgramData = process.env.PROGRAMDATA;
    delete process.env.WALAA_DATA_DIR;
    delete process.env.PROGRAMDATA;
    try {
      const dir = resolveDataDir();
      expect(isAbsolute(dir)).toBe(true);
      // `isAbsolute` is the assertion that matters: the bug produced
      // `C:ProgramDataWalaa`, a DRIVE-RELATIVE path, which is not absolute.
      expect(dir.endsWith('Walaa')).toBe(true);
    } finally {
      if (previousData !== undefined) process.env.WALAA_DATA_DIR = previousData;
      if (previousProgramData !== undefined) process.env.PROGRAMDATA = previousProgramData;
    }
  });

  it('reads a Windows-absolute path out of a file: URL without mangling the drive', () => {
    expect(sqlitePathFromUrl('file:C:/ProgramData/Walaa/walaa.db')).toBe(
      'C:/ProgramData/Walaa/walaa.db',
    );
    expect(sqlitePathFromUrl('file:./walaa.db')).toBe('./walaa.db');
    expect(sqlitePathFromUrl('postgresql://localhost/walaa')).toBeNull();
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A MIGRATION MUST NOT DESTROY DATA IT DOES NOT MENTION — §10.1
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * **The gap this closes.** Every other test in this file migrates a *fresh* database,
 * where there is nothing to destroy. That is the interesting case for provisioning and
 * it is blind to the failure that prompted these tests: a migration that silently
 * deletes rows in a table it never names.
 *
 * The specific hazard, which is real and was reproduced before this test was written:
 * `prisma migrate dev` emits a `RedefineTables` block for a dropped SQLite column —
 * CREATE new_ / INSERT SELECT / DROP TABLE / RENAME. On this schema that cascades
 * `voucher` out of existence, because `voucher.transaction_id` is ON DELETE CASCADE,
 * `migrate.ts` runs the whole migration inside one transaction, and `PRAGMA
 * foreign_keys` is a no-op inside a transaction — so Prisma's own `foreign_keys=OFF`
 * never takes effect and `DROP TABLE`'s implicit DELETE fires the cascade. It commits
 * successfully while doing it, so fail-closed never trips and nothing else in this
 * suite would notice.
 *
 * What is asserted is deliberately not "the v4 migration is correct". It is the
 * invariant that outlives it: **a customer's vouchers, transactions and recorded
 * discounts survive whatever migrations are pending.** A future migration that
 * reintroduces the pattern fails here regardless of which column it was dropping.
 */
describe('migrations preserve existing merchant data (§10.1)', () => {
  it('leaves vouchers, transactions and discount figures intact', async () => {
    const dir = scratch();
    const databaseFile = join(dir, 'walaa.db');
    const client = clientFor(databaseFile);

    const migrations = readMigrationDirectory(resolveMigrationsDir() as string);
    // Everything except the newest. That leaves a database shaped like a merchant's
    // before an upgrade — which is the only state in which this class of bug exists.
    const previous = migrations.slice(0, -1);
    const pending = migrations[migrations.length - 1];
    expect(pending).toBeDefined();

    const previousDir = join(dir, 'previous');
    mkdirSync(previousDir, { recursive: true });
    for (const migration of previous) {
      const target = join(previousDir, migration.name);
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, 'migration.sql'), migration.sql, 'utf8');
    }

    await applyPendingMigrations({ client, directory: previousDir });

    // A shop's data, written through raw SQL because the Prisma client is generated
    // against the NEW schema and would refuse to write the old one's columns. That is
    // the point: this row has to be shaped like a real pre-upgrade row.
    const merchantId = '00000000-0000-4000-8000-0000000000aa';
    const branchId = '00000000-0000-4000-8000-0000000000bb';
    const customerId = '00000000-0000-4000-8000-0000000000cc';
    const transactionId = '00000000-0000-4000-8000-0000000000dd';
    const voucherId = '00000000-0000-4000-8000-0000000000ee';
    const now = new Date().toISOString();

    await client.$executeRawUnsafe(
      `INSERT INTO "merchant" ("id","name","timezone","currency","created_at","updated_at")
       VALUES (?,?,?,?,?,?)`,
      merchantId, 'سوبرماركت الاختبار', 'Asia/Baghdad', 'IQD', now, now,
    );
    await client.$executeRawUnsafe(
      `INSERT INTO "branch" ("id","merchant_id","name","code","is_active","created_at","updated_at")
       VALUES (?,?,?,?,?,?,?)`,
      branchId, merchantId, 'فرع الاختبار', 'BAG-01', 1, now, now,
    );
    await client.$executeRawUnsafe(
      `INSERT INTO "customer" ("id","merchant_id","name","phone","category","is_active","created_at","updated_at")
       VALUES (?,?,?,?,?,?,?,?)`,
      customerId, merchantId, 'زينب عبد الرزاق', '+9647811239876', 'VIP', 1, now, now,
    );
    // `period_key` is written because the OLD schema requires it — this is a
    // pre-upgrade row, and the migration under test is the thing that removes it.
    await client.$executeRawUnsafe(
      `INSERT INTO "transaction"
         ("id","merchant_id","branch_id","customer_id","invoice_id","amount_gross",
          "discount_type","discount_rate","discount_value","discount_uncapped_value",
          "amount_net","currency","capture_mode","period_key","occurred_at","captured_at",
          "linked_at","created_at")
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      transactionId, merchantId, branchId, customerId, 'INV-LEGACY', 185_000,
      'PERCENTAGE', 3, 5_000, 5_550,
      180_000, 'IQD', 'SPOOL_WATCH', '2026-08', now, now,
      now, now,
    );
    await client.$executeRawUnsafe(
      `INSERT INTO "voucher"
         ("id","merchant_id","transaction_id","customer_id","code","value",
          "settlement_strategy","status","issued_at","created_at","updated_at")
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      voucherId, merchantId, transactionId, customerId, 'WLA-LEGACY-1', 5_000,
      'MERCHANT_DEFINED', 'ISSUED', now, now, now,
    );

    const countRow = async (table: string): Promise<number> => {
      const rows = await client.$queryRawUnsafe<Array<{ n: bigint | number }>>(
        `SELECT COUNT(*) AS n FROM "${table}"`,
      );
      return Number(rows[0]?.n ?? 0);
    };

    expect(await countRow('voucher')).toBe(1);
    expect(await countRow('transaction')).toBe(1);

    // ── The upgrade ────────────────────────────────────────────────────────────
    const outcome = await applyPendingMigrations({ client });
    expect(outcome.applied).toContain(pending?.name);

    // ── What must have survived ────────────────────────────────────────────────
    //
    // The voucher is the assertion that matters. It is the record that explains a
    // discount a customer already received (§0 rule 3), and the destructive migration
    // pattern removes it without a word.
    expect(await countRow('voucher'), 'the voucher explaining an already-given discount').toBe(1);
    expect(await countRow('transaction')).toBe(1);
    expect(await countRow('customer')).toBe(1);

    const vouchers = await client.$queryRawUnsafe<Array<{ code: string; value: number; status: string }>>(
      `SELECT "code","value","status" FROM "voucher"`,
    );
    expect(vouchers[0]?.code).toBe('WLA-LEGACY-1');
    expect(vouchers[0]?.value).toBe(5_000);
    expect(vouchers[0]?.status).toBe('ISSUED');

    // A discount already given and printed is never recomputed (§1.6 step 4). These
    // four figures are what a merchant's books were reconciled against.
    const transactions = await client.$queryRawUnsafe<
      Array<{
        invoice_id: string;
        amount_gross: number;
        discount_type: string;
        discount_rate: number;
        discount_value: number;
        discount_uncapped_value: number;
        amount_net: number;
      }>
    >(`SELECT * FROM "transaction"`);
    const row = transactions[0];
    expect(row?.invoice_id).toBe('INV-LEGACY');
    expect(row?.amount_gross).toBe(185_000);
    expect(row?.discount_type).toBe('PERCENTAGE');
    expect(row?.discount_rate).toBe(3);
    expect(row?.discount_value).toBe(5_000);
    expect(row?.discount_uncapped_value).toBe(5_550);
    expect(row?.amount_net).toBe(180_000);

    // And the column really is gone, so this test cannot pass by the migration
    // silently doing nothing at all.
    const columns = await client.$queryRawUnsafe<Array<{ name: string }>>(
      `PRAGMA table_info("transaction")`,
    );
    expect(columns.map((c) => c.name)).not.toContain('period_key');
  });
});
