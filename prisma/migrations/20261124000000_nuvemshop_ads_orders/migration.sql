-- Pedidos Nuvemshop → ADS (envio MANUAL, mesmo controle do Mercado Livre).
-- Tabelas próprias: as tabelas do fluxo do Mercado Livre (ads_order_submissions/attempts, que têm FK para
-- marketplace_order_inbox) não mudam. Clientes ADS (ads_customers) são compartilhados: o mesmo CPF/CNPJ é o
-- mesmo cliente no ERP, venha de qual canal vier.

-- Valores do pedido (sem dados pessoais), lidos com o pedido.
ALTER TABLE "nuvemshop_orders"
  ADD COLUMN "currency" TEXT,
  ADD COLUMN "subtotal" DECIMAL(14,2),
  ADD COLUMN "discount" DECIMAL(14,2),
  ADD COLUMN "discount_coupon" DECIMAL(14,2),
  ADD COLUMN "discount_gateway" DECIMAL(14,2),
  ADD COLUMN "shipping_cost_customer" DECIMAL(14,2),
  ADD COLUMN "total" DECIMAL(14,2),
  ADD COLUMN "gateway" TEXT,
  ADD COLUMN "paid_at" TIMESTAMPTZ(3);

-- Dados fiscais do comprador: lidos SOB DEMANDA (quando o operador prepara o envio à ADS), não em todo pedido.
-- Apagados por customers/redact (pedidos indicados) e store/redact (loja inteira).
CREATE TABLE "nuvemshop_order_billing" (
  "store_id" TEXT NOT NULL,
  "order_id" BIGINT NOT NULL,
  "status" TEXT NOT NULL,
  "doc_type" TEXT,
  "doc_number" TEXT,
  "name" TEXT,
  "state_registration" TEXT,
  "taxpayer_type" TEXT,
  "address" JSONB NOT NULL DEFAULT '{}',
  "missing" JSONB NOT NULL DEFAULT '[]',
  "city_ibge" TEXT,
  "city_ibge_name" TEXT,
  "city_ibge_source" TEXT,
  "fetched_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  PRIMARY KEY ("store_id", "order_id"),
  FOREIGN KEY ("store_id", "order_id") REFERENCES "nuvemshop_orders" ("store_id", "order_id") ON DELETE CASCADE,
  CONSTRAINT "nuvemshop_order_billing_status_check" CHECK ("status" IN ('COMPLETE', 'INCOMPLETE', 'UNAVAILABLE'))
);

CREATE TABLE "nuvemshop_ads_submissions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "store_id" TEXT NOT NULL,
  "order_id" BIGINT NOT NULL,
  "external_id" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  -- Payload enviado com o documento mascarado.
  "payload" JSONB,
  "payload_hash" TEXT,
  "requested_by" TEXT NOT NULL,
  "ads_pedido_id" INTEGER,
  "ads_status" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "sent_at" TIMESTAMPTZ(3),
  "completed_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  FOREIGN KEY ("store_id", "order_id") REFERENCES "nuvemshop_orders" ("store_id", "order_id") ON DELETE RESTRICT,
  CONSTRAINT "nuvemshop_ads_submissions_status_check" CHECK ("status" IN ('SENDING', 'SENT', 'UNKNOWN', 'FAILED', 'CANCELED')),
  CONSTRAINT "nuvemshop_ads_submissions_env_check" CHECK ("environment" IN ('homologacao', 'producao'))
);
-- Um envio vigente por pedido e ambiente; e um idExterno vigente por ambiente.
CREATE UNIQUE INDEX "nuvemshop_ads_submissions_active_key" ON "nuvemshop_ads_submissions" ("store_id", "order_id", "environment")
  WHERE "status" IN ('SENDING', 'SENT', 'UNKNOWN');
CREATE UNIQUE INDEX "nuvemshop_ads_submissions_external_key" ON "nuvemshop_ads_submissions" ("environment", "external_id")
  WHERE "status" IN ('SENDING', 'SENT', 'UNKNOWN');
CREATE INDEX "nuvemshop_ads_submissions_order_idx" ON "nuvemshop_ads_submissions" ("store_id", "order_id", "created_at");

CREATE TABLE "nuvemshop_ads_attempts" (
  "id" BIGSERIAL PRIMARY KEY,
  "submission_id" UUID REFERENCES "nuvemshop_ads_submissions" ("id") ON DELETE CASCADE,
  "store_id" TEXT NOT NULL,
  "order_id" BIGINT NOT NULL,
  "operation" TEXT NOT NULL,
  "http_status" INTEGER,
  "request" JSONB,
  "response" JSONB,
  "error" TEXT,
  "duration_ms" INTEGER,
  "environment" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE INDEX "nuvemshop_ads_attempts_order_idx" ON "nuvemshop_ads_attempts" ("store_id", "order_id", "created_at");
