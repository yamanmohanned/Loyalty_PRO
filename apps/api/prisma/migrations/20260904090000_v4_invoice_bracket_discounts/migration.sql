-- v4: the discount is decided by the invoice amount alone (CLAUDE_UPDATE_4.md §1.1).
--
-- Nothing accumulates any more, so the period window that spend accumulated over is
-- gone and so is the key every transaction carried to say which window it counted
-- toward. Reporting windows come from `ReportRange` instead (§10.6).
--
-- ═══════════════════════════════════════════════════════════════════════════════
--  WHY THIS IS `DROP COLUMN` AND NOT PRISMA'S `RedefineTables` BLOCK — §10.1
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- `prisma migrate dev` will hand the next person a RedefineTables block for exactly
-- this change: CREATE new_ / INSERT SELECT / DROP TABLE / RENAME, opening with
-- `PRAGMA defer_foreign_keys=ON; PRAGMA foreign_keys=OFF;`. **On this schema that is
-- destructive, and it commits successfully while being so.**
--
--   * `voucher.transaction_id -> transaction.id` is ON DELETE CASCADE.
--   * `migrate.ts` runs every statement of a migration inside ONE transaction.
--   * `PRAGMA foreign_keys` is a no-op inside a transaction — so the OFF never takes
--     effect, and `defer_foreign_keys` defers only *violation checking*, never the
--     cascade ACTION.
--   * `DROP TABLE` performs an implicit DELETE FROM, which fires that cascade.
--
-- Result: every voucher in the shop deleted, no error, fail-closed never tripped, and
-- §0 rule 3's guarantee that every discount has a record explaining it broken
-- retroactively. Reproduced before writing this file; see §10.1 for the measurements.
--
-- `ALTER TABLE ... DROP COLUMN` never drops the parent table, so no implicit delete
-- happens and no cascade can fire. It needs SQLite >= 3.35; the Prisma engine in use
-- reports 3.46.0. SQLite refuses to drop a column an index still references, which is
-- why the index goes first.
--
-- Historical discounts are untouched by design (§1.6 step 4): `discount_type`,
-- `discount_rate`, `discount_value` and `discount_uncapped_value` are not read or
-- written here. A discount that was already given and printed is never recomputed.

-- The only index over `period_key`. Dropping it is not a loss: the query it served —
-- cumulative spend for one customer inside a period — no longer exists.
DROP INDEX "transaction_customer_id_period_key_idx";

ALTER TABLE "transaction" DROP COLUMN "period_key";

-- The window itself. A merchant has nothing left to configure here: there is no
-- accumulation to bound, and keeping a fixed MONTHLY value the API could never change
-- would leave a dead setting looking like a live control (§10.6).
ALTER TABLE "discount_settings" DROP COLUMN "period_type";
ALTER TABLE "discount_settings" DROP COLUMN "period_start";
ALTER TABLE "discount_settings" DROP COLUMN "period_end";
