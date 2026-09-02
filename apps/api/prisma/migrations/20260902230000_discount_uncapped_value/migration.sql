-- What the discount ladder called for before a cap trimmed it (CLAUDE_v3.md §12.37).
--
-- §2.3's absolute ceiling, a tier's own maxDiscountValue and a basket smaller than
-- the discount all reduce what is actually given, and until now the system computed
-- that reduction and threw it away. It is the one number that says whether the
-- merchant's tier ladder is set too high, so it is now kept.
ALTER TABLE "transaction" ADD COLUMN "discount_uncapped_value" INTEGER NOT NULL DEFAULT 0;

-- Backfill: for every existing row the uncapped figure is unknown, and the honest
-- value is the one that was actually applied. That makes historical rows read as
-- "nothing was trimmed", which is not a claim that no cap ever bound — it is the
-- absence of evidence, and it keeps `uncapped >= value` true everywhere so the
-- difference can never come out negative.
UPDATE "transaction" SET "discount_uncapped_value" = "discount_value";

-- Partial index: the reports only ever ask for rows where the cap actually bit, and
-- those are a small minority of a table that grows with every sale in the shop.
CREATE INDEX "transaction_capped_idx"
  ON "transaction" ("merchant_id", "occurred_at")
  WHERE "discount_uncapped_value" > "discount_value";
