import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import {
  findRepoEnvFile,
  resolveDataDir,
  resolveMigrationsDir,
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
