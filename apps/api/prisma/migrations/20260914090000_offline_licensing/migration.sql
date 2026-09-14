-- Offline licensing (packaging/LICENSING.md).
--
-- Two new tables and nothing else: additive, so no existing table is rebuilt (§10.1).
--
-- `license_activation` is every licence code activated on this installation. The status
-- is never read from its columns: the Rust licensing module re-verifies each stored
-- `code` on every check and chooses the governing licence from the codes themselves.
-- The other columns exist for the Settings screen's history, and editing them changes
-- nothing but what that list shows.
--
-- `installation_state` is one row: the device ID computed on first start, one-way
-- digests of the two sources it came from (so a replaced drive can be named in the
-- audit trail without storing the GUID or the serial), and the database's copy of the
-- latest time this installation has observed — one of the three clock anchors.
CREATE TABLE "license_activation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "license_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "issued_at" DATETIME NOT NULL,
    "expires_at" DATETIME,
    "features" TEXT NOT NULL,
    "note" TEXT,
    "code" TEXT NOT NULL,
    "activated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activated_by" TEXT
);

CREATE TABLE "installation_state" (
    "id" INTEGER NOT NULL PRIMARY KEY,
    "device_id" TEXT NOT NULL,
    "machine_guid_digest" TEXT NOT NULL,
    "volume_serial_digest" TEXT NOT NULL,
    "device_computed_at" DATETIME NOT NULL,
    "last_seen_at" DATETIME,
    "updated_at" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "license_activation_license_id_key" ON "license_activation"("license_id");

CREATE INDEX "license_activation_merchant_id_activated_at_idx" ON "license_activation"("merchant_id", "activated_at");
