-- CreateTable
CREATE TABLE "setting_draft" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scope_id" TEXT,
    "values" TEXT NOT NULL,
    "updated_by_user_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "setting_draft_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "setting_draft_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "user" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "setting_version" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scope_id" TEXT,
    "version" INTEGER NOT NULL,
    "values" TEXT NOT NULL,
    "note" TEXT,
    "rolled_back_from" INTEGER,
    "published_by_user_id" TEXT,
    "published_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "setting_version_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "setting_version_published_by_user_id_fkey" FOREIGN KEY ("published_by_user_id") REFERENCES "user" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "setting_draft_merchant_id_scope_idx" ON "setting_draft"("merchant_id", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "setting_draft_merchant_id_scope_scope_id_key" ON "setting_draft"("merchant_id", "scope", "scope_id");

-- CreateIndex
CREATE INDEX "setting_version_merchant_id_scope_scope_id_version_idx" ON "setting_version"("merchant_id", "scope", "scope_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "setting_version_merchant_id_scope_scope_id_version_key" ON "setting_version"("merchant_id", "scope", "scope_id", "version");

-- ── The constraints above do not constrain the MERCHANT layer ────────────────
--
-- SQLite treats every NULL as distinct inside a UNIQUE index, so
-- ("merchant_id","scope","scope_id") permits any number of rows whose `scope_id` is
-- NULL — and the MERCHANT layer's `scope_id` is ALWAYS null. Without these two
-- indexes a merchant could accumulate several drafts of the same layer, and two
-- publishes racing could both write version 4; resolution would then pick whichever
-- row the query planner happened to return, so the settings in force would depend on
-- the order rows were written. Prisma cannot express a partial index, so it is here.
CREATE UNIQUE INDEX "setting_draft_merchant_scope_null_key"
  ON "setting_draft"("merchant_id", "scope") WHERE "scope_id" IS NULL;

CREATE UNIQUE INDEX "setting_version_merchant_scope_null_version_key"
  ON "setting_version"("merchant_id", "scope", "version") WHERE "scope_id" IS NULL;
