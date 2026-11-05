-- Fases 4 e 5: eventos do Mercado Livre (webhook persistente + fila no PostgreSQL), sincronização
-- periódica e reconciliação de anúncios, recuperação de notificações perdidas (missed_feeds) e
-- caixa de entrada de pedidos (somente leitura no ML; nada é enviado à ADS).
-- Não destrutiva: só adiciona colunas e tabelas. Nenhuma tabela existente é alterada em seu conteúdo.

-- ---------------------------------------------------------------------------
-- 1. Fotografia dos dados consultados no Mercado Livre, ao lado dos dados publicados pelo integrador.
--    price/quantity continuam sendo os valores enviados na publicação; remote_* é o que o ML devolveu.
--    status continua sendo o status local (com "deleted" para excluído); remote_status é o original da API.
-- ---------------------------------------------------------------------------
ALTER TABLE "marketplace_listings"
  ADD COLUMN "remote_status" TEXT,
  ADD COLUMN "remote_sub_status" JSONB,
  ADD COLUMN "remote_price" DECIMAL(14,2),
  ADD COLUMN "remote_quantity" INTEGER,
  ADD COLUMN "remote_title" TEXT,
  ADD COLUMN "remote_category_id" TEXT,
  ADD COLUMN "remote_seller_sku" TEXT,
  ADD COLUMN "remote_last_updated" TIMESTAMPTZ(3),
  ADD COLUMN "sync_error_code" TEXT,
  ADD COLUMN "sync_error_message" TEXT,
  ADD COLUMN "sync_error_at" TIMESTAMPTZ(3);

-- ---------------------------------------------------------------------------
-- 2. Notificações recebidas (webhook, missed_feeds ou reprocessamento). A fila É esta tabela.
-- ---------------------------------------------------------------------------
CREATE TABLE "marketplace_webhook_events" (
  "id" BIGSERIAL PRIMARY KEY,
  -- _id da notificação no ML; sem _id, hash de topic+resource+sent (deduplicação de reentregas).
  "event_id" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'webhook',
  "application_id" TEXT,
  "seller_id" TEXT,
  "topic" TEXT NOT NULL,
  "resource" TEXT NOT NULL,
  "actions" JSONB NOT NULL DEFAULT '[]',
  "payload" JSONB,
  "ml_attempts" INTEGER,
  "sent_at" TIMESTAMPTZ(3),
  "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 8,
  "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  -- Lease por evento: um worker que morrer libera o evento quando o prazo expira.
  "locked_until" TIMESTAMPTZ(3),
  "started_at" TIMESTAMPTZ(3),
  "processed_at" TIMESTAMPTZ(3),
  "duration_ms" INTEGER,
  "last_error_code" TEXT,
  "last_error" TEXT,
  "ignored_reason" TEXT,
  "result" JSONB,
  "coalesced_into" BIGINT,
  "correlation_id" UUID NOT NULL DEFAULT gen_random_uuid(),
  CONSTRAINT "marketplace_webhook_events_event_id_key" UNIQUE ("event_id"),
  CONSTRAINT "marketplace_webhook_events_status_check" CHECK ("status" IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'RETRYING', 'IGNORED')),
  CONSTRAINT "marketplace_webhook_events_source_check" CHECK ("source" IN ('webhook', 'missed_feeds', 'manual', 'derived')),
  CONSTRAINT "marketplace_webhook_events_attempts_check" CHECK ("attempts" >= 0 AND "max_attempts" > 0)
);
CREATE INDEX "marketplace_webhook_events_queue_idx" ON "marketplace_webhook_events" ("status", "next_attempt_at");
CREATE INDEX "marketplace_webhook_events_resource_idx" ON "marketplace_webhook_events" ("topic", "resource");
CREATE INDEX "marketplace_webhook_events_received_idx" ON "marketplace_webhook_events" ("received_at" DESC);

-- Histórico de cada falha de processamento (a tabela de eventos guarda só a última).
CREATE TABLE "marketplace_event_processing_errors" (
  "id" BIGSERIAL PRIMARY KEY,
  "event_id" BIGINT NOT NULL REFERENCES "marketplace_webhook_events" ("id") ON DELETE CASCADE,
  "attempt" INTEGER NOT NULL,
  "error_code" TEXT NOT NULL,
  "error_message" TEXT NOT NULL,
  "http_status" INTEGER,
  "retryable" BOOLEAN NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE INDEX "marketplace_event_processing_errors_event_idx" ON "marketplace_event_processing_errors" ("event_id", "created_at");

-- ---------------------------------------------------------------------------
-- 3. Execuções periódicas (reconciliação de anúncios, missed_feeds, recuperação de pedidos).
-- ---------------------------------------------------------------------------
CREATE TABLE "marketplace_sync_jobs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "type" TEXT NOT NULL,
  "trigger" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "finished_at" TIMESTAMPTZ(3),
  "total_processed" INTEGER NOT NULL DEFAULT 0,
  "total_changed" INTEGER NOT NULL DEFAULT 0,
  "total_failed" INTEGER NOT NULL DEFAULT 0,
  "details" JSONB,
  "error_message" TEXT,
  CONSTRAINT "marketplace_sync_jobs_type_check" CHECK ("type" IN ('LISTINGS_RECONCILE', 'MISSED_FEEDS', 'ORDERS_RECOVERY')),
  CONSTRAINT "marketplace_sync_jobs_trigger_check" CHECK ("trigger" IN ('scheduler', 'manual', 'cron')),
  CONSTRAINT "marketplace_sync_jobs_status_check" CHECK ("status" IN ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED'))
);
CREATE INDEX "marketplace_sync_jobs_type_started_idx" ON "marketplace_sync_jobs" ("type", "started_at" DESC);

-- Histórico dos valores lidos no ML (gravado só quando algo muda, para não inflar a tabela).
CREATE TABLE "marketplace_listing_snapshots" (
  "id" BIGSERIAL PRIMARY KEY,
  "listing_id" INTEGER NOT NULL REFERENCES "marketplace_listings" ("id") ON DELETE CASCADE,
  "marketplace_item_id" TEXT NOT NULL,
  "marketplace_status" TEXT,
  "marketplace_substatus" JSONB,
  "marketplace_price" DECIMAL(14,2),
  "marketplace_quantity" INTEGER,
  "marketplace_last_updated" TIMESTAMPTZ(3),
  "source" TEXT NOT NULL,
  "event_id" BIGINT REFERENCES "marketplace_webhook_events" ("id") ON DELETE SET NULL,
  "sync_job_id" UUID REFERENCES "marketplace_sync_jobs" ("id") ON DELETE SET NULL,
  "fetched_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE INDEX "marketplace_listing_snapshots_listing_idx" ON "marketplace_listing_snapshots" ("listing_id", "fetched_at" DESC);

-- Divergências entre o que o integrador publicou/conhece e o que o ML informa.
CREATE TABLE "marketplace_reconciliation_issues" (
  "id" BIGSERIAL PRIMARY KEY,
  "marketplace_item_id" TEXT NOT NULL,
  "listing_id" INTEGER REFERENCES "marketplace_listings" ("id") ON DELETE CASCADE,
  "issue_type" TEXT NOT NULL,
  "local_value" TEXT,
  "remote_value" TEXT,
  "details" JSONB,
  "first_detected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "last_detected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "resolved_at" TIMESTAMPTZ(3),
  "resolution" TEXT,
  CONSTRAINT "marketplace_reconciliation_issues_type_check" CHECK ("issue_type" IN
    ('STATUS_DIVERGENCE', 'CLOSED_REMOTE', 'REMOVED_REMOTE', 'PRICE_DIVERGENCE', 'QUANTITY_DIVERGENCE', 'NOT_LINKED', 'INCOMPLETE_LINK', 'FETCH_ERROR'))
);
CREATE UNIQUE INDEX "marketplace_reconciliation_issues_open_key"
  ON "marketplace_reconciliation_issues" ("marketplace_item_id", "issue_type") WHERE "resolved_at" IS NULL;
CREATE INDEX "marketplace_reconciliation_issues_listing_idx" ON "marketplace_reconciliation_issues" ("listing_id") WHERE "resolved_at" IS NULL;

-- ---------------------------------------------------------------------------
-- 4. Pedidos do Mercado Livre (caixa de entrada para a futura integração com a ADS).
--    order_id e pack_id são distintos: um pack pode agrupar vários pedidos.
-- ---------------------------------------------------------------------------
CREATE TABLE "marketplace_order_inbox" (
  "id" BIGSERIAL PRIMARY KEY,
  "marketplace_order_id" TEXT NOT NULL,
  "pack_id" TEXT,
  "seller_id" TEXT NOT NULL,
  -- Dados mínimos do comprador (LGPD): identificação e apelido; nome só se a API devolver.
  "buyer_id" TEXT,
  "buyer_nickname" TEXT,
  "buyer_first_name" TEXT,
  "buyer_last_name" TEXT,
  "order_status" TEXT,
  "order_status_detail" TEXT,
  "payment_status" TEXT,
  "currency_id" TEXT,
  "products_amount" DECIMAL(14,2),
  "discount_amount" DECIMAL(14,2),
  "shipping_amount" DECIMAL(14,2),
  "total_amount" DECIMAL(14,2),
  "paid_amount" DECIMAL(14,2),
  "shipment_id" TEXT,
  "tags" JSONB NOT NULL DEFAULT '[]',
  "date_created" TIMESTAMPTZ(3),
  "date_closed" TIMESTAMPTZ(3),
  "ml_last_updated" TIMESTAMPTZ(3),
  "mapping_status" TEXT NOT NULL DEFAULT 'PENDING',
  "ads_import_status" TEXT NOT NULL DEFAULT 'RECEIVED',
  "ads_status_reason" TEXT,
  "last_error" TEXT,
  "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "last_fetched_at" TIMESTAMPTZ(3),
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "marketplace_order_inbox_order_key" UNIQUE ("marketplace_order_id"),
  CONSTRAINT "marketplace_order_inbox_mapping_check" CHECK ("mapping_status" IN ('PENDING', 'MAPPED', 'PARTIAL', 'UNMAPPED')),
  CONSTRAINT "marketplace_order_inbox_ads_check" CHECK ("ads_import_status" IN ('RECEIVED', 'PROCESSING', 'READY_FOR_MAPPING', 'READY_FOR_ADS', 'BLOCKED', 'ERROR'))
);
CREATE INDEX "marketplace_order_inbox_pack_idx" ON "marketplace_order_inbox" ("pack_id");
CREATE INDEX "marketplace_order_inbox_created_idx" ON "marketplace_order_inbox" ("date_created" DESC);
CREATE INDEX "marketplace_order_inbox_ads_status_idx" ON "marketplace_order_inbox" ("ads_import_status");
CREATE INDEX "marketplace_order_inbox_shipment_idx" ON "marketplace_order_inbox" ("shipment_id");

CREATE TABLE "marketplace_order_items" (
  "id" BIGSERIAL PRIMARY KEY,
  "order_id" BIGINT NOT NULL REFERENCES "marketplace_order_inbox" ("id") ON DELETE CASCADE,
  "line_key" TEXT NOT NULL,
  "marketplace_item_id" TEXT NOT NULL,
  "variation_id" TEXT,
  "user_product_id" TEXT,
  "seller_sku" TEXT,
  "title" TEXT,
  "category_id" TEXT,
  "quantity" DECIMAL(14,3) NOT NULL,
  "unit_price" DECIMAL(14,2),
  "full_unit_price" DECIMAL(14,2),
  "sale_fee" DECIMAL(14,2),
  "currency_id" TEXT,
  "listing_id" INTEGER REFERENCES "marketplace_listings" ("id") ON DELETE SET NULL,
  "product_id" INTEGER REFERENCES "products" ("id") ON DELETE SET NULL,
  "ads_product_id" INTEGER,
  "mapping_status" TEXT NOT NULL,
  "mapping_method" TEXT,
  CONSTRAINT "marketplace_order_items_line_key" UNIQUE ("order_id", "line_key"),
  CONSTRAINT "marketplace_order_items_mapping_check" CHECK ("mapping_status" IN ('MAPPED', 'UNMAPPED')),
  CONSTRAINT "marketplace_order_items_method_check" CHECK ("mapping_method" IS NULL OR "mapping_method" IN ('LISTING', 'USER_PRODUCT', 'SELLER_SKU', 'MANUAL'))
);
CREATE INDEX "marketplace_order_items_item_idx" ON "marketplace_order_items" ("marketplace_item_id");

CREATE TABLE "marketplace_order_payments" (
  "id" BIGSERIAL PRIMARY KEY,
  "order_id" BIGINT NOT NULL REFERENCES "marketplace_order_inbox" ("id") ON DELETE CASCADE,
  "payment_id" TEXT NOT NULL,
  "status" TEXT,
  "status_detail" TEXT,
  "payment_type" TEXT,
  "payment_method_id" TEXT,
  "installments" INTEGER,
  "transaction_amount" DECIMAL(14,2),
  "total_paid_amount" DECIMAL(14,2),
  "shipping_cost" DECIMAL(14,2),
  "coupon_amount" DECIMAL(14,2),
  "date_created" TIMESTAMPTZ(3),
  "date_approved" TIMESTAMPTZ(3),
  "date_last_modified" TIMESTAMPTZ(3),
  CONSTRAINT "marketplace_order_payments_key" UNIQUE ("order_id", "payment_id")
);

-- Envios (somente leitura). Sem endereço do destinatário nesta fase.
CREATE TABLE "marketplace_shipments" (
  "id" BIGSERIAL PRIMARY KEY,
  "shipment_id" TEXT NOT NULL,
  "marketplace_order_id" TEXT,
  "status" TEXT,
  "substatus" TEXT,
  "logistic_type" TEXT,
  "mode" TEXT,
  "tracking_method" TEXT,
  "date_created" TIMESTAMPTZ(3),
  "ml_last_updated" TIMESTAMPTZ(3),
  "fetched_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "marketplace_shipments_key" UNIQUE ("shipment_id")
);
CREATE INDEX "marketplace_shipments_order_idx" ON "marketplace_shipments" ("marketplace_order_id");

-- JSON original do pedido: acesso restrito (endpoint próprio) e retenção limitada (expires_at).
CREATE TABLE "marketplace_order_raw" (
  "order_id" BIGINT PRIMARY KEY REFERENCES "marketplace_order_inbox" ("id") ON DELETE CASCADE,
  "payload" JSONB NOT NULL,
  "fetched_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "expires_at" TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX "marketplace_order_raw_expires_idx" ON "marketplace_order_raw" ("expires_at");

-- ---------------------------------------------------------------------------
-- 5. Agendador no próprio banco (Supabase: pg_cron + pg_net), porque o plano Hobby da Vercel só
--    executa cron uma vez por dia. A cada 5 minutos o banco chama o endpoint de "tick" do integrador
--    com a URL e o token gravados pela aplicação em app_settings (chave meli_scheduler) — nenhum
--    segredo fica neste arquivo. Melhor esforço: onde as extensões não existem (ex.: testes), nada muda.
-- ---------------------------------------------------------------------------
DO $outer$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron')
     AND EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_net') THEN
    BEGIN
      CREATE EXTENSION IF NOT EXISTS pg_net;
      CREATE EXTENSION IF NOT EXISTS pg_cron;
      PERFORM cron.schedule(
        'fioetrato-meli-tick',
        '*/5 * * * *',
        $job$SELECT net.http_post(
                 url := value->>'url',
                 body := '{}'::jsonb,
                 headers := jsonb_build_object('content-type', 'application/json', 'x-scheduler-token', value->>'token'),
                 timeout_milliseconds := 5000)
             FROM public.app_settings WHERE key = 'meli_scheduler' AND value ? 'url' AND value ? 'token'$job$
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Agendador pg_cron não configurado: %', SQLERRM;
    END;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Verificação de extensões ignorada: %', SQLERRM;
END
$outer$;
