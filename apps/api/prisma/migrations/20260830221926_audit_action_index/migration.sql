-- CreateIndex
CREATE INDEX "audit_log_merchant_id_action_created_at_idx" ON "audit_log"("merchant_id", "action", "created_at");
