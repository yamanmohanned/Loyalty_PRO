-- Licensing that never locks out a paying shop (packaging/LICENSING.md).
--
-- Additive only: one new table, three nullable columns.
--
-- `license_unlock` holds the emergency codes a provider reads over the phone. Like the
-- licence codes, each is re-verified by the Rust module on every check; `valid_until`
-- only feeds the history list.
--
-- The `last_status*` columns are what the gate falls back to when the licence check
-- itself fails — a missing module, a bug. A shop last seen licensed keeps trading; one
-- last seen read-only stays read-only.
CREATE TABLE "license_unlock" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "valid_until" DATETIME NOT NULL,
    "entered_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "entered_by" TEXT
);

CREATE UNIQUE INDEX "license_unlock_code_key" ON "license_unlock"("code");

ALTER TABLE "installation_state" ADD COLUMN "last_status" TEXT;
ALTER TABLE "installation_state" ADD COLUMN "last_status_until" DATETIME;
ALTER TABLE "installation_state" ADD COLUMN "last_status_at" DATETIME;
