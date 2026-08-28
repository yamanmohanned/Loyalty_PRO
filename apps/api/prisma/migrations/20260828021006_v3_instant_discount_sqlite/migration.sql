-- CreateTable
CREATE TABLE "merchant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Baghdad',
    "currency" TEXT NOT NULL DEFAULT 'IQD',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "branch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "branch_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "branch_id" TEXT,
    "name" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "user_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "user_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "refresh_token" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" DATETIME NOT NULL,
    "revoked_at" DATETIME,
    "replaced_by_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "refresh_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "customer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'REGULAR',
    "barcode_token" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "customer_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "discount_rule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "threshold_amount" INTEGER NOT NULL,
    "discount_type" TEXT NOT NULL,
    "discount_rate" INTEGER NOT NULL,
    "max_discount_value" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "discount_rule_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "discount_settings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "discount_type" TEXT NOT NULL DEFAULT 'PERCENTAGE',
    "min_rate" INTEGER NOT NULL DEFAULT 1,
    "max_rate" INTEGER NOT NULL DEFAULT 3,
    "absolute_max_discount_value" INTEGER NOT NULL DEFAULT 5000,
    "period_type" TEXT NOT NULL DEFAULT 'MONTHLY',
    "period_start" DATETIME,
    "period_end" DATETIME,
    "settlement_strategy" TEXT NOT NULL DEFAULT 'VOUCHER_AS_PAYMENT',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "discount_settings_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "transaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "customer_id" TEXT,
    "invoice_id" TEXT NOT NULL,
    "amount_gross" INTEGER NOT NULL,
    "discount_type" TEXT NOT NULL DEFAULT 'NONE',
    "discount_rate" INTEGER NOT NULL DEFAULT 0,
    "discount_value" INTEGER NOT NULL DEFAULT 0,
    "amount_net" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'IQD',
    "capture_mode" TEXT NOT NULL,
    "period_key" TEXT NOT NULL,
    "occurred_at" DATETIME NOT NULL,
    "captured_at" DATETIME NOT NULL,
    "linked_at" DATETIME,
    "station_id" TEXT,
    "linked_by_user_id" TEXT,
    "idempotency_key" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "transaction_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "transaction_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "transaction_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "transaction_linked_by_user_id_fkey" FOREIGN KEY ("linked_by_user_id") REFERENCES "user" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "voucher" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "settlement_strategy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "issued_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "redeemed_at" DATETIME,
    "redeemed_by_user_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "voucher_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "voucher_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transaction" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "voucher_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "voucher_redeemed_by_user_id_fkey" FOREIGN KEY ("redeemed_by_user_id") REFERENCES "user" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "feature_flag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT false,
    "updated_by" TEXT,
    "updated_at" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "feature_flag_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "feature_flag_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "notification_log" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'WHATSAPP',
    "template" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "sent_at" DATETIME,
    "error" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notification_log_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "notification_log_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "before_json" TEXT,
    "after_json" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_log_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "audit_log_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "user" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "branch_merchant_id_idx" ON "branch"("merchant_id");

-- CreateIndex
CREATE UNIQUE INDEX "branch_merchant_id_code_key" ON "branch"("merchant_id", "code");

-- CreateIndex
CREATE INDEX "user_merchant_id_role_idx" ON "user"("merchant_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "user_merchant_id_username_key" ON "user"("merchant_id", "username");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_token_token_hash_key" ON "refresh_token"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_token_user_id_idx" ON "refresh_token"("user_id");

-- CreateIndex
CREATE INDEX "refresh_token_expires_at_idx" ON "refresh_token"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "customer_barcode_token_key" ON "customer"("barcode_token");

-- CreateIndex
CREATE INDEX "customer_merchant_id_category_idx" ON "customer"("merchant_id", "category");

-- CreateIndex
CREATE INDEX "customer_phone_idx" ON "customer"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "customer_merchant_id_phone_key" ON "customer"("merchant_id", "phone");

-- CreateIndex
CREATE INDEX "discount_rule_merchant_id_is_active_sort_order_idx" ON "discount_rule"("merchant_id", "is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "discount_rule_merchant_id_threshold_amount_key" ON "discount_rule"("merchant_id", "threshold_amount");

-- CreateIndex
CREATE UNIQUE INDEX "discount_settings_merchant_id_key" ON "discount_settings"("merchant_id");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_idempotency_key_key" ON "transaction"("idempotency_key");

-- CreateIndex
CREATE INDEX "transaction_branch_id_invoice_id_idx" ON "transaction"("branch_id", "invoice_id");

-- CreateIndex
CREATE INDEX "transaction_customer_id_idx" ON "transaction"("customer_id");

-- CreateIndex
CREATE INDEX "transaction_customer_id_period_key_idx" ON "transaction"("customer_id", "period_key");

-- CreateIndex
CREATE INDEX "transaction_merchant_id_occurred_at_idx" ON "transaction"("merchant_id", "occurred_at");

-- CreateIndex
CREATE INDEX "transaction_merchant_id_customer_id_captured_at_idx" ON "transaction"("merchant_id", "customer_id", "captured_at");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_merchant_id_branch_id_invoice_id_key" ON "transaction"("merchant_id", "branch_id", "invoice_id");

-- CreateIndex
CREATE INDEX "voucher_customer_id_idx" ON "voucher"("customer_id");

-- CreateIndex
CREATE INDEX "voucher_status_idx" ON "voucher"("status");

-- CreateIndex
CREATE INDEX "voucher_merchant_id_status_issued_at_idx" ON "voucher"("merchant_id", "status", "issued_at");

-- CreateIndex
CREATE UNIQUE INDEX "voucher_merchant_id_code_key" ON "voucher"("merchant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "voucher_transaction_id_key" ON "voucher"("transaction_id");

-- CreateIndex
CREATE INDEX "feature_flag_merchant_id_idx" ON "feature_flag"("merchant_id");

-- CreateIndex
CREATE UNIQUE INDEX "feature_flag_merchant_id_key_key" ON "feature_flag"("merchant_id", "key");

-- CreateIndex
CREATE INDEX "notification_log_merchant_id_status_idx" ON "notification_log"("merchant_id", "status");

-- CreateIndex
CREATE INDEX "notification_log_customer_id_idx" ON "notification_log"("customer_id");

-- CreateIndex
CREATE INDEX "audit_log_merchant_id_created_at_idx" ON "audit_log"("merchant_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_entity_type_entity_id_idx" ON "audit_log"("entity_type", "entity_id");
