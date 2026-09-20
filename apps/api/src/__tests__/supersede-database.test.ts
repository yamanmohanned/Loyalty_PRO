import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '../config/env';
import { resolveDatabaseTemplate } from '../config/paths';
import { censusEveryTable, supersedeUnusableDatabase } from '../lib/supersede-database';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE TRIAGE THAT DECIDES WHETHER A DATABASE IS EXPENDABLE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── Why this one is worth a suite of its own ─────────────────────────────────
 *
 * Every other guard in this product fails closed by refusing to start. This one can
 * MOVE A MERCHANT'S DATABASE. That it renames rather than deletes is the safety net,
 * not the safety property — the property is that it never decides "expendable" about a
 * file that holds anything.
 *
 * So the interesting cases are all the ones where it must decline, and they are asked
 * of real SQLite files on disk rather than of a mock: the failure this replaces came
 * from a census that could not see a table it did not know the name of, which is
 * exactly the thing a mocked client would have been happy to pretend about.
 */

const scratches: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'walaa-supersede-'));
  scratches.push(dir);
  return dir;
}

afterEach(() => {
  while (scratches.length > 0) {
    const dir = scratches.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** A copy of the shipped template — a real, migrated, empty database. */
function templateAt(dir: string): string {
  const template = resolveDatabaseTemplate();
  if (!template) throw new Error('no shipped template — run `pnpm --filter @loyalty-pro/api db:template`');
  const path = join(dir, 'loyalty-pro.db');
  copyFileSync(template, path);
  return path;
}

async function withClient<T>(path: string, run: (db: PrismaClient) => Promise<T>): Promise<T> {
  const db = new PrismaClient({ datasourceUrl: `file:${path}` });
  try {
    return await run(db);
  } finally {
    await db.$disconnect();
  }
}

/** Makes the file a shape this build was not compiled for, without adding a row. */
async function makeForeignShape(path: string): Promise<void> {
  await withClient(path, (db) =>
    db.$executeRawUnsafe('ALTER TABLE "customer" ADD COLUMN "columnFromAnotherRelease" TEXT'),
  );
}

/**
 * Runs the triage the way `main.ts` does — in production, on a sound build, against
 * this scratch file.
 *
 * The env cache has to be dropped on both sides. `loadEnv()` memoises, and the whole
 * point of these cases is that the triage reads its database path and its enforcement
 * from the same configuration the service does; setting `process.env` without
 * resetting would have tested the suite's own database and passed for the wrong
 * reason.
 */
async function asProduction<T>(
  databasePath: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = { url: process.env.DATABASE_URL, env: process.env.NODE_ENV };
  process.env.DATABASE_URL = `file:${databasePath}`;
  process.env.NODE_ENV = 'production';
  resetEnvCache();
  try {
    return await run();
  } finally {
    process.env.DATABASE_URL = previous.url;
    process.env.NODE_ENV = previous.env;
    resetEnvCache();
  }
}

async function triage(databasePath: string, log: string[] = []) {
  return asProduction(databasePath, () =>
    supersedeUnusableDatabase((message) => log.push(message), {
      buildIsSound: true,
      demo: false,
    }),
  );
}

describe('the census', () => {
  it('sees a table this build has never heard of', async () => {
    /*
      The defect the old census had. It counted five tables BY NAME and read a missing
      one as zero, so a shop's invoices sitting in a table a later release renamed
      would have measured as "nothing here" — and authorised moving the file aside.
    */
    const path = templateAt(scratch());
    await withClient(path, async (db) => {
      await db.$executeRawUnsafe('CREATE TABLE "legacy_invoice" ("id" TEXT PRIMARY KEY)');
      await db.$executeRawUnsafe(`INSERT INTO "legacy_invoice" ("id") VALUES ('INV-1')`);
    });

    const census = await withClient(path, censusEveryTable);
    expect(census.readable).toBe(true);
    expect(census.total).toBe(1);
    expect(census.counts.legacy_invoice).toBe(1);
  });

  it('does not count its own bookkeeping as a shop', async () => {
    const path = templateAt(scratch());
    const census = await withClient(path, censusEveryTable);
    // The template ships with a full `_prisma_migrations` ledger and nothing else.
    expect(census.total).toBe(0);
    expect(Object.keys(census.counts)).not.toContain('_prisma_migrations');
    expect(Object.keys(census.counts).length).toBeGreaterThan(5);
  });

  it('reports unreadable rather than empty when the file will not answer', async () => {
    const dir = scratch();
    const path = join(dir, 'loyalty-pro.db');
    // Not a database at all — the shape a truncated copy or a half-written restore has.
    writeFileSync(path, 'this is not a SQLite file, it is a text file with a .db name');

    const census = await withClient(path, censusEveryTable);
    expect(census.readable).toBe(false);
    expect(census.total).toBe(0);
  });
});

describe('the triage', () => {
  it('leaves a database of the right shape alone', async () => {
    const path = templateAt(scratch());
    const result = await triage(path);
    expect(result.verdict).toBe('usable');
    expect(existsSync(path)).toBe(true);
  });

  it('moves an EMPTY database from another build aside and installs the template', async () => {
    const dir = scratch();
    const path = templateAt(dir);
    await makeForeignShape(path);

    const log: string[] = [];
    const result = await triage(path, log);

    expect(result.verdict).toBe('superseded');
    // Renamed beside itself, never deleted: if this judgement is ever wrong the bytes
    // are still on the disk.
    expect(result.parkedAt).toMatch(/loyalty-pro\.db\.superseded-/);
    expect(existsSync(result.parkedAt ?? '')).toBe(true);
    // And a usable database is in its place, so the merchant meets the setup screen
    // rather than a refusal.
    expect(existsSync(path)).toBe(true);
    const after = await withClient(path, censusEveryTable);
    expect(after.total).toBe(0);
    // And it is genuinely THIS build's schema, not the old one with its rows removed:
    // the column that made it foreign is gone. (`COUNT` comes back as a BigInt here —
    // `Number()`, because `0n` and `0` are not equal and a green assertion that reads
    // right and compares wrong is worse than a red one.)
    const foreignColumn = await withClient(path, (db) =>
      db.$queryRawUnsafe<Array<{ n: unknown }>>(
        `SELECT COUNT(*) AS n FROM pragma_table_info('customer') WHERE name = 'columnFromAnotherRelease'`,
      ),
    );
    expect(Number(foreignColumn[0]?.n)).toBe(0);
  });

  it('REFUSES to touch a database from another build that holds even one row', async () => {
    const dir = scratch();
    const path = templateAt(dir);
    await makeForeignShape(path);
    await withClient(path, (db) =>
      db.$executeRawUnsafe(
        // Columns as the SHIPPED schema names them (`created_at`, `updated_at`), not
        // as Prisma's model names them. This is raw SQL against a real file.
        `INSERT INTO "merchant" ("id","name","created_at","updated_at")
         VALUES ('m1','متجر','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
      ),
    );

    const result = await triage(path);
    expect(result.verdict).toBe('holds-data');
    expect(result.census?.total).toBe(1);
    expect(readdirSync(dir).filter((f) => f.includes('superseded'))).toEqual([]);
  });

  it('REFUSES when the file cannot be read, rather than reading that as empty', async () => {
    const dir = scratch();
    const path = join(dir, 'loyalty-pro.db');
    writeFileSync(path, 'not a database');

    const result = await triage(path);
    expect(result.verdict).toBe('unreadable');
    expect(readdirSync(dir).filter((f) => f.includes('superseded'))).toEqual([]);
  });

  it('REFUSES when this build cannot vouch for its own migration set', async () => {
    /*
      The schema disagreeing may mean the PROGRAM is wrong rather than the file, and
      replacing a merchant's database to cure a packaging fault would destroy data to
      fix something that was never in the data — and fail identically afterwards.
    */
    const dir = scratch();
    const path = templateAt(dir);
    await makeForeignShape(path);

    const result = await asProduction(path, () =>
      supersedeUnusableDatabase(() => {}, { buildIsSound: false, demo: false }),
    );
    expect(result.verdict).toBe('not-applicable');
    expect(readdirSync(dir).filter((f) => f.includes('superseded'))).toEqual([]);
  });

  it('does nothing outside production, where a schema legitimately changes', async () => {
    const dir = scratch();
    const path = templateAt(dir);
    await makeForeignShape(path);

    const previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = `file:${path}`;
    resetEnvCache();
    try {
      // NODE_ENV is `test` in this suite, so `identityEnforced()` is false.
      const result = await supersedeUnusableDatabase(() => {}, {
        buildIsSound: true,
        demo: false,
      });
      expect(result.verdict).toBe('not-applicable');
    } finally {
      process.env.DATABASE_URL = previousUrl;
      resetEnvCache();
    }
    expect(readdirSync(dir).filter((f) => f.includes('superseded'))).toEqual([]);
  });
});
