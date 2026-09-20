-- CreateTable
CREATE TABLE "station" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "branch_id" TEXT,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "pairing_code_hash" TEXT,
    "pairing_expires_at" DATETIME,
    "device_token_hash" TEXT,
    "paired_at" DATETIME,
    "device_label" TEXT,
    "last_seen_at" DATETIME,
    "revoked_at" DATETIME,
    "revoked_by_user_id" TEXT,
    "created_by_user_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "station_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "station_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "station_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "station_revoked_by_user_id_fkey" FOREIGN KEY ("revoked_by_user_id") REFERENCES "user" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "station_device_token_hash_key" ON "station"("device_token_hash");

-- CreateIndex
CREATE INDEX "station_merchant_id_status_idx" ON "station"("merchant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "station_merchant_id_name_key" ON "station"("merchant_id", "name");
