/**
 * Fails the build if the demo database would migrate anything on first launch.
 *
 * ── Why this is a build gate and not a runtime concern ───────────────────────
 *
 * A merchant's very first launch ran six migrations. That is wrong on its own — the
 * shipped database should already be the shape the shipped binary expects — but it
 * was also the trigger for a total outage: `ensureDatabaseReady` takes a
 * pre-migration snapshot before applying anything, the snapshot's free-space guard
 * refused, and the API exited 1 on a thirty-second loop forever.
 *
 * Recalibrating that guard was necessary and is done. It is not sufficient: a first
 * launch that migrates is a first launch that can fail for reasons the build could
 * have caught. So the build catches it.
 *
 * ── Why the ledger was empty ─────────────────────────────────────────────────
 *
 * The demo database is created by Prisma tooling, and the runtime uses its OWN
 * migrator — a hand-rolled one that reads and writes the same `_prisma_migrations`
 * table. Seeding produced a schema that was completely up to date with a ledger that
 * recorded none of it, so every migration on disk looked pending. Running
 * `ensureDatabaseReady` against the file once, at build time, reconciles the two.
 *
 *   pnpm --filter @loyalty-pro/api db:seed:demo   (runs this at the end)
 *   node packaging/scripts/stage.mjs        (runs it again before shipping the file)
 */

import { basename } from 'node:path';
import { prisma } from '../src/lib/prisma';
import { ensureDatabaseReady, listPendingMigrations } from '../src/lib/migrate';
import {
  DEMO_DATABASE_BASENAME,
  openDatabaseFile,
  readDemoProvenance,
} from '../src/lib/demo-guard';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  if (!/demo/i.test(url)) {
    throw new Error(`refusing to touch "${url}" — this only ever runs against a demo database`);
  }

  /*
    ── Name the file, at both ends ─────────────────────────────────────────────

    This assertion once reported "0 pending migrations" while the installed product
    applied six on its first launch. Both statements were true. They were about
    different files: the build checked `loyalty-pro-demo.db`, and the service opened
    `loyalty-pro.db`. An assertion that does not say which file it examined cannot be
    caught disagreeing with the runtime, so it says so now, and the runtime guard
    prints the same line — one string to compare across the two.
  */
  const file = await openDatabaseFile();
  console.error(`  database:   ${file}`);

  if (basename(file) !== DEMO_DATABASE_BASENAME) {
    console.error('');
    console.error(`  BUILD FAILED: the demo database must be named ${DEMO_DATABASE_BASENAME}.`);
    console.error(`  The runtime guard opens that name and nothing else; this file is`);
    console.error(`  "${basename(file)}", so the shipped seed would never be adopted.`);
    console.error('');
    process.exitCode = 1;
    return;
  }

  // Reconcile first: apply anything outstanding and record it in the ledger, so the
  // shipped file is genuinely current rather than merely asserted to be.
  const outcome = await ensureDatabaseReady({ log: (m) => console.error(`  ${m}`) });
  if (outcome.applied.length > 0) {
    console.error(`  reconciled ${outcome.applied.length} migration(s) into the demo database`);
  }

  const pending = await listPendingMigrations();
  if (pending.length > 0) {
    console.error('');
    console.error('  BUILD FAILED: the demo database has pending migrations.');
    console.error('  A first launch must never migrate anything.');
    for (const name of pending) console.error(`    - ${name}`);
    console.error('');
    process.exitCode = 1;
    return;
  }

  const provenance = await readDemoProvenance();
  if (!provenance) {
    console.error('');
    console.error('  BUILD FAILED: the demo database carries no provenance marker.');
    console.error('  The runtime refuses any demo database it cannot prove it placed,');
    console.error('  so shipping this file would produce an installer that will not start.');
    console.error('  Rebuild it with `pnpm --filter @loyalty-pro/api db:seed:demo`.');
    console.error('');
    process.exitCode = 1;
    return;
  }

  console.error(`  seed id:    ${provenance.seedId} (built ${provenance.builtAt})`);
  console.error('  demo database: 0 pending migrations');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
