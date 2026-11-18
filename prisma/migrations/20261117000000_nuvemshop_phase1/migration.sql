-- Fase 1 — Nuvemshop: conexão OAuth, catálogo importado (produtos, variantes, imagens, categorias),
-- localizações e níveis de estoque, vínculos variante Nuvemshop ↔ produto ADS e filas de importação.
-- SOMENTE LEITURA da Nuvemshop: nenhuma tabela aqui guarda operação de escrita remota.
-- Não destrutiva: só cria tabelas novas; não altera tabelas existentes (ML, ADS, Inventory Core).
-- Todas as chaves de catálogo incluem store_id para não colidir entre lojas futuras.

-- 1. Lojas conectadas (um registro por par app × loja; o token pertence a esse par).
CREATE TABLE "nuvemshop_stores" (
  "id" BIGSERIAL PRIMARY KEY,
  "app_id" TEXT NOT NULL,
  "store_id" TEXT NOT NULL,
  "store_name" TEXT,
  "store_url" TEXT,
  "original_domain" TEXT,
  "plan_name" TEXT,
  "main_language" TEXT,
  "main_currency" TEXT,
  "country" TEXT,
  "timezone_id" TEXT,
  -- null = ainda não verificado; true/false = observado na loja (GET /locations e inventory_levels).
  "multi_location" BOOLEAN,
  "location_count" INTEGER,
  "capabilities" JSONB NOT NULL DEFAULT '{}',
  "connection_status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "encrypted_access_token" TEXT,
  "granted_scopes" TEXT,
  "token_version" INTEGER NOT NULL DEFAULT 1,
  "connected_by" TEXT,
  "connected_at" TIMESTAMPTZ(3),
  "disconnected_at" TIMESTAMPTZ(3),
  "last_successful_check_at" TIMESTAMPTZ(3),
  "last_error" TEXT,
  "raw_store" JSONB,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "nuvemshop_stores_status_check" CHECK ("connection_status" IN ('ACTIVE', 'REAUTH_REQUIRED', 'DISCONNECTED')),
  -- Conexão ativa sempre tem token; desconectada nunca guarda token.
  CONSTRAINT "nuvemshop_stores_token_check" CHECK (
    ("connection_status" = 'DISCONNECTED' AND "encrypted_access_token" IS NULL) OR ("connection_status" <> 'DISCONNECTED'))
);
CREATE UNIQUE INDEX "nuvemshop_stores_app_store_key" ON "nuvemshop_stores" ("app_id", "store_id");
-- Fase 1: no máximo uma loja conectada (ativa ou aguardando reautorização) por vez.
CREATE UNIQUE INDEX "nuvemshop_stores_single_connected" ON "nuvemshop_stores" ((true)) WHERE "connection_status" <> 'DISCONNECTED';

-- 2. States OAuth (uso único, amarrados ao navegador por cookie HttpOnly). Tabela própria: não compartilha
--    o state do Mercado Livre, para um callback nunca consumir o state do outro provedor.
CREATE TABLE "nuvemshop_oauth_states" (
  "id" BIGSERIAL PRIMARY KEY,
  "state_hash" TEXT NOT NULL,
  "binding_hash" TEXT NOT NULL,
  "requested_by" TEXT,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "consumed_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "nuvemshop_oauth_states_state_key" ON "nuvemshop_oauth_states" ("state_hash");
CREATE INDEX "nuvemshop_oauth_states_expires_idx" ON "nuvemshop_oauth_states" ("expires_at");

-- 3. Catálogo importado (dados originais preservados em raw_payload).
CREATE TABLE "nuvemshop_products" (
  "store_id" TEXT NOT NULL,
  "product_id" BIGINT NOT NULL,
  "name" TEXT,
  "names" JSONB,
  "description" TEXT,
  "handle" TEXT,
  "brand" TEXT,
  "visibility" TEXT,
  "published" BOOLEAN,
  "is_kit" BOOLEAN NOT NULL DEFAULT false,
  "attributes" JSONB,
  "category_ids" BIGINT[] NOT NULL DEFAULT '{}',
  "tags" TEXT,
  "canonical_url" TEXT,
  "variant_count" INTEGER NOT NULL DEFAULT 0,
  "image_count" INTEGER NOT NULL DEFAULT 0,
  "remote_created_at" TIMESTAMPTZ(3),
  "remote_updated_at" TIMESTAMPTZ(3),
  "raw_payload" JSONB NOT NULL,
  "payload_hash" TEXT NOT NULL,
  "fetched_at" TIMESTAMPTZ(3) NOT NULL,
  "last_seen_job_id" UUID,
  "sync_status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "removed_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  PRIMARY KEY ("store_id", "product_id"),
  CONSTRAINT "nuvemshop_products_status_check" CHECK ("sync_status" IN ('ACTIVE', 'REMOVED'))
);
CREATE INDEX "nuvemshop_products_updated_idx" ON "nuvemshop_products" ("store_id", "remote_updated_at");

CREATE TABLE "nuvemshop_variants" (
  "store_id" TEXT NOT NULL,
  "variant_id" BIGINT NOT NULL,
  "product_id" BIGINT NOT NULL,
  "position" INTEGER,
  "sku" TEXT,
  -- SKU normalizado (maiúsculas, sem espaços) para comparação e detecção de duplicidade.
  "sku_norm" TEXT,
  "barcode" TEXT,
  -- GTIN com dígito verificador válido (null quando o barcode não é um GTIN válido).
  "gtin" TEXT,
  "mpn" TEXT,
  "option_values" JSONB,
  "price" NUMERIC(14,2),
  "promotional_price" NUMERIC(14,2),
  "stock_management" BOOLEAN,
  -- Estoque legado (soma de todas as localizações). null com stock_management = false = não controlado.
  "stock" INTEGER,
  "has_inventory_levels" BOOLEAN NOT NULL DEFAULT false,
  "weight" NUMERIC(12,4),
  "width" NUMERIC(12,4),
  "height" NUMERIC(12,4),
  "depth" NUMERIC(12,4),
  "visible" BOOLEAN,
  "image_id" BIGINT,
  "remote_created_at" TIMESTAMPTZ(3),
  "remote_updated_at" TIMESTAMPTZ(3),
  "raw_payload" JSONB NOT NULL,
  "fetched_at" TIMESTAMPTZ(3) NOT NULL,
  "last_seen_job_id" UUID,
  "sync_status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "removed_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  PRIMARY KEY ("store_id", "variant_id"),
  CONSTRAINT "nuvemshop_variants_status_check" CHECK ("sync_status" IN ('ACTIVE', 'REMOVED')),
  CONSTRAINT "nuvemshop_variants_product_fk" FOREIGN KEY ("store_id", "product_id") REFERENCES "nuvemshop_products" ("store_id", "product_id") ON DELETE CASCADE
);
CREATE INDEX "nuvemshop_variants_product_idx" ON "nuvemshop_variants" ("store_id", "product_id");
CREATE INDEX "nuvemshop_variants_sku_idx" ON "nuvemshop_variants" ("store_id", "sku_norm") WHERE "sku_norm" IS NOT NULL;
CREATE INDEX "nuvemshop_variants_gtin_idx" ON "nuvemshop_variants" ("store_id", "gtin") WHERE "gtin" IS NOT NULL;

CREATE TABLE "nuvemshop_product_images" (
  "store_id" TEXT NOT NULL,
  "image_id" BIGINT NOT NULL,
  "product_id" BIGINT NOT NULL,
  "src" TEXT NOT NULL,
  "position" INTEGER,
  "alt" TEXT,
  "fetched_at" TIMESTAMPTZ(3) NOT NULL,
  PRIMARY KEY ("store_id", "image_id"),
  CONSTRAINT "nuvemshop_product_images_product_fk" FOREIGN KEY ("store_id", "product_id") REFERENCES "nuvemshop_products" ("store_id", "product_id") ON DELETE CASCADE
);
CREATE INDEX "nuvemshop_product_images_product_idx" ON "nuvemshop_product_images" ("store_id", "product_id", "position");

CREATE TABLE "nuvemshop_categories" (
  "store_id" TEXT NOT NULL,
  "category_id" BIGINT NOT NULL,
  "name" TEXT,
  "parent_id" BIGINT,
  "raw_payload" JSONB NOT NULL,
  "fetched_at" TIMESTAMPTZ(3) NOT NULL,
  PRIMARY KEY ("store_id", "category_id")
);

-- 4. Localizações e níveis de estoque (somente leitura). warehouse_code = depósito do Inventory Core
--    associado à localização: configurável, nunca presumido (null = não mapeada, não participa).
CREATE TABLE "nuvemshop_locations" (
  "store_id" TEXT NOT NULL,
  "location_id" TEXT NOT NULL,
  "name" TEXT,
  "is_default" BOOLEAN,
  "priority" INTEGER,
  "tags" TEXT[],
  "raw_payload" JSONB NOT NULL,
  "fetched_at" TIMESTAMPTZ(3) NOT NULL,
  "removed_at" TIMESTAMPTZ(3),
  "warehouse_code" TEXT,
  "mapping_status" TEXT NOT NULL DEFAULT 'UNMAPPED',
  "mapped_by" TEXT,
  "mapped_at" TIMESTAMPTZ(3),
  PRIMARY KEY ("store_id", "location_id"),
  CONSTRAINT "nuvemshop_locations_mapping_check" CHECK ("mapping_status" IN ('UNMAPPED', 'MAPPED', 'EXCLUDED')),
  CONSTRAINT "nuvemshop_locations_warehouse_check" CHECK (("mapping_status" = 'MAPPED') = ("warehouse_code" IS NOT NULL))
);

CREATE TABLE "nuvemshop_inventory_levels" (
  "store_id" TEXT NOT NULL,
  "variant_id" BIGINT NOT NULL,
  "location_id" TEXT NOT NULL,
  "stock" INTEGER,
  "fetched_at" TIMESTAMPTZ(3) NOT NULL,
  PRIMARY KEY ("store_id", "variant_id", "location_id"),
  CONSTRAINT "nuvemshop_inventory_levels_variant_fk" FOREIGN KEY ("store_id", "variant_id") REFERENCES "nuvemshop_variants" ("store_id", "variant_id") ON DELETE CASCADE
);

-- 5. Importação do catálogo (fila persistente; uma tarefa ativa por loja).
CREATE TABLE "nuvemshop_catalog_import_jobs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "store_id" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "cursor" JSONB NOT NULL DEFAULT '{}',
  -- Importação incremental: produtos atualizados desde este instante.
  "updated_since" TIMESTAMPTZ(3),
  "total_products" INTEGER,
  "products_seen" INTEGER NOT NULL DEFAULT 0,
  "variants_seen" INTEGER NOT NULL DEFAULT 0,
  "created_count" INTEGER NOT NULL DEFAULT 0,
  "updated_count" INTEGER NOT NULL DEFAULT 0,
  "unchanged_count" INTEGER NOT NULL DEFAULT 0,
  "removed_count" INTEGER NOT NULL DEFAULT 0,
  "failed_count" INTEGER NOT NULL DEFAULT 0,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_run_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "last_error" TEXT,
  "requested_by" TEXT NOT NULL,
  "started_at" TIMESTAMPTZ(3),
  "finished_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "nuvemshop_import_jobs_mode_check" CHECK ("mode" IN ('FULL', 'INCREMENTAL')),
  CONSTRAINT "nuvemshop_import_jobs_status_check" CHECK ("status" IN ('PENDING', 'RUNNING', 'COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELED'))
);
CREATE UNIQUE INDEX "nuvemshop_import_jobs_one_active" ON "nuvemshop_catalog_import_jobs" ("store_id") WHERE "status" IN ('PENDING', 'RUNNING');
CREATE INDEX "nuvemshop_import_jobs_store_idx" ON "nuvemshop_catalog_import_jobs" ("store_id", "created_at" DESC);

CREATE TABLE "nuvemshop_catalog_import_attempts" (
  "id" BIGSERIAL PRIMARY KEY,
  "job_id" UUID NOT NULL REFERENCES "nuvemshop_catalog_import_jobs" ("id") ON DELETE CASCADE,
  "phase" TEXT NOT NULL,
  "page" INTEGER,
  "attempt" INTEGER NOT NULL,
  "outcome" TEXT NOT NULL,
  "http_status" INTEGER,
  "error_code" TEXT,
  "message" TEXT,
  "duration_ms" INTEGER,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "nuvemshop_import_attempts_outcome_check" CHECK ("outcome" IN ('OK', 'RETRY', 'FAILED', 'ITEM_ERROR'))
);
CREATE INDEX "nuvemshop_import_attempts_job_idx" ON "nuvemshop_catalog_import_attempts" ("job_id", "id");

-- 6. Vínculos variante Nuvemshop → produto ADS. A identidade central continua a do Inventory Core
--    (products.id / ADS-<id>). Sugestões nunca contam como vínculo; só CONFIRMED participa do Inventory Core.
CREATE TABLE "nuvemshop_variant_mappings" (
  "id" BIGSERIAL PRIMARY KEY,
  "store_id" TEXT NOT NULL,
  "nuvemshop_product_id" BIGINT NOT NULL,
  "variant_id" BIGINT NOT NULL,
  "product_id" INTEGER NOT NULL REFERENCES "products" ("id") ON DELETE RESTRICT,
  "ads_product_id" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "criterion" TEXT NOT NULL,
  "confidence" TEXT NOT NULL,
  "evidence" JSONB NOT NULL DEFAULT '[]',
  -- SKU/GTIN observados no momento da decisão (detecta variante recriada ou alterada).
  "sku_snapshot" TEXT,
  "gtin_snapshot" TEXT,
  "created_by" TEXT NOT NULL,
  "decided_by" TEXT,
  "decided_at" TIMESTAMPTZ(3),
  "review_reason" TEXT,
  "notes" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "nuvemshop_mappings_status_check" CHECK ("status" IN ('SUGGESTED', 'CONFIRMED', 'REJECTED', 'NEEDS_REVIEW', 'REVOKED', 'SUPERSEDED')),
  CONSTRAINT "nuvemshop_mappings_criterion_check" CHECK ("criterion" IN ('EXISTING_LINK', 'SKU_MATCH', 'GTIN_MATCH', 'MANUFACTURER_MATCH', 'MANUAL')),
  CONSTRAINT "nuvemshop_mappings_confidence_check" CHECK ("confidence" IN ('HIGH', 'MEDIUM', 'LOW', 'MANUAL'))
);
-- Um vínculo vigente (confirmado ou em revisão) por variante; sugestões abertas: uma por variante × produto.
CREATE UNIQUE INDEX "nuvemshop_mappings_active_key" ON "nuvemshop_variant_mappings" ("store_id", "variant_id") WHERE "status" IN ('CONFIRMED', 'NEEDS_REVIEW');
CREATE UNIQUE INDEX "nuvemshop_mappings_suggestion_key" ON "nuvemshop_variant_mappings" ("store_id", "variant_id", "product_id") WHERE "status" = 'SUGGESTED';
CREATE INDEX "nuvemshop_mappings_product_idx" ON "nuvemshop_variant_mappings" ("product_id") WHERE "status" = 'CONFIRMED';
CREATE INDEX "nuvemshop_mappings_rejected_idx" ON "nuvemshop_variant_mappings" ("store_id", "variant_id", "product_id") WHERE "status" = 'REJECTED';

-- Composição formal de kits (sem linhas = 1 unidade do produto do vínculo por venda).
CREATE TABLE "nuvemshop_mapping_components" (
  "mapping_id" BIGINT NOT NULL REFERENCES "nuvemshop_variant_mappings" ("id") ON DELETE CASCADE,
  "product_id" INTEGER NOT NULL REFERENCES "products" ("id") ON DELETE RESTRICT,
  "ads_product_id" INTEGER NOT NULL,
  "quantity" INTEGER NOT NULL,
  PRIMARY KEY ("mapping_id", "product_id"),
  CONSTRAINT "nuvemshop_mapping_components_qty_check" CHECK ("quantity" BETWEEN 1 AND 1000)
);

-- Histórico imutável das decisões de vínculo.
CREATE TABLE "nuvemshop_mapping_history" (
  "id" BIGSERIAL PRIMARY KEY,
  "store_id" TEXT NOT NULL,
  "variant_id" BIGINT NOT NULL,
  "mapping_id" BIGINT REFERENCES "nuvemshop_variant_mappings" ("id"),
  "action" TEXT NOT NULL,
  "product_id" INTEGER,
  "ads_product_id" INTEGER,
  "actor" TEXT NOT NULL,
  "details" JSONB,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "nuvemshop_mapping_history_action_check" CHECK ("action" IN ('SUGGESTED', 'CONFIRMED', 'REJECTED', 'REVOKED', 'NEEDS_REVIEW', 'CORRECTED', 'BULK_CONFIRMED'))
);
CREATE INDEX "nuvemshop_mapping_history_variant_idx" ON "nuvemshop_mapping_history" ("store_id", "variant_id", "id" DESC);

CREATE OR REPLACE FUNCTION "nuvemshop_mapping_history_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'nuvemshop_mapping_history é somente inserção';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "nuvemshop_mapping_history_no_update" BEFORE UPDATE OR DELETE ON "nuvemshop_mapping_history"
  FOR EACH ROW EXECUTE FUNCTION "nuvemshop_mapping_history_immutable"();
