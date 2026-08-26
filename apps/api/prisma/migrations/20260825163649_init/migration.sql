-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'MANAGER', 'ASSISTANT');

-- CreateEnum
CREATE TYPE "CustomerCategory" AS ENUM ('REGULAR', 'WHOLESALE', 'VIP');

-- CreateEnum
CREATE TYPE "PeriodType" AS ENUM ('WEEKLY', 'MONTHLY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "OverrideTargetType" AS ENUM ('CUSTOMER', 'CATEGORY');

-- CreateEnum
CREATE TYPE "InvoiceSource" AS ENUM ('SCAN', 'API', 'DB_AGENT');

-- CreateEnum
CREATE TYPE "AmountCapture" AS ENUM ('AUTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "CouponStatus" AS ENUM ('ACTIVE', 'USED', 'EXPIRED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('WHATSAPP');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'STUBBED');

-- CreateTable
CREATE TABLE "merchant" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Baghdad',
    "currency" TEXT NOT NULL DEFAULT 'IQD',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branch" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "branch_id" UUID,
    "name" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_token" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "replaced_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "category" "CustomerCategory" NOT NULL DEFAULT 'REGULAR',
    "qr_token" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_rule_set" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "periodType" "PeriodType" NOT NULL DEFAULT 'MONTHLY',
    "period_start" TIMESTAMP(3),
    "period_end" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loyalty_rule_set_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_tier" (
    "id" UUID NOT NULL,
    "rule_set_id" UUID NOT NULL,
    "threshold_amount" INTEGER NOT NULL,
    "discount_pct" INTEGER NOT NULL,
    "coupon_validity_days" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "loyalty_tier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_override_rule" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "target_type" "OverrideTargetType" NOT NULL,
    "target_customer_id" UUID,
    "target_category" "CustomerCategory",
    "threshold_amount" INTEGER NOT NULL,
    "discount_pct" INTEGER NOT NULL,
    "coupon_validity_days" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_override_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'IQD',
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "source" "InvoiceSource" NOT NULL DEFAULT 'SCAN',
    "amount_capture" "AmountCapture" NOT NULL,
    "period_key" TEXT NOT NULL,
    "linked_by_user_id" UUID NOT NULL,
    "device_id" TEXT,
    "idempotency_key" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupon" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "discount_pct" INTEGER NOT NULL,
    "source_threshold_amount" INTEGER NOT NULL,
    "period_key" TEXT NOT NULL,
    "source_transaction_id" UUID,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "status" "CouponStatus" NOT NULL DEFAULT 'ACTIVE',
    "redeemed_at" TIMESTAMP(3),
    "redeemed_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coupon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "balance_snapshot" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "period_key" TEXT NOT NULL,
    "cumulative_amount" INTEGER NOT NULL,
    "transaction_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "balance_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_log" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL DEFAULT 'WHATSAPP',
    "template" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "sent_at" TIMESTAMP(3),
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "before_json" JSONB,
    "after_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
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
CREATE UNIQUE INDEX "customer_qr_token_key" ON "customer"("qr_token");

-- CreateIndex
CREATE INDEX "customer_merchant_id_category_idx" ON "customer"("merchant_id", "category");

-- CreateIndex
CREATE INDEX "customer_phone_idx" ON "customer"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "customer_merchant_id_phone_key" ON "customer"("merchant_id", "phone");

-- CreateIndex
CREATE INDEX "loyalty_rule_set_merchant_id_is_active_idx" ON "loyalty_rule_set"("merchant_id", "is_active");

-- CreateIndex
CREATE INDEX "loyalty_tier_rule_set_id_sort_order_idx" ON "loyalty_tier"("rule_set_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_tier_rule_set_id_threshold_amount_key" ON "loyalty_tier"("rule_set_id", "threshold_amount");

-- CreateIndex
CREATE INDEX "customer_override_rule_merchant_id_target_type_idx" ON "customer_override_rule"("merchant_id", "target_type");

-- CreateIndex
CREATE UNIQUE INDEX "customer_override_rule_merchant_id_target_customer_id_key" ON "customer_override_rule"("merchant_id", "target_customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_override_rule_merchant_id_target_category_key" ON "customer_override_rule"("merchant_id", "target_category");

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
CREATE UNIQUE INDEX "transaction_merchant_id_branch_id_invoice_id_key" ON "transaction"("merchant_id", "branch_id", "invoice_id");

-- CreateIndex
CREATE INDEX "coupon_customer_id_idx" ON "coupon"("customer_id");

-- CreateIndex
CREATE INDEX "coupon_status_idx" ON "coupon"("status");

-- CreateIndex
CREATE INDEX "coupon_merchant_id_status_expires_at_idx" ON "coupon"("merchant_id", "status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "coupon_customer_id_period_key_source_threshold_amount_key" ON "coupon"("customer_id", "period_key", "source_threshold_amount");

-- CreateIndex
CREATE INDEX "balance_snapshot_merchant_id_period_key_idx" ON "balance_snapshot"("merchant_id", "period_key");

-- CreateIndex
CREATE UNIQUE INDEX "balance_snapshot_customer_id_period_key_key" ON "balance_snapshot"("customer_id", "period_key");

-- CreateIndex
CREATE INDEX "notification_log_merchant_id_status_idx" ON "notification_log"("merchant_id", "status");

-- CreateIndex
CREATE INDEX "notification_log_customer_id_idx" ON "notification_log"("customer_id");

-- CreateIndex
CREATE INDEX "audit_log_merchant_id_created_at_idx" ON "audit_log"("merchant_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_entity_type_entity_id_idx" ON "audit_log"("entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "branch" ADD CONSTRAINT "branch_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_rule_set" ADD CONSTRAINT "loyalty_rule_set_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_tier" ADD CONSTRAINT "loyalty_tier_rule_set_id_fkey" FOREIGN KEY ("rule_set_id") REFERENCES "loyalty_rule_set"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_override_rule" ADD CONSTRAINT "customer_override_rule_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_override_rule" ADD CONSTRAINT "customer_override_rule_target_customer_id_fkey" FOREIGN KEY ("target_customer_id") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_linked_by_user_id_fkey" FOREIGN KEY ("linked_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon" ADD CONSTRAINT "coupon_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon" ADD CONSTRAINT "coupon_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon" ADD CONSTRAINT "coupon_source_transaction_id_fkey" FOREIGN KEY ("source_transaction_id") REFERENCES "transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon" ADD CONSTRAINT "coupon_redeemed_by_user_id_fkey" FOREIGN KEY ("redeemed_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "balance_snapshot" ADD CONSTRAINT "balance_snapshot_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "balance_snapshot" ADD CONSTRAINT "balance_snapshot_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
