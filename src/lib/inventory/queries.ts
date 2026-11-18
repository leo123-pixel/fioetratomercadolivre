import "server-only";
import type { Sql } from "../sql";
import { inventoryCoreMode } from "./mode";

/** Leituras do painel /estoque/controle-central (somente banco local). */

export interface PositionRow {
  poolId: string;
  poolKey: string;
  productId: number;
  adsProductId: number;
  skuCode: string;
  name: string;
  warehouseCode: string;
  branches: string | null;
  adsStatus: string;
  adsQuantity: string | null;
  adsFetchedAt: Date | null;
  pendingCommitments: string;
  safetyReserve: number;
  safeSellable: number | null;
  reliability: string;
  reasons: string[];
  mlDesired: number | null;
  mlConfirmed: number | null;
  mlStatus: string | null;
  nsDesired: number | null;
  /** Quantidade observada na Nuvemshop (leitura do catálogo importado; null sem loja ou desconhecida). */
  nsObserved: number | null;
  nsStatus: string | null;
  unallocated: number | null;
  difference: number | null;
  computedAt: Date | null;
  openAlerts: number;
  criticalAlerts: number;
}

export const RELIABILITY_FILTERS = ["RELIABLE", "DEGRADED", "UNKNOWN", "BLOCKED"] as const;

export async function listPositions(
  sql: Sql,
  opts: { q?: string; reliability?: string; alerts?: boolean; page?: number; pageSize?: number } = {},
): Promise<{ rows: PositionRow[]; total: number; page: number; pageSize: number }> {
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 200);
  const page = Math.max(opts.page ?? 1, 1);
  const q = opts.q?.trim() ? `%${opts.q.trim()}%` : null;
  const where = `($1::text IS NULL OR s.sku_code ILIKE $1 OR p.name_original ILIKE $1 OR COALESCE(p.name_custom, '') ILIKE $1 OR p.ads_product_id::text = trim($2::text))
    AND ($3::text IS NULL OR ip.reliability = $3::text)
    AND (NOT $4::boolean OR EXISTS (SELECT 1 FROM inventory_discrepancies d WHERE d.pool_id = ip.id AND d.status = 'OPEN'))`;
  const params = [q, opts.q ?? "", opts.reliability ?? null, opts.alerts ?? false];
  const rows = await sql.query<PositionRow>(
    `SELECT ip.id::text AS "poolId", ip.pool_key AS "poolKey", ip.product_id AS "productId", s.ads_product_id AS "adsProductId", s.sku_code AS "skuCode",
            COALESCE(p.name_custom, p.name_original) AS name, ip.warehouse_code AS "warehouseCode",
            (SELECT string_agg(l.branch_id, ', ' ORDER BY l.branch_id) FROM inventory_locations l WHERE l.status = 'MAPPED' AND l.warehouse_code = ip.warehouse_code) AS branches,
            ip.ads_status AS "adsStatus", trim_scale(ip.ads_quantity)::text AS "adsQuantity", ip.ads_fetched_at AS "adsFetchedAt",
            trim_scale(ip.pending_commitments)::text AS "pendingCommitments", ip.safety_reserve AS "safetyReserve", ip.safe_sellable AS "safeSellable",
            ip.reliability, ip.reliability_reasons AS reasons,
            ml.desired_quantity AS "mlDesired", ml.confirmed_quantity AS "mlConfirmed", ml.status AS "mlStatus",
            ns.desired_quantity AS "nsDesired", ns.confirmed_quantity AS "nsObserved", ns.status AS "nsStatus",
            CASE WHEN ip.safe_sellable IS NULL THEN NULL ELSE ip.safe_sellable - COALESCE(ml.desired_quantity, 0) - COALESCE(ns.desired_quantity, 0) END AS unallocated,
            CASE WHEN ml.desired_quantity IS NULL OR ml.confirmed_quantity IS NULL THEN NULL ELSE ml.desired_quantity - ml.confirmed_quantity END AS difference,
            ip.computed_at AS "computedAt",
            (SELECT count(*)::int FROM inventory_discrepancies d WHERE d.pool_id = ip.id AND d.status = 'OPEN') AS "openAlerts",
            (SELECT count(*)::int FROM inventory_discrepancies d WHERE d.pool_id = ip.id AND d.status = 'OPEN' AND d.severity = 'CRITICAL') AS "criticalAlerts"
     FROM inventory_pools ip
     JOIN inventory_skus s ON s.id = ip.sku_id
     JOIN products p ON p.id = ip.product_id
     LEFT JOIN inventory_channel_allocations ml ON ml.pool_id = ip.id AND ml.channel = 'mercadolivre'
     LEFT JOIN inventory_channel_allocations ns ON ns.pool_id = ip.id AND ns.channel = 'nuvemshop'
     WHERE ${where}
     ORDER BY (SELECT count(*) FROM inventory_discrepancies d WHERE d.pool_id = ip.id AND d.status = 'OPEN' AND d.severity = 'CRITICAL') DESC, s.sku_code
     LIMIT $5::int OFFSET $6::int`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  const [{ total }] = await sql.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM inventory_pools ip JOIN inventory_skus s ON s.id = ip.sku_id JOIN products p ON p.id = ip.product_id WHERE ${where}`,
    params,
  );
  return { rows, total, page, pageSize };
}

export async function getOverview(sql: Sql) {
  const [counts] = await sql.query<{ pools: number; reliable: number; degraded: number; unknown: number; blocked: number }>(
    `SELECT count(*)::int AS pools, count(*) FILTER (WHERE reliability = 'RELIABLE')::int AS reliable, count(*) FILTER (WHERE reliability = 'DEGRADED')::int AS degraded,
            count(*) FILTER (WHERE reliability = 'UNKNOWN')::int AS unknown, count(*) FILTER (WHERE reliability = 'BLOCKED')::int AS blocked FROM inventory_pools`,
  );
  const [disc] = await sql.query<{ critical: number; warning: number; info: number }>(
    `SELECT count(*) FILTER (WHERE severity = 'CRITICAL')::int AS critical, count(*) FILTER (WHERE severity = 'WARNING')::int AS warning,
            count(*) FILTER (WHERE severity = 'INFO')::int AS info FROM inventory_discrepancies WHERE status = 'OPEN'`,
  );
  const states = await sql.query<{ state: string; n: number; qty: string }>(
    `SELECT state, count(*)::int AS n, trim_scale(sum(quantity))::text AS qty FROM inventory_reservations WHERE NOT simulated GROUP BY state`,
  );
  const [outbox] = await sql.query<{ pending: number; suppressed: number }>(
    `SELECT count(*) FILTER (WHERE status = 'PENDING')::int AS pending, count(*) FILTER (WHERE status = 'SUPPRESSED_SHADOW')::int AS suppressed FROM inventory_outbox_events`,
  );
  const [lastRun] = await listRuns(sql, 1);
  return { mode: inventoryCoreMode(), counts, discrepancies: disc, reservations: states, outbox, lastRun: lastRun ?? null };
}

export interface MovementRow {
  id: string;
  eventType: string;
  skuCode: string | null;
  productId: number | null;
  warehouseCode: string | null;
  channel: string | null;
  externalOrderId: string | null;
  quantity: string | null;
  status: string;
  origin: string;
  responsibility: string;
  simulated: boolean;
  occurredAt: Date;
  recordedAt: Date;
  correlationId: string;
  idempotencyKey: string;
  details: unknown;
}

export async function listMovements(sql: Sql, opts: { q?: string; type?: string; limit?: number } = {}): Promise<MovementRow[]> {
  const q = opts.q?.trim() || null;
  return sql.query<MovementRow>(
    `SELECT m.id::text AS id, m.event_type AS "eventType", COALESCE(m.sku_code, s.sku_code) AS "skuCode", m.product_id AS "productId", m.warehouse_code AS "warehouseCode",
            m.channel, m.external_order_id AS "externalOrderId", trim_scale(m.quantity)::text AS quantity, m.status, m.origin, m.responsibility, m.simulated,
            m.occurred_at AS "occurredAt", m.recorded_at AS "recordedAt", m.correlation_id AS "correlationId", m.idempotency_key AS "idempotencyKey", m.details
     FROM inventory_movements m LEFT JOIN inventory_skus s ON s.product_id = m.product_id
     WHERE ($1::text IS NULL OR COALESCE(m.sku_code, s.sku_code) ILIKE '%' || $1 || '%' OR m.external_order_id = $1 OR m.product_id::text = $1 OR s.ads_product_id::text = $1)
       AND ($2::text IS NULL OR m.event_type = $2::text)
     ORDER BY m.id DESC LIMIT $3::int`,
    [q, opts.type ?? null, Math.min(Math.max(opts.limit ?? 100, 1), 500)],
  );
}

export interface DiscrepancyRow {
  id: string;
  type: string;
  severity: string;
  status: string;
  message: string;
  skuCode: string | null;
  channel: string | null;
  occurrences: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
  details: unknown;
}

export async function listDiscrepancies(sql: Sql, opts: { status?: "OPEN" | "RESOLVED"; severity?: string; type?: string; limit?: number } = {}): Promise<DiscrepancyRow[]> {
  return sql.query<DiscrepancyRow>(
    `SELECT d.id::text AS id, d.type, d.severity, d.status, d.message, s.sku_code AS "skuCode", d.channel, d.occurrences,
            d.first_seen_at AS "firstSeenAt", d.last_seen_at AS "lastSeenAt", d.resolved_at AS "resolvedAt", d.details
     FROM inventory_discrepancies d LEFT JOIN inventory_skus s ON s.product_id = d.product_id
     WHERE d.status = COALESCE($1::text, 'OPEN') AND ($2::text IS NULL OR d.severity = $2::text) AND ($3::text IS NULL OR d.type = $3::text)
     ORDER BY CASE d.severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, d.last_seen_at DESC LIMIT $4::int`,
    [opts.status ?? "OPEN", opts.severity ?? null, opts.type ?? null, Math.min(Math.max(opts.limit ?? 200, 1), 1000)],
  );
}

export interface ReservationRow {
  id: string;
  channel: string;
  externalOrderId: string;
  lineKey: string;
  skuCode: string;
  quantity: string;
  state: string;
  stateReason: string | null;
  adsExternalId: string | null;
  adsPedidoId: number | null;
  adsSubmissionStatus: string | null;
  adsStatus: string | null;
  orderCreatedAt: Date | null;
  simulated: boolean;
  updatedAt: Date;
}

export async function listReservations(sql: Sql, opts: { states?: string[]; q?: string; limit?: number } = {}): Promise<ReservationRow[]> {
  return sql.query<ReservationRow>(
    `SELECT r.id::text AS id, r.channel, r.external_order_id AS "externalOrderId", r.line_key AS "lineKey", s.sku_code AS "skuCode", trim_scale(r.quantity)::text AS quantity,
            r.state, r.state_reason AS "stateReason", r.ads_external_id AS "adsExternalId", r.ads_pedido_id AS "adsPedidoId", r.ads_submission_status AS "adsSubmissionStatus",
            r.ads_status AS "adsStatus", r.order_created_at AS "orderCreatedAt", r.simulated, r.updated_at AS "updatedAt"
     FROM inventory_reservations r JOIN inventory_skus s ON s.product_id = r.product_id
     WHERE ($1::text[] IS NULL OR r.state = ANY($1::text[])) AND ($2::text IS NULL OR r.external_order_id = $2 OR s.sku_code ILIKE '%' || $2 || '%')
     ORDER BY r.order_created_at DESC NULLS LAST, r.id DESC LIMIT $3::int`,
    [opts.states?.length ? opts.states : null, opts.q?.trim() || null, Math.min(Math.max(opts.limit ?? 200, 1), 1000)],
  );
}

export interface RunRow {
  id: string;
  source: string;
  status: string;
  requestedBy: string;
  startedAt: Date;
  finishedAt: Date | null;
  summary: Record<string, unknown> | null;
  errorMessage: string | null;
}

export async function listRuns(sql: Sql, limit = 20): Promise<RunRow[]> {
  return sql.query<RunRow>(
    `SELECT id::text AS id, source, status, requested_by AS "requestedBy", started_at AS "startedAt", finished_at AS "finishedAt", summary, error_message AS "errorMessage"
     FROM inventory_reconciliation_runs ORDER BY started_at DESC LIMIT $1::int`,
    [limit],
  );
}

export async function listRunProposals(sql: Sql, runId: string) {
  return sql.query<{ id: string; skuCode: string; currentQuantity: number | null; targetQuantity: number | null; direction: string | null; status: string; reasonCode: string | null; reason: string | null; writeBlocked: boolean; details: unknown }>(
    `SELECT pr.id::text AS id, s.sku_code AS "skuCode", pr.current_quantity AS "currentQuantity", pr.target_quantity AS "targetQuantity", pr.direction, pr.status,
            pr.reason_code AS "reasonCode", pr.reason, pr.write_blocked AS "writeBlocked", pr.details
     FROM inventory_sync_proposals pr JOIN inventory_pools ip ON ip.id = pr.pool_id JOIN inventory_skus s ON s.id = ip.sku_id
     WHERE pr.run_id = $1::uuid ORDER BY pr.status, s.sku_code`,
    [runId],
  );
}
