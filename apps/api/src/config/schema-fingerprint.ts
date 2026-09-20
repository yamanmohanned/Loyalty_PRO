/**
 * The schema this build was compiled against — GENERATED, DO NOT EDIT BY HAND.
 *
 * Written by `apps/api/prisma/build-db-template.ts` (`pnpm --filter @loyalty-pro/api db:template`)
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
  '11c1100b9143272d3fb398a0d1e81d302ec446c7d3f7a497c9062ea6cc627b9d';

export const EXPECTED_SCHEMA_HASH =
  'e7f15d2251f81d0d089c0310582e12d3b7d9e5214074d66285c47f9eed7a5015';

/** When the two values above were generated, for a support call reading a log. */
export const SCHEMA_FINGERPRINT_GENERATED_AT = '2026-09-20T19:06:27.371Z';
