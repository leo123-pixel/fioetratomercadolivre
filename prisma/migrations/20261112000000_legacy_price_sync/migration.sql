-- Sincronização de PREÇO ADS → Mercado Livre para anúncios vinculados (legados ou do integrador).
-- Não destrutiva. Fluxo manual: simulação (somente leitura) → seleção → aprovação → escrita conferida.

CREATE TABLE "price_sync_runs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "requested_by" TEXT NOT NULL,
  "price_table_code" TEXT NOT NULL,
  "branch_id" TEXT,
  "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "summary" JSONB,
  "error_message" TEXT,
  "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "finished_at" TIMESTAMPTZ(3),
  CONSTRAINT "price_sync_runs_status_check" CHECK ("status" IN ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED'))
);
CREATE INDEX "price_sync_runs_started_idx" ON "price_sync_runs" ("started_at" DESC);

-- Uma proposta por anúncio do ML (o preço é do anúncio; variações recebem o mesmo preço).
CREATE TABLE "price_sync_proposals" (
  "id" BIGSERIAL PRIMARY KEY,
  "run_id" UUID NOT NULL REFERENCES "price_sync_runs" ("id") ON DELETE CASCADE,
  "marketplace_item_id" TEXT NOT NULL,
  "title" TEXT,
  "variation_ids" TEXT[] NOT NULL DEFAULT '{}',
  "product_ids" INTEGER[] NOT NULL DEFAULT '{}',
  "ads_product_ids" INTEGER[] NOT NULL DEFAULT '{}',
  "price_table_code" TEXT NOT NULL,
  "branch_id" TEXT,
  "ads_price" DECIMAL(14,2),
  "ads_updated_at" TIMESTAMPTZ(3),
  "marketplace_status" TEXT,
  "marketplace_price" DECIMAL(14,2),
  "proposed_price" DECIMAL(14,2),
  "difference" DECIMAL(14,2),
  "change_pct" DECIMAL(9,2),
  "large_change" BOOLEAN NOT NULL DEFAULT false,
  "eligible" BOOLEAN NOT NULL,
  "reason_code" TEXT,
  "reason" TEXT,
  -- PROPOSED = diferença aplicável; IN_SYNC = já igual; INELIGIBLE = bloqueada; demais = resultado da aplicação.
  "status" TEXT NOT NULL,
  "applied_by" TEXT,
  "applied_at" TIMESTAMPTZ(3),
  "applied_price" DECIMAL(14,2),
  "http_status" INTEGER,
  "request" JSONB,
  "response" JSONB,
  "error_message" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "price_sync_proposals_status_check" CHECK ("status" IN ('PROPOSED', 'IN_SYNC', 'INELIGIBLE', 'APPLYING', 'APPLIED', 'DIVERGED', 'FAILED', 'STALE')),
  CONSTRAINT "price_sync_proposals_price_check" CHECK ("proposed_price" IS NULL OR "proposed_price" > 0)
);
CREATE INDEX "price_sync_proposals_run_idx" ON "price_sync_proposals" ("run_id");
CREATE INDEX "price_sync_proposals_item_idx" ON "price_sync_proposals" ("marketplace_item_id", "created_at" DESC);
CREATE INDEX "price_sync_proposals_applied_idx" ON "price_sync_proposals" ("applied_at" DESC) WHERE "applied_at" IS NOT NULL;
