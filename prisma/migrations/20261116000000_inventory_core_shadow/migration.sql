-- Inventory Core — Fase 0 (SHADOW MODE).
-- Núcleo central de estoque independente dos canais. Não destrutiva e compatível com a aplicação atual:
-- só CRIA tabelas, índices, constraints e um gatilho de imutabilidade nas tabelas novas. Nenhuma tabela
-- existente é alterada e nenhum dado histórico é tocado. O sincronizador atual (stock_sync_*) continua igual.
--
-- Garantias estruturais da fase 0 (no banco, não só na aplicação):
--   * inventory_quota_transfers.simulated é sempre true (CHECK);
--   * inventory_sync_proposals.write_blocked é sempre true (CHECK);
--   * inventory_outbox_events nunca pode ficar DISPATCHED (CHECK) — eventos são suprimidos no modo sombra;
--   * inventory_movements é somente inclusão (gatilho bloqueia UPDATE/DELETE).

-- 1. Depósitos/filiais da ADS. Somente filiais MAPPED participam do cálculo; filiais do mesmo
--    warehouse_code são compatíveis entre si (somáveis). Filial nova descoberta entra como UNMAPPED.
CREATE TABLE "inventory_locations" (
  "branch_id" TEXT PRIMARY KEY,
  "warehouse_code" TEXT NOT NULL DEFAULT 'principal',
  "status" TEXT NOT NULL DEFAULT 'UNMAPPED',
  "source" TEXT NOT NULL DEFAULT 'DISCOVERED',
  "notes" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updated_by" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "inventory_locations_status_check" CHECK ("status" IN ('MAPPED', 'UNMAPPED', 'EXCLUDED')),
  CONSTRAINT "inventory_locations_source_check" CHECK ("source" IN ('DISCOVERED', 'STOCK_SYNC_SETTINGS', 'MANUAL')),
  CONSTRAINT "inventory_locations_warehouse_check" CHECK ("warehouse_code" ~ '^[a-z0-9_-]{1,40}$')
);

-- 2. Identidade central do SKU físico (um por produto ADS). Kits não são SKUs físicos: a composição
--    continua em marketplace_mapping_components (vínculo de canal) e consome os componentes.
CREATE TABLE "inventory_skus" (
  "id" BIGSERIAL PRIMARY KEY,
  "product_id" INTEGER NOT NULL REFERENCES "products" ("id") ON DELETE RESTRICT,
  "ads_product_id" INTEGER NOT NULL,
  "sku_code" TEXT NOT NULL,
  "unit" TEXT,
  -- DECIMAL quando a ADS devolve saldo fracionário (o canal vende unidades inteiras: ⌊saldo⌋).
  "quantity_scale" TEXT NOT NULL DEFAULT 'INTEGER',
  -- A ADS marca o produto como kit: só participa por composição explícita no vínculo.
  "erp_kit" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "inventory_skus_product_key" UNIQUE ("product_id"),
  CONSTRAINT "inventory_skus_ads_key" UNIQUE ("ads_product_id"),
  CONSTRAINT "inventory_skus_code_key" UNIQUE ("sku_code"),
  CONSTRAINT "inventory_skus_scale_check" CHECK ("quantity_scale" IN ('INTEGER', 'DECIMAL'))
);

-- 3. Pool = SKU × depósito compatível. Guarda a posição calculada mais recente (versionada).
CREATE TABLE "inventory_pools" (
  "id" BIGSERIAL PRIMARY KEY,
  "sku_id" BIGINT NOT NULL REFERENCES "inventory_skus" ("id") ON DELETE RESTRICT,
  "product_id" INTEGER NOT NULL,
  "warehouse_code" TEXT NOT NULL,
  "pool_key" TEXT NOT NULL,
  "ads_status" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "ads_quantity" DECIMAL(14,3),
  "ads_fetched_at" TIMESTAMPTZ(3),
  "last_snapshot_id" BIGINT,
  "pending_commitments" DECIMAL(14,3) NOT NULL DEFAULT 0,
  "safety_reserve" INTEGER NOT NULL DEFAULT 0,
  -- NULL = desconhecido (falha/ausência na ADS nunca vira zero).
  "safe_sellable" INTEGER,
  "reliability" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "reliability_reasons" JSONB NOT NULL DEFAULT '[]',
  "version" INTEGER NOT NULL DEFAULT 1,
  "computed_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "inventory_pools_key" UNIQUE ("pool_key"),
  CONSTRAINT "inventory_pools_sku_wh_key" UNIQUE ("sku_id", "warehouse_code"),
  CONSTRAINT "inventory_pools_ads_status_check" CHECK ("ads_status" IN ('KNOWN', 'UNKNOWN', 'ERROR')),
  CONSTRAINT "inventory_pools_reliability_check" CHECK ("reliability" IN ('RELIABLE', 'DEGRADED', 'UNKNOWN', 'BLOCKED')),
  CONSTRAINT "inventory_pools_pending_check" CHECK ("pending_commitments" >= 0),
  CONSTRAINT "inventory_pools_reserve_check" CHECK ("safety_reserve" >= 0),
  CONSTRAINT "inventory_pools_safe_check" CHECK ("safe_sellable" IS NULL OR "safe_sellable" >= 0),
  CONSTRAINT "inventory_pools_known_check" CHECK ("ads_status" <> 'KNOWN' OR "ads_quantity" IS NOT NULL)
);
CREATE INDEX "inventory_pools_product_idx" ON "inventory_pools" ("product_id");

-- 4. Leituras do saldo ADS (histórico). accepted=false: leitura mais antiga que a vigente (ignorada).
CREATE TABLE "inventory_snapshots" (
  "id" BIGSERIAL PRIMARY KEY,
  "pool_id" BIGINT NOT NULL REFERENCES "inventory_pools" ("id") ON DELETE RESTRICT,
  "run_id" UUID,
  "source" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "quantity" DECIMAL(14,3),
  "branches" JSONB NOT NULL DEFAULT '[]',
  "fetched_at" TIMESTAMPTZ(3) NOT NULL,
  "accepted" BOOLEAN NOT NULL,
  "error" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "inventory_snapshots_source_check" CHECK ("source" IN ('ADS_CACHE', 'ADS_LIVE')),
  CONSTRAINT "inventory_snapshots_status_check" CHECK ("status" IN ('KNOWN', 'UNKNOWN', 'ERROR')),
  CONSTRAINT "inventory_snapshots_known_check" CHECK ("status" <> 'KNOWN' OR "quantity" IS NOT NULL)
);
CREATE INDEX "inventory_snapshots_pool_idx" ON "inventory_snapshots" ("pool_id", "fetched_at" DESC);

-- 5. Compromissos de estoque (uma linha por pedido × linha × componente físico). A unicidade impede
--    que um pedido gere duas reservas locais (invariante 3).
CREATE TABLE "inventory_reservations" (
  "id" BIGSERIAL PRIMARY KEY,
  "pool_id" BIGINT NOT NULL REFERENCES "inventory_pools" ("id") ON DELETE RESTRICT,
  "product_id" INTEGER NOT NULL,
  "channel" TEXT NOT NULL,
  "external_order_id" TEXT NOT NULL,
  "line_key" TEXT NOT NULL,
  "quantity" DECIMAL(14,3) NOT NULL,
  "state" TEXT NOT NULL,
  "state_reason" TEXT,
  -- Fatos observados (o estado é função pura deles: idempotente e independente da ordem de chegada).
  "facts" JSONB NOT NULL,
  "ads_external_id" TEXT,
  "ads_pedido_id" INTEGER,
  "ads_submission_status" TEXT,
  "ads_status" TEXT,
  "order_created_at" TIMESTAMPTZ(3),
  -- Versão do evento de origem (ex.: date_last_updated do pedido): evento mais antigo não regride o estado.
  "source_version" TIMESTAMPTZ(3),
  "simulated" BOOLEAN NOT NULL DEFAULT false,
  "correlation_id" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "inventory_reservations_idem_key" UNIQUE ("idempotency_key"),
  CONSTRAINT "inventory_reservations_line_key" UNIQUE ("channel", "external_order_id", "line_key", "product_id"),
  CONSTRAINT "inventory_reservations_state_check" CHECK ("state" IN ('PENDING_ERP', 'REFLECTED_IN_ERP', 'RELEASED', 'REQUIRES_RECONCILIATION')),
  CONSTRAINT "inventory_reservations_qty_check" CHECK ("quantity" > 0),
  CONSTRAINT "inventory_reservations_channel_check" CHECK ("channel" ~ '^[a-z0-9_]{2,30}$')
);
CREATE INDEX "inventory_reservations_pool_state_idx" ON "inventory_reservations" ("pool_id", "state");
CREATE INDEX "inventory_reservations_order_idx" ON "inventory_reservations" ("external_order_id");

-- 6. Livro de movimentações (somente inclusão). responsibility:
--    OBSERVED = fato externo observado (ex.: saldo/baixa na ADS) — o Inventory Core NÃO é o autor;
--    INTERNAL = decisão do próprio Inventory Core (reserva local, cota, transferência simulada).
CREATE TABLE "inventory_movements" (
  "id" BIGSERIAL PRIMARY KEY,
  "event_type" TEXT NOT NULL,
  "pool_id" BIGINT REFERENCES "inventory_pools" ("id") ON DELETE RESTRICT,
  "product_id" INTEGER,
  "ads_product_id" INTEGER,
  "sku_code" TEXT,
  "branch_id" TEXT,
  "warehouse_code" TEXT,
  "channel" TEXT,
  "external_order_id" TEXT,
  "reservation_id" BIGINT,
  "quantity" DECIMAL(14,3),
  "status" TEXT NOT NULL,
  "origin" TEXT NOT NULL,
  "responsibility" TEXT NOT NULL,
  "occurred_at" TIMESTAMPTZ(3) NOT NULL,
  "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "correlation_id" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "simulated" BOOLEAN NOT NULL DEFAULT false,
  "details" JSONB,
  CONSTRAINT "inventory_movements_idem_key" UNIQUE ("idempotency_key"),
  CONSTRAINT "inventory_movements_type_check" CHECK ("event_type" IN (
    'ADS_STOCK_SNAPSHOT', 'ORDER_RECEIVED', 'ORDER_RESERVED', 'ADS_ORDER_CREATED', 'ADS_ORDER_UNCERTAIN', 'ADS_ORDER_FAILED', 'ADS_ORDER_CANCELLED', 'ADS_STOCK_CONFIRMED',
    'ORDER_CANCELLED', 'ORDER_RETURNED', 'STOCK_RELEASED', 'QUOTA_ALLOCATED', 'QUOTA_TRANSFER_REQUESTED', 'QUOTA_TRANSFER_CONFIRMED',
    'QUOTA_TRANSFER_BLOCKED', 'STOCK_DISCREPANCY', 'STOCK_RECONCILED')),
  CONSTRAINT "inventory_movements_status_check" CHECK ("status" IN ('RECORDED', 'IGNORED_STALE', 'INFORMATIONAL')),
  CONSTRAINT "inventory_movements_origin_check" CHECK ("origin" IN ('ML_ORDER_INBOX', 'ADS_SUBMISSION', 'ADS_SNAPSHOT', 'INVENTORY_CORE', 'ADMIN', 'SIMULATION')),
  CONSTRAINT "inventory_movements_resp_check" CHECK ("responsibility" IN ('OBSERVED', 'INTERNAL'))
);
CREATE INDEX "inventory_movements_pool_idx" ON "inventory_movements" ("pool_id", "recorded_at" DESC);
CREATE INDEX "inventory_movements_product_idx" ON "inventory_movements" ("product_id", "recorded_at" DESC);
CREATE INDEX "inventory_movements_order_idx" ON "inventory_movements" ("external_order_id");

CREATE FUNCTION "inventory_movements_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'inventory_movements é somente inclusão (auditoria)';
END;
$$;
CREATE TRIGGER "inventory_movements_no_update" BEFORE UPDATE OR DELETE ON "inventory_movements"
  FOR EACH ROW EXECUTE FUNCTION "inventory_movements_immutable"();

-- 7. Políticas de alocação versionadas (cada alteração cria uma nova versão; uma ativa por escopo).
CREATE TABLE "inventory_allocation_policies" (
  "id" BIGSERIAL PRIMARY KEY,
  "scope" TEXT NOT NULL,
  "product_id" INTEGER REFERENCES "products" ("id") ON DELETE RESTRICT,
  "version" INTEGER NOT NULL,
  -- NULL = herda a reserva da sincronização atual (stock_sync_groups / stock_sync_settings).
  "safety_reserve" INTEGER,
  "remainder_mode" TEXT NOT NULL DEFAULT 'PRIORITY',
  "rules" JSONB NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "notes" TEXT,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "inventory_policies_scope_check" CHECK (("scope" = 'GLOBAL' AND "product_id" IS NULL) OR ("scope" = 'PRODUCT' AND "product_id" IS NOT NULL)),
  CONSTRAINT "inventory_policies_reserve_check" CHECK ("safety_reserve" IS NULL OR "safety_reserve" >= 0),
  CONSTRAINT "inventory_policies_remainder_check" CHECK ("remainder_mode" IN ('PRIORITY', 'UNALLOCATED')),
  CONSTRAINT "inventory_policies_rules_check" CHECK (jsonb_typeof("rules") = 'array')
);
CREATE UNIQUE INDEX "inventory_policies_version_key" ON "inventory_allocation_policies" ("scope", COALESCE("product_id", 0), "version");
CREATE UNIQUE INDEX "inventory_policies_active_key" ON "inventory_allocation_policies" ("scope", COALESCE("product_id", 0)) WHERE "active";

-- Política padrão conservadora: o Mercado Livre (único canal em operação) recebe a disponibilidade
-- segura; a Nuvemshop (ainda não integrada) começa com cota ZERO.
INSERT INTO "inventory_allocation_policies" ("scope", "version", "safety_reserve", "remainder_mode", "rules", "created_by", "notes")
VALUES ('GLOBAL', 1, NULL, 'PRIORITY',
  '[{"channel":"mercadolivre","type":"PERCENT","value":100,"priority":1},{"channel":"nuvemshop","type":"ZERO","priority":2}]',
  'system:migration', 'Padrão da fase 0: Nuvemshop com cota zero até a integração');

-- 8. Cotas por canal. desired = limite de exposição comercial calculado (NÃO é reserva física no ERP);
--    confirmed = quantidade anunciada confirmada por leitura remota; pending = alvo ainda não aplicado.
CREATE TABLE "inventory_channel_allocations" (
  "id" BIGSERIAL PRIMARY KEY,
  "pool_id" BIGINT NOT NULL REFERENCES "inventory_pools" ("id") ON DELETE RESTRICT,
  "channel" TEXT NOT NULL,
  "desired_quantity" INTEGER,
  "confirmed_quantity" INTEGER,
  "confirmed_at" TIMESTAMPTZ(3),
  "pending_quantity" INTEGER,
  "status" TEXT NOT NULL,
  "simulated" BOOLEAN NOT NULL,
  "policy_id" BIGINT,
  "policy_version" INTEGER,
  "version" INTEGER NOT NULL DEFAULT 1,
  "computed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "inventory_allocations_key" UNIQUE ("pool_id", "channel"),
  CONSTRAINT "inventory_allocations_desired_check" CHECK ("desired_quantity" IS NULL OR "desired_quantity" >= 0),
  CONSTRAINT "inventory_allocations_confirmed_check" CHECK ("confirmed_quantity" IS NULL OR "confirmed_quantity" >= 0),
  CONSTRAINT "inventory_allocations_pending_check" CHECK ("pending_quantity" IS NULL OR "pending_quantity" >= 0),
  CONSTRAINT "inventory_allocations_status_check" CHECK ("status" IN ('IN_SYNC', 'PENDING_REMOTE', 'UNCONFIRMED', 'BLOCKED', 'SIMULATED'))
);

-- 9. Transferências de cota entre canais (fase 0: SOMENTE simulação — CHECK simulated).
CREATE TABLE "inventory_quota_transfers" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "pool_id" BIGINT NOT NULL REFERENCES "inventory_pools" ("id") ON DELETE RESTRICT,
  "from_channel" TEXT NOT NULL,
  "to_channel" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "state" TEXT NOT NULL,
  "simulated" BOOLEAN NOT NULL DEFAULT true,
  "steps" JSONB NOT NULL DEFAULT '[]',
  "error" TEXT,
  "requested_by" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "correlation_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "inventory_transfers_idem_key" UNIQUE ("idempotency_key"),
  CONSTRAINT "inventory_transfers_qty_check" CHECK ("quantity" > 0),
  CONSTRAINT "inventory_transfers_channels_check" CHECK ("from_channel" <> "to_channel"),
  CONSTRAINT "inventory_transfers_simulated_check" CHECK ("simulated"),
  CONSTRAINT "inventory_transfers_state_check" CHECK ("state" IN ('REQUESTED', 'SOURCE_DECREASE_PREPARED', 'SOURCE_DECREASE_CONFIRMED',
    'DESTINATION_INCREASE_PREPARED', 'COMPLETED', 'BLOCKED', 'REQUIRES_RECONCILIATION', 'REJECTED', 'CANCELLED'))
);
-- Uma transferência aberta (inclusive bloqueada ou pendente de reconciliação) por pool.
CREATE UNIQUE INDEX "inventory_transfers_open_key" ON "inventory_quota_transfers" ("pool_id")
  WHERE "state" NOT IN ('COMPLETED', 'REJECTED', 'CANCELLED');

-- 10. Execuções de reconciliação em modo sombra.
CREATE TABLE "inventory_reconciliation_runs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "mode" TEXT NOT NULL DEFAULT 'SHADOW',
  "source" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "requested_by" TEXT NOT NULL,
  "correlation_id" TEXT NOT NULL,
  "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "finished_at" TIMESTAMPTZ(3),
  "summary" JSONB,
  "error_message" TEXT,
  CONSTRAINT "inventory_runs_mode_check" CHECK ("mode" = 'SHADOW'),
  CONSTRAINT "inventory_runs_source_check" CHECK ("source" IN ('ADS_CACHE', 'ADS_LIVE')),
  CONSTRAINT "inventory_runs_status_check" CHECK ("status" IN ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED'))
);
CREATE INDEX "inventory_runs_started_idx" ON "inventory_reconciliation_runs" ("started_at" DESC);

-- 11. Divergências (uma aberta por impressão digital; reaparições incrementam occurrences).
CREATE TABLE "inventory_discrepancies" (
  "id" BIGSERIAL PRIMARY KEY,
  "fingerprint" TEXT NOT NULL,
  "first_run_id" UUID,
  "last_run_id" UUID,
  "pool_id" BIGINT REFERENCES "inventory_pools" ("id") ON DELETE RESTRICT,
  "product_id" INTEGER,
  "channel" TEXT,
  "type" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "details" JSONB,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "occurrences" INTEGER NOT NULL DEFAULT 1,
  "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "resolved_at" TIMESTAMPTZ(3),
  CONSTRAINT "inventory_discrepancies_severity_check" CHECK ("severity" IN ('INFO', 'WARNING', 'CRITICAL')),
  CONSTRAINT "inventory_discrepancies_status_check" CHECK ("status" IN ('OPEN', 'RESOLVED'))
);
CREATE UNIQUE INDEX "inventory_discrepancies_open_key" ON "inventory_discrepancies" ("fingerprint") WHERE "status" = 'OPEN';
CREATE INDEX "inventory_discrepancies_status_idx" ON "inventory_discrepancies" ("status", "severity");

-- 12. Propostas de sincronização (fase 0: write_blocked sempre true — nunca aplicadas).
CREATE TABLE "inventory_sync_proposals" (
  "id" BIGSERIAL PRIMARY KEY,
  "run_id" UUID NOT NULL REFERENCES "inventory_reconciliation_runs" ("id") ON DELETE RESTRICT,
  "pool_id" BIGINT NOT NULL REFERENCES "inventory_pools" ("id") ON DELETE RESTRICT,
  "channel" TEXT NOT NULL,
  "current_quantity" INTEGER,
  "target_quantity" INTEGER,
  "direction" TEXT,
  "status" TEXT NOT NULL,
  "reason_code" TEXT,
  "reason" TEXT,
  -- Tradução para os anúncios do canal (vários anúncios, kits, variações) — informativa.
  "details" JSONB,
  "write_blocked" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "inventory_proposals_blocked_check" CHECK ("write_blocked"),
  CONSTRAINT "inventory_proposals_status_check" CHECK ("status" IN ('SHADOW_ONLY', 'BLOCKED', 'IN_SYNC')),
  CONSTRAINT "inventory_proposals_direction_check" CHECK ("direction" IS NULL OR "direction" IN ('INCREASE', 'DECREASE', 'NONE'))
);
CREATE INDEX "inventory_proposals_run_idx" ON "inventory_sync_proposals" ("run_id");

-- 13. Transactional Outbox. Fase 0: nada é despachado (CHECK impede DISPATCHED).
CREATE TABLE "inventory_outbox_events" (
  "id" BIGSERIAL PRIMARY KEY,
  "aggregate_type" TEXT NOT NULL,
  "aggregate_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "processed_at" TIMESTAMPTZ(3),
  CONSTRAINT "inventory_outbox_idem_key" UNIQUE ("idempotency_key"),
  CONSTRAINT "inventory_outbox_status_check" CHECK ("status" IN ('PENDING', 'SUPPRESSED_SHADOW'))
);
CREATE INDEX "inventory_outbox_pending_idx" ON "inventory_outbox_events" ("status", "id");

-- 14. Auditoria das ações administrativas do Inventory Core (políticas, depósitos, simulações).
CREATE TABLE "inventory_audit_logs" (
  "id" BIGSERIAL PRIMARY KEY,
  "actor" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "entity_type" TEXT NOT NULL,
  "entity_id" TEXT,
  "before" JSONB,
  "after" JSONB,
  "correlation_id" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE INDEX "inventory_audit_created_idx" ON "inventory_audit_logs" ("created_at" DESC);
