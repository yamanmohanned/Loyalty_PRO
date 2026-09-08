/**
 * Builds the demo database at BUILD time.
 *
 *   pnpm --filter @walaa/api db:seed:demo
 *
 * A thin wrapper: every decision lives in `src/services/demo.service.ts`, so the shop
 * the installer ships and the shop the in-app reset restores are produced by one
 * implementation rather than by two that agree today and drift tomorrow.
 *
 * **It writes through the SAME Prisma singleton the services use**, which is bound to
 * `DATABASE_URL` at import time — so the demo file is selected by the environment, not
 * by a second client. `db:seed:demo` sets it. Constructing a private client here would
 * have been worse than useless: the services would still have written to the
 * development database while this script reported success.
 */

import { randomUUID } from 'node:crypto';
import { prisma, applySqlitePragmas } from '../src/lib/prisma';
import { ensureDatabaseReady } from '../src/lib/migrate';
import { buildDemoShop, DEMO_PASSWORD } from '../src/services/demo.service';
import { DEMO } from '../src/lib/demo-data';
import { openDatabaseFile, stampDemoProvenance } from '../src/lib/demo-guard';

async function main(): Promise<void> {
  await applySqlitePragmas(prisma);

  /*
    Create the schema if this file does not have one yet.

    Without this the script only worked on a machine that had already built a demo
    once — it opened whatever `walaa-demo.db` was lying around and assumed the tables
    existed. Deleting the file to force a clean rebuild produced
    "table main.voucher does not exist", which is a build step that cannot bootstrap
    itself. The same call the runtime uses does it properly, and on an already-seeded
    file it is a no-op.
  */
  await ensureDatabaseReady({ log: (m) => console.error(`  ${m}`) });

  // `buildDemoShop` re-checks this against the live connection; the message here is
  // the friendlier one, for whoever ran the wrong script.
  const url = process.env.DATABASE_URL ?? '';
  if (!/demo/i.test(url)) {
    throw new Error(
      `DATABASE_URL must name a demo file - refusing to seed "${url}". Run \`pnpm db:seed:demo\`.`,
    );
  }

  // eslint-disable-next-line no-console -- a build script reports to the operator by design
  const result = await buildDemoShop((line) => console.log(`  ${line}`));

  /*
    Sign the file.

    The runtime demo guard refuses to open a database that is not carrying this row, so
    "the installer placed this database" stops being an assumption about filenames and
    becomes a property of the file. The id is fresh per build and recorded rather than
    compared: a merchant upgrading from an older demo keeps his clicked-around shop,
    which an exact-match check would have thrown away.
  */
  const seedId = randomUUID();
  await stampDemoProvenance(seedId);

  // eslint-disable-next-line no-console -- a build script reports to the operator by design
  console.log(
    [
      '',
      '  -- demo build ready ----------------------------------',
      `    merchant    ${DEMO.merchantName}`,
      `    customers   ${result.customers}`,
      `    invoices    ${result.invoices}  (${result.attributed} attributed)`,
      `    vouchers    ${result.vouchersIssued} issued / ${result.vouchersRedeemed} redeemed`,
      `    window      ${DEMO.days} days`,
      `    login       owner | manager   password: ${DEMO_PASSWORD}`,
      `    file        ${await openDatabaseFile()}`,
      `    seed id     ${seedId}`,
      `    took        ${result.seconds}s`,
      '',
    ].join('\n'),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
