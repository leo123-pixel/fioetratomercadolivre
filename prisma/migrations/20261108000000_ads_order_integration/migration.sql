-- Pedidos Mercado Livre → ADS (homologação): mapeamento de produtos reutilizável, dados fiscais do
-- comprador, clientes ADS, envios idempotentes e histórico de tentativas. Não destrutiva.

-- 1. Vínculos reutilizáveis entre o que foi vendido no ML e o produto ADS (nunca por título).
CREATE TABLE "marketplace_product_mappings" (
  "id" BIGSERIAL PRIMARY KEY,
  -- ITEM: anúncio (e variação) do ML; SKU: SELLER_SKU validado pelo administrador.
  "mapping_type" TEXT NOT NULL,
  "marketplace_item_id" TEXT,
  "variation_id" TEXT NOT NULL DEFAULT '',
  "seller_sku" TEXT,
  "product_id" INTEGER NOT NULL REFERENCES "products" ("id") ON DELETE RESTRICT,
  "ads_product_id" INTEGER NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'MANUAL',
  "created_by" TEXT NOT NULL,
  "notes" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "deactivated_at" TIMESTAMPTZ(3),
  CONSTRAINT "marketplace_product_mappings_type_check" CHECK ("mapping_type" IN ('ITEM', 'SKU')),
  CONSTRAINT "marketplace_product_mappings_key_check" CHECK (
    ("mapping_type" = 'ITEM' AND "marketplace_item_id" IS NOT NULL) OR ("mapping_type" = 'SKU' AND "seller_sku" IS NOT NULL))
);
CREATE UNIQUE INDEX "marketplace_product_mappings_item_key" ON "marketplace_product_mappings" ("marketplace_item_id", "variation_id")
  WHERE "active" AND "mapping_type" = 'ITEM';
CREATE UNIQUE INDEX "marketplace_product_mappings_sku_key" ON "marketplace_product_mappings" ("seller_sku")
  WHERE "active" AND "mapping_type" = 'SKU';

-- Métodos de vínculo dos itens: + ITEM_LINK (anúncio vinculado pelo administrador) e SKU_LINK (SKU validado).
ALTER TABLE "marketplace_order_items" DROP CONSTRAINT "marketplace_order_items_method_check";
ALTER TABLE "marketplace_order_items" ADD CONSTRAINT "marketplace_order_items_method_check"
  CHECK ("mapping_method" IS NULL OR "mapping_method" IN ('LISTING', 'ITEM_LINK', 'USER_PRODUCT', 'SELLER_SKU', 'SKU_LINK', 'MANUAL'));
ALTER TABLE "marketplace_order_items" ADD COLUMN "mapping_id" BIGINT REFERENCES "marketplace_product_mappings" ("id") ON DELETE SET NULL;

-- 2. Dados fiscais do comprador (GET /orders/billing-info/MLB/{id}). Acesso restrito; retenção limitada.
CREATE TABLE "marketplace_order_billing" (
  "order_id" BIGINT PRIMARY KEY REFERENCES "marketplace_order_inbox" ("id") ON DELETE CASCADE,
  "billing_info_id" TEXT,
  "status" TEXT NOT NULL,
  "doc_type" TEXT,
  "doc_number" TEXT,
  "name" TEXT,
  "state_registration" TEXT,
  "taxpayer_type" TEXT,
  "address" JSONB,
  "missing" JSONB NOT NULL DEFAULT '[]',
  "fetched_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "marketplace_order_billing_status_check" CHECK ("status" IN ('COMPLETE', 'INCOMPLETE', 'UNAVAILABLE'))
);

-- 3. Clientes da ADS por CPF/CNPJ (evita cadastro duplicado; um registro por documento).
CREATE TABLE "ads_customers" (
  "id" BIGSERIAL PRIMARY KEY,
  "cnpj_cpf" TEXT NOT NULL,
  "ads_cliente_id" INTEGER,
  "status" TEXT NOT NULL,
  "draft" JSONB,
  "last_error" TEXT,
  "created_by" TEXT,
  "checked_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "ads_customers_doc_key" UNIQUE ("cnpj_cpf"),
  CONSTRAINT "ads_customers_status_check" CHECK ("status" IN ('FOUND', 'NOT_FOUND', 'AMBIGUOUS', 'CREATING', 'CREATED', 'UNKNOWN', 'ERROR'))
);

-- 4. Envios de pedidos para a ADS (idempotentes) e histórico de cada chamada.
CREATE TABLE "ads_order_submissions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "order_id" BIGINT NOT NULL REFERENCES "marketplace_order_inbox" ("id") ON DELETE RESTRICT,
  "marketplace_order_id" TEXT NOT NULL,
  -- Identificador externo enviado à ADS (máx. 17 caracteres), estável por pedido ML.
  "external_id" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "payload_hash" TEXT NOT NULL,
  "ads_pedido_id" INTEGER,
  "ads_status" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "requested_by" TEXT NOT NULL,
  "last_error" TEXT,
  "sent_at" TIMESTAMPTZ(3),
  "completed_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "ads_order_submissions_status_check" CHECK ("status" IN ('SENDING', 'SENT', 'UNKNOWN', 'FAILED', 'CANCELED')),
  CONSTRAINT "ads_order_submissions_external_len" CHECK (char_length("external_id") <= 17)
);
-- No máximo um envio vigente (em andamento, enviado ou incerto) por pedido ML.
CREATE UNIQUE INDEX "ads_order_submissions_active_key" ON "ads_order_submissions" ("order_id")
  WHERE "status" IN ('SENDING', 'SENT', 'UNKNOWN');
CREATE INDEX "ads_order_submissions_external_idx" ON "ads_order_submissions" ("external_id");

CREATE TABLE "ads_order_attempts" (
  "id" BIGSERIAL PRIMARY KEY,
  "submission_id" UUID REFERENCES "ads_order_submissions" ("id") ON DELETE CASCADE,
  "order_id" BIGINT REFERENCES "marketplace_order_inbox" ("id") ON DELETE CASCADE,
  "operation" TEXT NOT NULL,
  "http_status" INTEGER,
  "request" JSONB,
  "response" JSONB,
  "error" TEXT,
  "duration_ms" INTEGER,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE INDEX "ads_order_attempts_submission_idx" ON "ads_order_attempts" ("submission_id", "created_at");
CREATE INDEX "ads_order_attempts_order_idx" ON "ads_order_attempts" ("order_id", "created_at");
