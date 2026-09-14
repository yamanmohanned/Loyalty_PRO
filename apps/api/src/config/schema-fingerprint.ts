/**
 * The schema this build was compiled against — GENERATED, DO NOT EDIT BY HAND.
 *
 * Written by `apps/api/prisma/build-db-template.ts` (`pnpm --filter @walaa/api db:template`)
 * and checked by `src/__tests__/db-template.test.ts`, which recomputes both values from
 * the migrations on disk and from the shipped template and fails if either has drifted.
 *
 * ── What each one is for ─────────────────────────────────────────────────────
 *
 * `EXPECTED_MIGRATIONS_FINGERPRINT` describes the **build**: a hash over every
 * committed migration's name and file checksum, in order. It answers "are the migration
 * files shipped beside this binary the ones it was built with", which a database cannot
 * be asked and which a runtime directory assembled from two different builds gets wrong.
 *
 * `EXPECTED_SCHEMA_HASH` describes the **database**: a hash over `sqlite_master` — the
 * tables and indexes SQLite actually has, not the ones its migration ledger claims. A
 * file can carry a complete ledger and a schema that is something else; only this
 * catches that.
 *
 * They are separate constants because they fail separately and mean different things.
 * A migrations mismatch is a broken installation; a schema mismatch is a wrong or
 * damaged database.
 */

export const EXPECTED_MIGRATIONS_FINGERPRINT =
  '3d93269f4b3225cf18bc3eb2dbc6e2575494ec7f81a9afde0ee7808b6feef713';

export const EXPECTED_SCHEMA_HASH =
  '2d3a854bb6a10b738b32567cb01aa9151fa4422cb1597460bfbe1325e05f714f';

/** When the two values above were generated, for a support call reading a log. */
export const SCHEMA_FINGERPRINT_GENERATED_AT = '2026-09-14T22:07:08.170Z';
