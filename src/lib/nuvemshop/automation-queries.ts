import "server-only";
import { inventoryCoreMode } from "../inventory/mode";
import type { Sql } from "../sql";
import { listAutomations, type AutomationKind } from "./automation";
import { missingPhase2Scopes } from "./connection";
import { webhookOverview } from "./events";
import { getOrderCursor, orderProtectionState } from "./orders";
import { priceActivationBlockers } from "./price-sync";
import { stockActivationBlockers } from "./stock-sync";
import { getConnectedStore } from "./store";
import { getEmergencyStop, nuvemshopWriteEnv } from "./write-gate";
import { listJobs } from "./write-jobs";

/** Dados do painel /nuvemshop/automacoes (somente leitura do banco local). */
export async function automationOverview(sql: Sql) {
  const store = await getConnectedStore(sql);
  const storeId = store?.storeId ?? null;
  const automations = await listAutomations(sql);
  const stop = await getEmergencyStop(sql);
  const decisions = storeId
    ? await sql.query<{ kind: AutomationKind; decision: string | null; n: number }>(
        `SELECT kind, last_decision AS decision, count(*)::int AS n FROM nuvemshop_sync_variants WHERE store_id = $1 GROUP BY 1, 2`,
        [storeId],
      )
    : [];
  const participation = storeId
    ? await sql.query<{ kind: AutomationKind; participation: string; n: number }>(
        `SELECT kind, participation, count(*)::int AS n FROM nuvemshop_sync_variants WHERE store_id = $1 GROUP BY 1, 2`,
        [storeId],
      )
    : [];
  const [linked] = storeId ? await sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM nuvemshop_variant_mappings WHERE store_id = $1 AND status = 'CONFIRMED'`, [storeId]) : [{ n: 0 }];
  const jobs = await sql.query<{ kind: AutomationKind; status: string; n: number }>(
    `SELECT kind, status, count(*)::int AS n FROM nuvemshop_write_jobs WHERE created_at > now() - interval '7 days' OR status IN ('PENDING', 'RUNNING', 'UNCERTAIN', 'REQUIRES_RECONCILIATION') GROUP BY 1, 2`,
  );
  const runs = await sql.query(
    `SELECT id::text AS id, kind, mode, trigger, status, requested_by AS "requestedBy", started_at AS "startedAt", finished_at AS "finishedAt", summary, error_message AS "errorMessage"
     FROM nuvemshop_sync_runs ORDER BY started_at DESC LIMIT 30`,
  );
  const attention = await listJobs(sql, { status: ["UNCERTAIN", "REQUIRES_RECONCILIATION", "FAILED"], limit: 50 });
  const queue = await listJobs(sql, { status: ["PENDING", "RUNNING"], limit: 50 });
  const recent = await listJobs(sql, { status: ["SUCCEEDED", "SUPERSEDED", "CANCELED"], limit: 30 });
  const blocked = storeId
    ? await sql.query(
        `SELECT sv.kind, sv.variant_id::text AS "variantId", v.sku, p.name, sv.last_reason_code AS "reasonCode", sv.last_reason AS reason, sv.last_target AS target,
                sv.last_remote_value AS remote, sv.participation, sv.evaluated_at AS "evaluatedAt"
         FROM nuvemshop_sync_variants sv JOIN nuvemshop_variants v ON v.store_id = sv.store_id AND v.variant_id = sv.variant_id
         JOIN nuvemshop_products p ON p.store_id = v.store_id AND p.product_id = v.product_id
         WHERE sv.store_id = $1 AND sv.last_decision IN ('BLOCKED', 'REVIEW') ORDER BY sv.evaluated_at DESC NULLS LAST LIMIT 100`,
        [storeId],
      )
    : [];
  const reviews = await sql.query(
    `SELECT i.id::text AS id, i.variant_id::text AS "variantId", v.sku, p.name, i.current_value AS current, i.base_value AS base, i.target_value AS target, i.change_pct AS "changePct",
            i.reason, i.created_at AS "createdAt"
     FROM nuvemshop_sync_items i JOIN nuvemshop_variants v ON v.store_id = i.store_id AND v.variant_id = i.variant_id
     JOIN nuvemshop_products p ON p.store_id = v.store_id AND p.product_id = v.product_id
     WHERE i.kind = 'PRICE' AND i.decision = 'REVIEW' AND i.created_at > now() - interval '1 hour'
       AND i.id = (SELECT max(i2.id) FROM nuvemshop_sync_items i2 WHERE i2.store_id = i.store_id AND i2.variant_id = i.variant_id AND i2.kind = 'PRICE')
     ORDER BY i.created_at DESC LIMIT 50`,
  );
  const orders = storeId
    ? await sql.query<{ state: string; n: number }>(`SELECT commitment_state AS state, count(*)::int AS n FROM nuvemshop_orders WHERE store_id = $1 GROUP BY 1`, [storeId])
    : [];
  const pendingOrders = storeId
    ? await sql.query(
        `SELECT order_id::text AS "orderId", number::text AS number, status, payment_status AS "paymentStatus", remote_created_at AS "createdAt", lines, mapping_state AS "mappingState",
                commitment_state AS "commitmentState", unmapped_lines AS "unmappedLines"
         FROM nuvemshop_orders WHERE store_id = $1 AND (commitment_state IN ('COMMITTED', 'REQUIRES_RECONCILIATION') OR unmapped_lines > 0) AND COALESCE(status, '') <> 'cancelled'
         ORDER BY remote_created_at DESC NULLS LAST LIMIT 100`,
        [storeId],
      )
    : [];
  const [tick] = await sql.query<{ value: unknown; updatedAt: Date }>(`SELECT value, updated_at AS "updatedAt" FROM app_settings WHERE key = 'nuvemshop_tick_last'`);
  const [schedulerTick] = await sql.query<{ updatedAt: Date }>(`SELECT updated_at AS "updatedAt" FROM app_settings WHERE key = 'meli_scheduler_last_tick'`);
  return {
    store: store ? { storeId: store.storeId, storeName: store.storeName, connectionStatus: store.connectionStatus, grantedScopes: store.grantedScopes, multiLocation: store.multiLocation, missingPhase2Scopes: missingPhase2Scopes(store.grantedScopes) } : null,
    writeEnv: nuvemshopWriteEnv(),
    inventoryCore: inventoryCoreMode(),
    emergencyStop: stop,
    automations,
    activationBlockers: { PRICE: await priceActivationBlockers(sql), STOCK: await stockActivationBlockers(sql) },
    linkedVariants: linked?.n ?? 0,
    decisions,
    participation,
    jobs,
    runs,
    attention,
    queue,
    recent,
    blocked,
    reviews,
    orders,
    pendingOrders,
    orderProtection: store ? await orderProtectionState(sql, store) : null,
    orderCursor: await getOrderCursor(sql),
    webhooks: storeId ? await webhookOverview(sql, storeId) : null,
    worker: { lastNuvemshopTick: tick ?? null, lastSchedulerTickAt: schedulerTick?.updatedAt ?? null },
  };
}

/** Variantes vinculadas com participação e última decisão, para selecionar SKUs. */
export async function automationVariants(sql: Sql, storeId: string, opts: { kind: AutomationKind; q?: string | null; participation?: string | null; page?: number }) {
  const page = Math.max(1, opts.page ?? 1);
  const q = opts.q?.trim() ? `%${opts.q.trim().toLowerCase()}%` : null;
  return sql.query(
    `SELECT v.variant_id::text AS "variantId", v.product_id::text AS "nsProductId", v.sku, p.name, trim_scale(v.price)::text AS price, trim_scale(v.promotional_price)::text AS "promotionalPrice",
            v.stock, v.stock_management AS "stockManagement", m.product_id AS "productId", ap.ads_product_id AS "adsProductId",
            COALESCE(sv.participation, 'NONE') AS participation, sv.last_decision AS "lastDecision", sv.last_reason AS "lastReason", sv.last_target AS "lastTarget",
            sv.last_written_value AS "lastWritten", sv.last_written_at AS "lastWrittenAt", sv.last_origin AS "lastOrigin", sv.evaluated_at AS "evaluatedAt"
     FROM nuvemshop_variant_mappings m
     JOIN nuvemshop_variants v ON v.store_id = m.store_id AND v.variant_id = m.variant_id
     JOIN nuvemshop_products p ON p.store_id = v.store_id AND p.product_id = v.product_id
     JOIN products ap ON ap.id = m.product_id
     LEFT JOIN nuvemshop_sync_variants sv ON sv.store_id = m.store_id AND sv.variant_id = m.variant_id AND sv.kind = $2
     WHERE m.store_id = $1 AND m.status = 'CONFIRMED' AND v.sync_status = 'ACTIVE'
       AND ($3::text IS NULL OR lower(coalesce(v.sku, '')) LIKE $3 OR lower(coalesce(p.name, '')) LIKE $3 OR v.variant_id::text = trim($4))
       AND ($5::text IS NULL OR COALESCE(sv.participation, 'NONE') = $5)
     ORDER BY (COALESCE(sv.participation, 'NONE') = 'NONE'), p.name, v.variant_id LIMIT 50 OFFSET $6`,
    [storeId, opts.kind, q, opts.q ?? "", opts.participation ?? null, (page - 1) * 50],
  );
}

export async function runDetail(sql: Sql, runId: string) {
  const [run] = await sql.query(
    `SELECT id::text AS id, kind, mode, trigger, status, requested_by AS "requestedBy", inventory_run_id::text AS "inventoryRunId", started_at AS "startedAt", finished_at AS "finishedAt", summary, error_message AS "errorMessage"
     FROM nuvemshop_sync_runs WHERE id = $1::uuid`,
    [runId],
  );
  if (!run) return null;
  const items = await sql.query(
    `SELECT i.id::text AS id, i.variant_id::text AS "variantId", v.sku, p.name, i.location_id AS "locationId", i.current_value AS current, i.base_value AS base, i.target_value AS target,
            i.change_pct AS "changePct", i.decision, i.reason_code AS "reasonCode", i.reason, i.job_id::text AS "jobId", j.status AS "jobStatus", i.details
     FROM nuvemshop_sync_items i LEFT JOIN nuvemshop_variants v ON v.store_id = i.store_id AND v.variant_id = i.variant_id
     LEFT JOIN nuvemshop_products p ON p.store_id = i.store_id AND p.product_id = i.nuvemshop_product_id
     LEFT JOIN nuvemshop_write_jobs j ON j.id = i.job_id
     WHERE i.run_id = $1::uuid ORDER BY i.decision, i.id LIMIT 500`,
    [runId],
  );
  return { run, items };
}

export async function jobDetail(sql: Sql, jobId: string) {
  const attempts = await sql.query(
    `SELECT attempt, batch_id::text AS "batchId", batch_size AS "batchSize", outcome, http_status AS "httpStatus", error_code AS "errorCode", message, observed_before AS "before",
            observed_after AS "after", duration_ms AS "durationMs", created_at AS "createdAt" FROM nuvemshop_write_attempts WHERE job_id = $1::uuid ORDER BY id`,
    [jobId],
  );
  return { attempts };
}
