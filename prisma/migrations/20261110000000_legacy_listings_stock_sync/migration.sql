-- Vinculação de anúncios legados (criados fora do integrador) e sincronização de estoque ADS → Mercado Livre.
-- Não destrutiva: nenhuma tabela existente perde dados. O vínculo anúncio → produto continua sendo
-- marketplace_product_mappings (o mesmo usado pelos pedidos), apenas complementado.

-- 1. Inventário dos anúncios da conta (uma linha por anúncio ou por variação). Somente leitura do ML.
CREATE TABLE "legacy_listings" (
  "id" BIGSERIAL PRIMARY KEY,
  "marketplace_account_id" TEXT NOT NULL,
  "marketplace_item_id" TEXT NOT NULL,
  -- '' = anúncio sem variações; senão o ID da variação.
  "variation_id" TEXT NOT NULL DEFAULT '',
  "variation_label" TEXT,
  "item_has_variations" BOOLEAN NOT NULL DEFAULT false,
  "user_product_id" TEXT,
  "family_id" TEXT,
  "inventory_id" TEXT,
  "title" TEXT,
  "status" TEXT,
  "sub_status" JSONB NOT NULL DEFAULT '[]',
  "seller_sku" TEXT,
  "gtins" TEXT[] NOT NULL DEFAULT '{}',
  "brand" TEXT,
  "manufacturer_code" TEXT,
  "available_quantity" INTEGER,
  "logistic_type" TEXT,
  "catalog_listing" BOOLEAN,
  "thumbnail" TEXT,
  "permalink" TEXT,
  -- Informativo (o módulo nunca altera preço).
  "price" DECIMAL(14,2),
  "remote_last_updated" TIMESTAMPTZ(3),
  -- INTEGRATOR = existe em marketplace_listings; EXTERNAL = criado fora do integrador.
  "origin" TEXT NOT NULL,
  -- Resultado do motor de correspondência (sugestão; nunca vínculo automático).
  "suggested_product_id" INTEGER REFERENCES "products" ("id") ON DELETE SET NULL,
  "suggestion_source" TEXT,
  "suggestion_confidence" TEXT,
  "candidate_count" INTEGER NOT NULL DEFAULT 0,
  "suggestion_details" JSONB,
  "suggested_at" TIMESTAMPTZ(3),
  "discovered_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  -- Não apareceu numa varredura completa da conta.
  "removed_at" TIMESTAMPTZ(3),
  CONSTRAINT "legacy_listings_key" UNIQUE ("marketplace_item_id", "variation_id"),
  CONSTRAINT "legacy_listings_origin_check" CHECK ("origin" IN ('INTEGRATOR', 'EXTERNAL')),
  CONSTRAINT "legacy_listings_source_check" CHECK ("suggestion_source" IS NULL OR "suggestion_source" IN ('EXISTING_LINK', 'SKU_MATCH', 'GTIN_MATCH', 'MANUFACTURER_MATCH')),
  CONSTRAINT "legacy_listings_confidence_check" CHECK ("suggestion_confidence" IS NULL OR "suggestion_confidence" IN ('HIGH', 'MEDIUM', 'LOW')),
  CONSTRAINT "legacy_listings_quantity_check" CHECK ("available_quantity" IS NULL OR "available_quantity" >= 0)
);
CREATE INDEX "legacy_listings_user_product_idx" ON "legacy_listings" ("user_product_id");
CREATE INDEX "legacy_listings_sku_idx" ON "legacy_listings" ("seller_sku");
CREATE INDEX "legacy_listings_status_idx" ON "legacy_listings" ("status");

-- 2. Vínculo anúncio → produto ADS: complementos de auditoria, origem do critério, limite e composição.
ALTER TABLE "marketplace_product_mappings" ADD COLUMN "deactivated_by" TEXT;
-- Limite de quantidade anunciada para este anúncio/variação (regra de alocação). NULL = sem limite.
ALTER TABLE "marketplace_product_mappings" ADD COLUMN "max_quantity" INTEGER;
ALTER TABLE "marketplace_product_mappings" ADD CONSTRAINT "marketplace_product_mappings_max_qty_check" CHECK ("max_quantity" IS NULL OR "max_quantity" >= 0);
-- Origem do critério (MANUAL = escolha do operador). NOT VALID: não reavalia linhas antigas (todas MANUAL).
ALTER TABLE "marketplace_product_mappings" ADD CONSTRAINT "marketplace_product_mappings_source_check"
  CHECK ("source" IN ('MANUAL', 'EXISTING_LINK', 'SKU_MATCH', 'GTIN_MATCH', 'MANUFACTURER_MATCH')) NOT VALID;

-- Composição (kits / pacotes). Sem linhas = 1 unidade do produto do vínculo por venda.
CREATE TABLE "marketplace_mapping_components" (
  "mapping_id" BIGINT NOT NULL REFERENCES "marketplace_product_mappings" ("id") ON DELETE CASCADE,
  "product_id" INTEGER NOT NULL REFERENCES "products" ("id") ON DELETE RESTRICT,
  "ads_product_id" INTEGER NOT NULL,
  "quantity" INTEGER NOT NULL,
  PRIMARY KEY ("mapping_id", "product_id"),
  CONSTRAINT "marketplace_mapping_components_qty_check" CHECK ("quantity" BETWEEN 1 AND 1000)
);

-- Sugestões recusadas pelo operador (não voltam a ser sugeridas para o mesmo anúncio).
CREATE TABLE "legacy_listing_rejections" (
  "id" BIGSERIAL PRIMARY KEY,
  "marketplace_item_id" TEXT NOT NULL,
  "variation_id" TEXT NOT NULL DEFAULT '',
  "product_id" INTEGER NOT NULL REFERENCES "products" ("id") ON DELETE CASCADE,
  "rejected_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "legacy_listing_rejections_key" UNIQUE ("marketplace_item_id", "variation_id", "product_id")
);

-- 3. Grupo de estoque por produto ADS: política de reserva, alocação entre anúncios e aprovação para automação.
CREATE TABLE "stock_sync_groups" (
  "product_id" INTEGER PRIMARY KEY REFERENCES "products" ("id") ON DELETE CASCADE,
  "ads_product_id" INTEGER NOT NULL,
  -- NULL = usa a reserva padrão das configurações.
  "safety_reserve" INTEGER,
  -- EXCLUSIVE: só sincroniza se o produto abastece um único estoque no ML. SPLIT_EVEN: divide igualmente.
  "allocation_mode" TEXT NOT NULL DEFAULT 'EXCLUSIVE',
  "auto_sync_approved" BOOLEAN NOT NULL DEFAULT false,
  "approved_by" TEXT,
  "approved_at" TIMESTAMPTZ(3),
  "notes" TEXT,
  "updated_by" TEXT,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "stock_sync_groups_reserve_check" CHECK ("safety_reserve" IS NULL OR "safety_reserve" >= 0),
  CONSTRAINT "stock_sync_groups_mode_check" CHECK ("allocation_mode" IN ('EXCLUSIVE', 'SPLIT_EVEN'))
);

-- 4. Execuções de comparação (DRY RUN manual ou automática) e propostas geradas.
CREATE TABLE "stock_sync_runs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "mode" TEXT NOT NULL,
  "requested_by" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "summary" JSONB,
  "error_message" TEXT,
  "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "finished_at" TIMESTAMPTZ(3),
  CONSTRAINT "stock_sync_runs_mode_check" CHECK ("mode" IN ('DRY_RUN', 'AUTO')),
  CONSTRAINT "stock_sync_runs_status_check" CHECK ("status" IN ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED'))
);
CREATE INDEX "stock_sync_runs_started_idx" ON "stock_sync_runs" ("started_at" DESC);

CREATE TABLE "stock_sync_proposals" (
  "id" BIGSERIAL PRIMARY KEY,
  "run_id" UUID NOT NULL REFERENCES "stock_sync_runs" ("id") ON DELETE CASCADE,
  -- Estoque controlado no ML: up:<user_product_id> | item:<id> | item:<id>:<variação>
  "pool_key" TEXT NOT NULL,
  "marketplace_item_ids" TEXT[] NOT NULL,
  "variation_id" TEXT,
  "user_product_id" TEXT,
  "product_ids" INTEGER[] NOT NULL DEFAULT '{}',
  "stock_model" TEXT NOT NULL,
  "eligible" BOOLEAN NOT NULL,
  "reason_code" TEXT,
  "reason" TEXT,
  "ads_quantity" DECIMAL(14,3),
  "safety_reserve" INTEGER,
  "pending_orders" DECIMAL(14,3),
  "marketplace_quantity" INTEGER,
  "proposed_quantity" INTEGER,
  "difference" INTEGER,
  "direction" TEXT,
  "remote_version" TEXT,
  "ads_fetched_at" TIMESTAMPTZ(3),
  "calculation" JSONB NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL DEFAULT 'PROPOSED',
  "approved_by" TEXT,
  "approved_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "stock_sync_proposals_direction_check" CHECK ("direction" IS NULL OR "direction" IN ('INCREASE', 'DECREASE', 'NONE')),
  CONSTRAINT "stock_sync_proposals_status_check" CHECK ("status" IN ('PROPOSED', 'APPROVED', 'APPLIED', 'DIVERGED', 'FAILED', 'STALE', 'SUPERSEDED', 'SKIPPED')),
  CONSTRAINT "stock_sync_proposals_qty_check" CHECK ("proposed_quantity" IS NULL OR "proposed_quantity" >= 0)
);
CREATE INDEX "stock_sync_proposals_run_idx" ON "stock_sync_proposals" ("run_id");
CREATE INDEX "stock_sync_proposals_pool_idx" ON "stock_sync_proposals" ("pool_key", "created_at" DESC);

-- 5. Jobs persistentes de atualização (um ativo por estoque do ML) e cada chamada feita.
CREATE TABLE "stock_sync_jobs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "proposal_id" BIGINT REFERENCES "stock_sync_proposals" ("id") ON DELETE SET NULL,
  "pool_key" TEXT NOT NULL,
  "sync_mode" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "authorized_by" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "stock_model" TEXT,
  "target_quantity" INTEGER NOT NULL,
  "before_quantity" INTEGER,
  "applied_quantity" INTEGER,
  "status_before" TEXT,
  "status_after" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 4,
  "next_run_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "locked_until" TIMESTAMPTZ(3),
  "error_code" TEXT,
  "error_message" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "started_at" TIMESTAMPTZ(3),
  "completed_at" TIMESTAMPTZ(3),
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "stock_sync_jobs_idem_key" UNIQUE ("idempotency_key"),
  CONSTRAINT "stock_sync_jobs_mode_check" CHECK ("sync_mode" IN ('MANUAL', 'AUTO')),
  CONSTRAINT "stock_sync_jobs_status_check" CHECK ("status" IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'DIVERGED', 'FAILED', 'STALE', 'SKIPPED')),
  CONSTRAINT "stock_sync_jobs_target_check" CHECK ("target_quantity" >= 0)
);
-- Impede jobs simultâneos para o mesmo estoque do ML (duplicação de atualização).
CREATE UNIQUE INDEX "stock_sync_jobs_active_pool_key" ON "stock_sync_jobs" ("pool_key") WHERE "status" IN ('QUEUED', 'RUNNING');
CREATE INDEX "stock_sync_jobs_queue_idx" ON "stock_sync_jobs" ("status", "next_run_at");
CREATE INDEX "stock_sync_jobs_created_idx" ON "stock_sync_jobs" ("created_at" DESC);
CREATE INDEX "stock_sync_jobs_pool_idx" ON "stock_sync_jobs" ("pool_key", "created_at" DESC);

CREATE TABLE "stock_sync_attempts" (
  "id" BIGSERIAL PRIMARY KEY,
  "job_id" UUID NOT NULL REFERENCES "stock_sync_jobs" ("id") ON DELETE CASCADE,
  "operation" TEXT NOT NULL,
  "request" JSONB,
  "response" JSONB,
  "http_status" INTEGER,
  "error_code" TEXT,
  "error_message" TEXT,
  "duration_ms" INTEGER,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE INDEX "stock_sync_attempts_job_idx" ON "stock_sync_attempts" ("job_id", "created_at");

-- 6. Auditoria de vínculos (confirmar, remover, recusar sugestão) e de alterações de política/configuração.
CREATE TABLE "stock_sync_history" (
  "id" BIGSERIAL PRIMARY KEY,
  "event_type" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "marketplace_item_id" TEXT,
  "variation_id" TEXT,
  "product_id" INTEGER,
  "mapping_id" BIGINT,
  "job_id" UUID,
  "details" JSONB,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE INDEX "stock_sync_history_created_idx" ON "stock_sync_history" ("created_at" DESC);
CREATE INDEX "stock_sync_history_item_idx" ON "stock_sync_history" ("marketplace_item_id", "created_at" DESC);
