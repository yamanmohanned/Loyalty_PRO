-- Settlement default becomes MERCHANT_DEFINED (CLAUDE_v3.md §9 closed, §12.28).
--
-- A default only, and SQLite has no way to change one without rebuilding the table.
-- Existing rows keep the value they hold: a store already running on an explicit
-- strategy must not be switched by an upgrade, because the strategy decides the words
-- printed on slips its cashiers have learned to read.

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_discount_settings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "discount_type" TEXT NOT NULL DEFAULT 'PERCENTAGE',
    "min_rate" INTEGER NOT NULL DEFAULT 1,
    "max_rate" INTEGER NOT NULL DEFAULT 3,
    "absolute_max_discount_value" INTEGER NOT NULL DEFAULT 5000,
    "period_type" TEXT NOT NULL DEFAULT 'MONTHLY',
    "period_start" DATETIME,
    "period_end" DATETIME,
    "settlement_strategy" TEXT NOT NULL DEFAULT 'MERCHANT_DEFINED',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "discount_settings_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_discount_settings" ("absolute_max_discount_value", "created_at", "discount_type", "id", "max_rate", "merchant_id", "min_rate", "period_end", "period_start", "period_type", "settlement_strategy", "updated_at") SELECT "absolute_max_discount_value", "created_at", "discount_type", "id", "max_rate", "merchant_id", "min_rate", "period_end", "period_start", "period_type", "settlement_strategy", "updated_at" FROM "discount_settings";
DROP TABLE "discount_settings";
ALTER TABLE "new_discount_settings" RENAME TO "discount_settings";
CREATE UNIQUE INDEX "discount_settings_merchant_id_key" ON "discount_settings"("merchant_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
