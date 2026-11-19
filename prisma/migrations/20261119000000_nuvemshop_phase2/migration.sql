-- Fase 2 Nuvemshop: produtos/imagens, sincronização automática de preço e estoque (via Inventory Core),
-- proteção de pedidos pendentes, webhooks persistentes, fila de escritas e controles de automação.
-- Só cria tabelas novas (nuvemshop_*). Nenhuma tabela existente é alterada. Nenhuma automação é ligada:
-- os dois modos começam em DISABLED e a escrita depende de NUVEMSHOP_WRITE_ENABLED=true no ambiente.

-- Configuração de cada automação (PRICE e STOCK). Modo inicial DISABLED.
CREATE TABLE "nuvemshop_automation_settings" (
  "kind" TEXT PRIMARY KEY,
  "mode" TEXT NOT NULL DEFAULT 'DISABLED',
  -- Modo a restaurar ao reativar depois de PAUSED.
  "resume_mode" TEXT,
  -- SELECTED = só variantes marcadas (PILOT/INCLUDED); ALL_ELIGIBLE = todas as elegíveis, exceto EXCLUDED.
  "scope" TEXT NOT NULL DEFAULT 'SELECTED',
  "interval_minutes" INTEGER NOT NULL DEFAULT 30,
  "policy" JSONB NOT NULL DEFAULT '{}',
  "automatic_approved_by" TEXT,
  "automatic_approved_at" TIMESTAMPTZ(3),
  "paused_reason" TEXT,
  "last_run_id" UUID,
  "last_run_at" TIMESTAMPTZ(3),
  "next_run_at" TIMESTAMPTZ(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "updated_by" TEXT,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "nuvemshop_automation_kind_check" CHECK ("kind" IN ('PRICE', 'STOCK')),
  CONSTRAINT "nuvemshop_automation_mode_check" CHECK ("mode" IN ('DISABLED', 'SHADOW', 'PILOT', 'AUTOMATIC', 'PAUSED')),
  CONSTRAINT "nuvemshop_automation_resume_check" CHECK ("resume_mode" IS NULL OR "resume_mode" IN ('SHADOW', 'PILOT', 'AUTOMATIC')),
  CONSTRAINT "nuvemshop_automation_scope_check" CHECK ("scope" IN ('SELECTED', 'ALL_ELIGIBLE')),
  CONSTRAINT "nuvemshop_automation_interval_check" CHECK ("interval_minutes" BETWEEN 5 AND 1440),
  -- AUTOMATIC exige aprovação administrativa registrada.
  CONSTRAINT "nuvemshop_automation_approval_check" CHECK ("mode" <> 'AUTOMATIC' OR "automatic_approved_at" IS NOT NULL)
);
INSERT INTO "nuvemshop_automation_settings" ("kind", "interval_minutes", "policy", "updated_by") VALUES
  ('PRICE', 30, '{}', 'system:migration'),
  ('STOCK', 15, '{}', 'system:migration');

-- Desligamento de emergência (linha única). Ativo: nenhuma escrita nova é criada nem executada.
CREATE TABLE "nuvemshop_emergency_stop" (
  "id" BOOLEAN PRIMARY KEY DEFAULT true,
  "active" BOOLEAN NOT NULL DEFAULT false,
  "reason" TEXT,
  "activated_by" TEXT,
  "activated_at" TIMESTAMPTZ(3),
  "released_by" TEXT,
  "released_at" TIMESTAMPTZ(3),
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "nuvemshop_emergency_stop_single" CHECK ("id")
);
INSERT INTO "nuvemshop_emergency_stop" ("id", "active") VALUES (true, false);

-- Participação e estado de cada variante em cada automação.
CREATE TABLE "nuvemshop_sync_variants" (
  "store_id" TEXT NOT NULL,
  "variant_id" BIGINT NOT NULL,
  "kind" TEXT NOT NULL,
  "participation" TEXT NOT NULL DEFAULT 'NONE',
  "participation_by" TEXT,
  "participation_at" TIMESTAMPTZ(3),
  "last_decision" TEXT,
  "last_reason_code" TEXT,
  "last_reason" TEXT,
  "last_target" TEXT,
  "last_remote_value" TEXT,
  "last_written_value" TEXT,
  "last_written_at" TIMESTAMPTZ(3),
  "last_verified_at" TIMESTAMPTZ(3),
  "last_job_id" UUID,
  "last_origin" TEXT,
  "dirty_at" TIMESTAMPTZ(3),
  "evaluated_at" TIMESTAMPTZ(3),
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  PRIMARY KEY ("store_id", "variant_id", "kind"),
  CONSTRAINT "nuvemshop_sync_variants_kind_check" CHECK ("kind" IN ('PRICE', 'STOCK')),
  CONSTRAINT "nuvemshop_sync_variants_part_check" CHECK ("participation" IN ('NONE', 'PILOT', 'INCLUDED', 'EXCLUDED'))
);
CREATE INDEX "nuvemshop_sync_variants_part_idx" ON "nuvemshop_sync_variants" ("kind", "participation");

-- Execuções das automações (simulação, piloto, automático).
CREATE TABLE "nuvemshop_sync_runs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "trigger" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "requested_by" TEXT NOT NULL,
  "inventory_run_id" UUID,
  "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "finished_at" TIMESTAMPTZ(3),
  "summary" JSONB,
  "error_message" TEXT,
  CONSTRAINT "nuvemshop_sync_runs_kind_check" CHECK ("kind" IN ('PRICE', 'STOCK')),
  CONSTRAINT "nuvemshop_sync_runs_mode_check" CHECK ("mode" IN ('SHADOW', 'PILOT', 'AUTOMATIC', 'SIMULATION')),
  CONSTRAINT "nuvemshop_sync_runs_trigger_check" CHECK ("trigger" IN ('scheduler', 'manual', 'simulation')),
  CONSTRAINT "nuvemshop_sync_runs_status_check" CHECK ("status" IN ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'SKIPPED'))
);
CREATE INDEX "nuvemshop_sync_runs_kind_idx" ON "nuvemshop_sync_runs" ("kind", "started_at" DESC);

-- Decisão por variante em cada execução (histórico/auditoria).
CREATE TABLE "nuvemshop_sync_items" (
  "id" BIGSERIAL PRIMARY KEY,
  "run_id" UUID NOT NULL REFERENCES "nuvemshop_sync_runs" ("id") ON DELETE CASCADE,
  "kind" TEXT NOT NULL,
  "store_id" TEXT NOT NULL,
  "nuvemshop_product_id" BIGINT NOT NULL,
  "variant_id" BIGINT NOT NULL,
  "product_id" INTEGER,
  "location_id" TEXT,
  "current_value" TEXT,
  "base_value" TEXT,
  "target_value" TEXT,
  "change_pct" NUMERIC(9,2),
  "decision" TEXT NOT NULL,
  "reason_code" TEXT,
  "reason" TEXT,
  "job_id" UUID,
  "approved_by" TEXT,
  "approved_at" TIMESTAMPTZ(3),
  "details" JSONB,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "nuvemshop_sync_items_decision_check" CHECK ("decision" IN ('IN_SYNC', 'WRITE', 'SHADOW', 'BLOCKED', 'REVIEW', 'NOT_SELECTED', 'APPROVED'))
);
CREATE INDEX "nuvemshop_sync_items_run_idx" ON "nuvemshop_sync_items" ("run_id");
CREATE INDEX "nuvemshop_sync_items_variant_idx" ON "nuvemshop_sync_items" ("store_id", "variant_id", "kind", "id" DESC);

-- Fila persistente de escritas na Nuvemshop (uma linha por variante × tipo).
-- lock_key = tipo:loja:variante[:localização] — índice único parcial: no máximo UMA escrita ativa (inclusive
-- incerta ou aguardando reconciliação) por SKU × canal × localização. Dois sincronizadores não coexistem.
CREATE TABLE "nuvemshop_write_jobs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind" TEXT NOT NULL,
  "store_id" TEXT NOT NULL,
  "nuvemshop_product_id" BIGINT NOT NULL,
  "variant_id" BIGINT NOT NULL,
  "location_id" TEXT,
  "lock_key" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "mode" TEXT NOT NULL,
  "run_id" UUID,
  "expected_value" TEXT,
  "target_value" TEXT NOT NULL,
  "direction" TEXT,
  "source_version" TEXT,
  "isolate" BOOLEAN NOT NULL DEFAULT false,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 4,
  "next_run_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "verified" BOOLEAN NOT NULL DEFAULT false,
  "observed_after" TEXT,
  "result" JSONB,
  "error_code" TEXT,
  "error_message" TEXT,
  "created_by" TEXT NOT NULL,
  "approved_by" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "started_at" TIMESTAMPTZ(3),
  "finished_at" TIMESTAMPTZ(3),
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "nuvemshop_write_jobs_kind_check" CHECK ("kind" IN ('PRICE', 'STOCK')),
  CONSTRAINT "nuvemshop_write_jobs_status_check" CHECK ("status" IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'UNCERTAIN', 'REQUIRES_RECONCILIATION', 'SUPERSEDED', 'CANCELED')),
  CONSTRAINT "nuvemshop_write_jobs_mode_check" CHECK ("mode" IN ('PILOT', 'AUTOMATIC', 'MANUAL')),
  CONSTRAINT "nuvemshop_write_jobs_direction_check" CHECK ("direction" IS NULL OR "direction" IN ('INCREASE', 'DECREASE', 'NONE')),
  CONSTRAINT "nuvemshop_write_jobs_idem_key" UNIQUE ("idempotency_key")
);
CREATE UNIQUE INDEX "nuvemshop_write_jobs_one_active" ON "nuvemshop_write_jobs" ("lock_key")
  WHERE "status" IN ('PENDING', 'RUNNING', 'UNCERTAIN', 'REQUIRES_RECONCILIATION');
CREATE INDEX "nuvemshop_write_jobs_pending_idx" ON "nuvemshop_write_jobs" ("status", "next_run_at");
CREATE INDEX "nuvemshop_write_jobs_variant_idx" ON "nuvemshop_write_jobs" ("store_id", "variant_id", "created_at" DESC);

-- Tentativas de cada escrita (requisição, resposta resumida, verificação).
CREATE TABLE "nuvemshop_write_attempts" (
  "id" BIGSERIAL PRIMARY KEY,
  "job_id" UUID NOT NULL REFERENCES "nuvemshop_write_jobs" ("id") ON DELETE CASCADE,
  "attempt" INTEGER NOT NULL,
  "batch_id" UUID,
  "batch_size" INTEGER,
  "outcome" TEXT NOT NULL,
  "http_status" INTEGER,
  "error_code" TEXT,
  "message" TEXT,
  "observed_before" TEXT,
  "observed_after" TEXT,
  "duration_ms" INTEGER,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "nuvemshop_write_attempts_outcome_check" CHECK ("outcome" IN ('SUCCEEDED', 'VERIFIED_MISMATCH', 'FAILED', 'RETRY', 'UNCERTAIN', 'SUPERSEDED', 'CANCELED', 'RESOLVED'))
);
CREATE INDEX "nuvemshop_write_attempts_job_idx" ON "nuvemshop_write_attempts" ("job_id", "id");

-- Operações de catálogo (criar/editar produto, variante e imagem) — auditoria e idempotência.
CREATE TABLE "nuvemshop_product_operations" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "store_id" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "nuvemshop_product_id" BIGINT,
  "variant_id" BIGINT,
  "image_id" BIGINT,
  "product_id" INTEGER,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "idempotency_key" TEXT,
  "request" JSONB,
  "result" JSONB,
  "verified" BOOLEAN NOT NULL DEFAULT false,
  "error_message" TEXT,
  "actor" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "finished_at" TIMESTAMPTZ(3),
  CONSTRAINT "nuvemshop_product_ops_operation_check" CHECK ("operation" IN ('CREATE_PRODUCT', 'UPDATE_PRODUCT', 'SET_VISIBILITY', 'CREATE_VARIANT', 'UPDATE_VARIANT',
    'ADD_IMAGE', 'SET_MAIN_IMAGE', 'REMOVE_IMAGE')),
  CONSTRAINT "nuvemshop_product_ops_status_check" CHECK ("status" IN ('PENDING', 'SUCCEEDED', 'FAILED', 'UNCERTAIN', 'RESOLVED'))
);
CREATE UNIQUE INDEX "nuvemshop_product_ops_idem_key" ON "nuvemshop_product_operations" ("idempotency_key") WHERE "idempotency_key" IS NOT NULL;
-- Uma criação de produto por produto ADS em andamento/incerta (não recria produtos).
CREATE UNIQUE INDEX "nuvemshop_product_ops_one_create" ON "nuvemshop_product_operations" ("store_id", "product_id")
  WHERE "operation" = 'CREATE_PRODUCT' AND "status" IN ('PENDING', 'UNCERTAIN');
CREATE INDEX "nuvemshop_product_ops_product_idx" ON "nuvemshop_product_operations" ("store_id", "nuvemshop_product_id", "created_at" DESC);

-- Eventos recebidos por webhook (persistidos ANTES do processamento).
CREATE TABLE "nuvemshop_webhook_events" (
  "id" BIGSERIAL PRIMARY KEY,
  "store_id" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "resource_id" TEXT,
  "event_ts" BIGINT,
  "dedup_key" TEXT NOT NULL,
  "body_hash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_run_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "locked_until" TIMESTAMPTZ(3),
  "last_error" TEXT,
  "result" JSONB,
  "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "processed_at" TIMESTAMPTZ(3),
  CONSTRAINT "nuvemshop_webhook_events_status_check" CHECK ("status" IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'IGNORED')),
  CONSTRAINT "nuvemshop_webhook_events_dedup_key" UNIQUE ("dedup_key")
);
CREATE INDEX "nuvemshop_webhook_events_pending_idx" ON "nuvemshop_webhook_events" ("status", "next_run_at");

-- Webhooks cadastrados pelo integrador na loja.
CREATE TABLE "nuvemshop_webhook_registrations" (
  "store_id" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "remote_id" BIGINT,
  "status" TEXT NOT NULL,
  "last_error" TEXT,
  "registered_by" TEXT,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  PRIMARY KEY ("store_id", "event"),
  CONSTRAINT "nuvemshop_webhook_reg_status_check" CHECK ("status" IN ('ACTIVE', 'FAILED', 'REMOVED'))
);

-- Pedidos Nuvemshop para PROTEÇÃO DE ESTOQUE (sem dados pessoais do comprador: só ID, número, situação e linhas).
CREATE TABLE "nuvemshop_orders" (
  "store_id" TEXT NOT NULL,
  "order_id" BIGINT NOT NULL,
  "number" BIGINT,
  "status" TEXT,
  "payment_status" TEXT,
  "shipping_status" TEXT,
  "cancelled_at" TIMESTAMPTZ(3),
  "remote_created_at" TIMESTAMPTZ(3),
  "remote_updated_at" TIMESTAMPTZ(3),
  -- [{lineId, productId, variantId, quantity, sku}] (sem nome/endereço/contato).
  "lines" JSONB NOT NULL DEFAULT '[]',
  "mapping_state" TEXT NOT NULL DEFAULT 'UNMAPPED',
  "commitment_state" TEXT NOT NULL DEFAULT 'NONE',
  "unmapped_lines" INTEGER NOT NULL DEFAULT 0,
  "ads_confirmed_by" TEXT,
  "ads_confirmed_at" TIMESTAMPTZ(3),
  "ads_reference" TEXT,
  "source" TEXT NOT NULL,
  "fetched_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  PRIMARY KEY ("store_id", "order_id"),
  CONSTRAINT "nuvemshop_orders_mapping_check" CHECK ("mapping_state" IN ('MAPPED', 'PARTIAL', 'UNMAPPED')),
  CONSTRAINT "nuvemshop_orders_commitment_check" CHECK ("commitment_state" IN ('NONE', 'COMMITTED', 'REFLECTED_IN_ERP', 'RELEASED', 'REQUIRES_RECONCILIATION')),
  CONSTRAINT "nuvemshop_orders_source_check" CHECK ("source" IN ('WEBHOOK', 'RECONCILIATION', 'MANUAL'))
);
CREATE INDEX "nuvemshop_orders_commitment_idx" ON "nuvemshop_orders" ("commitment_state", "remote_created_at");
