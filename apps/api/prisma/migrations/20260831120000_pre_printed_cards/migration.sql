-- Pre-printed physical cards (CLAUDE_v3.md §12.25).
--
-- Hand-written rather than generated, because three of the guarantees here cannot
-- be expressed in the Prisma schema and are the whole point of the change:
--
--   1. A PARTIAL unique index — one ASSIGNED card per customer.
--   2. CHECK constraints tying status to ownership and origin to serial, so a row
--      that contradicts itself cannot be written at all.
--   3. A backfill that moves every existing customer's card number off the
--      `customer` row and onto a card of its own, before the column is dropped.
--
-- Statements are separated by `;` and contain no BEGIN…END blocks, because
-- `lib/migrate.ts` splits on semicolons outside string literals.

-- CreateTable
CREATE TABLE "card_batch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "batch_number" INTEGER NOT NULL,
    "serial_start" INTEGER NOT NULL,
    "serial_end" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'GENERATED',
    "note" TEXT,
    "generated_by_user_id" TEXT,
    "generated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exported_at" DATETIME,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "card_batch_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "card_batch_generated_by_user_id_fkey" FOREIGN KEY ("generated_by_user_id") REFERENCES "user" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    -- A range that runs backwards, or whose quantity disagrees with its own
    -- endpoints, is a batch whose "how many blanks are left" answer is a lie.
    CONSTRAINT "card_batch_range_ordered" CHECK ("serial_end" >= "serial_start"),
    CONSTRAINT "card_batch_quantity_matches_range" CHECK ("quantity" = "serial_end" - "serial_start" + 1),
    -- 999,999 is the ceiling six printed digits can carry. Allocation refuses here
    -- rather than rolling over: a refusal stops the line and gets a phone call, a
    -- rollover silently re-issues a serial that is already in somebody's wallet.
    CONSTRAINT "card_batch_serial_ceiling" CHECK ("serial_end" <= 999999 AND "serial_start" >= 1)
);

-- CreateTable
CREATE TABLE "card" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "serial" INTEGER,
    "card_number" TEXT NOT NULL,
    "scheme" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PRINTED',
    "batch_id" TEXT,
    "customer_id" TEXT,
    "assigned_at" DATETIME,
    "assigned_by_user_id" TEXT,
    "lost_at" DATETIME,
    "replaced_by_card_id" TEXT,
    "voided_at" DATETIME,
    "void_reason" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "card_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "card_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "card_batch" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "card_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "card_assigned_by_user_id_fkey" FOREIGN KEY ("assigned_by_user_id") REFERENCES "user" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "card_replaced_by_card_id_fkey" FOREIGN KEY ("replaced_by_card_id") REFERENCES "card" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    -- Ownership follows state, and the two can never disagree. PRINTED stock and a
    -- VOID misprint have no owner; a card that is ASSIGNED, LOST or REPLACED always
    -- has one, because "who held this dead card" is the question support asks.
    CONSTRAINT "card_owner_matches_status" CHECK (
        ("status" IN ('PRINTED', 'VOID') AND "customer_id" IS NULL)
        OR ("status" IN ('ASSIGNED', 'LOST', 'REPLACED') AND "customer_id" IS NOT NULL)
    ),
    -- A pre-printed card is physical stock and carries a serial; a thermal card is
    -- printed on demand and must not, or it would consume a number out of the
    -- inventory the batch screen counts.
    CONSTRAINT "card_serial_matches_origin" CHECK (
        ("origin" = 'PRE_PRINTED' AND "serial" IS NOT NULL AND "batch_id" IS NOT NULL)
        OR ("origin" = 'THERMAL' AND "serial" IS NULL AND "batch_id" IS NULL)
    ),
    CONSTRAINT "card_status_known" CHECK ("status" IN ('PRINTED', 'ASSIGNED', 'LOST', 'REPLACED', 'VOID')),
    CONSTRAINT "card_origin_known" CHECK ("origin" IN ('PRE_PRINTED', 'THERMAL')),
    CONSTRAINT "card_scheme_known" CHECK ("scheme" IN ('card.v1', 'card.v2')),
    CONSTRAINT "card_serial_in_range" CHECK ("serial" IS NULL OR ("serial" >= 1 AND "serial" <= 999999)),
    CONSTRAINT "card_number_is_sixteen_digits" CHECK (length("card_number") = 16)
);

-- CreateIndex
CREATE UNIQUE INDEX "card_batch_merchant_id_batch_number_key" ON "card_batch"("merchant_id", "batch_number");

-- CreateIndex
CREATE INDEX "card_batch_merchant_id_generated_at_idx" ON "card_batch"("merchant_id", "generated_at");

-- CreateIndex
-- The hard guarantee against overlapping batch ranges. Every serial in a batch is a
-- row, so a second batch covering the same numbers fails on INSERT. The range on
-- `card_batch` is a summary of rows that exist, never an independent claim.
CREATE UNIQUE INDEX "card_merchant_id_serial_key" ON "card"("merchant_id", "serial");

-- CreateIndex
CREATE UNIQUE INDEX "card_merchant_id_card_number_key" ON "card"("merchant_id", "card_number");

-- CreateIndex
CREATE UNIQUE INDEX "card_replaced_by_card_id_key" ON "card"("replaced_by_card_id");

-- CreateIndex
CREATE INDEX "card_card_number_idx" ON "card"("card_number");

-- CreateIndex
CREATE INDEX "card_merchant_id_status_idx" ON "card"("merchant_id", "status");

-- CreateIndex
CREATE INDEX "card_batch_id_status_idx" ON "card"("batch_id", "status");

-- CreateIndex
CREATE INDEX "card_customer_id_idx" ON "card"("customer_id");

-- CreateIndex
-- ONE LIVE CARD PER CUSTOMER, kept by the database rather than remembered by code.
--
-- Prisma cannot express a partial unique index, which is why this migration is
-- hand-written. Two consequences worth knowing before anybody edits it:
--
--   * A replacement MUST retire the old card before the new one can be assigned.
--     The index refuses the intermediate state, so the correct order is forced
--     rather than merely documented.
--   * Restoring a LOST card is safe wherever it is possible at all: a customer who
--     has already been issued a live replacement simply cannot acquire a second
--     live card, and the attempt fails here rather than quietly succeeding.
CREATE UNIQUE INDEX "card_one_active_per_customer" ON "card"("merchant_id", "customer_id") WHERE "status" = 'ASSIGNED';

-- Backfill: every existing customer keeps the exact number already on their card.
--
-- They are THERMAL and `card.v1` because that is what they are — numbers minted by
-- the random-payload scheme and printed on paper. Giving them serials would put
-- paper cards into the physical-stock count the batch screen exists to answer.
--
-- SQLite has no uuid(), so the id is assembled from randomblob in the RFC 4122 v4
-- layout. These ids are never parsed, only compared.
INSERT INTO "card" (
    "id", "merchant_id", "serial", "card_number", "scheme", "origin", "status",
    "batch_id", "customer_id", "assigned_at", "created_at", "updated_at"
)
SELECT
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-a' ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
    "merchant_id",
    NULL,
    "barcode_token",
    'card.v1',
    'THERMAL',
    'ASSIGNED',
    NULL,
    "id",
    "created_at",
    "created_at",
    CURRENT_TIMESTAMP
FROM "customer";

-- DropIndex
DROP INDEX "customer_barcode_token_key";

-- AlterTable
ALTER TABLE "customer" DROP COLUMN "barcode_token";
