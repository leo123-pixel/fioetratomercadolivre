import "server-only";
import { inventoryCoreMode } from "../inventory/mode";
import { getInventorySettings } from "../inventory/settings";
import type { Sql } from "../sql";
import { getConnectedStore, getLatestStore } from "./store";

/** Consultas de leitura do catálogo importado (painel /nuvemshop). Nenhuma chamada à Nuvemshop. */

export const VARIANT_FILTERS = [
  "all",
  "linked",
  "unlinked",
  "pending",
  "ambiguous",
  "review",
  "duplicate_sku",
  "no_sku",
  "no_gtin",
  "stock_divergent",
  "stock_unknown",
  "removed",
] as const;
export type VariantFilter = (typeof VARIANT_FILTERS)[number];

export interface VariantRow {
  variantId: string;
  productId: string;
  productName: string | null;
  optionValues: unknown;
  sku: string | null;
  barcode: string | null;
  gtin: string | null;
  price: string | null;
  promotionalPrice: string | null;
  stockManagement: boolean | null;
  stock: number | null;
  hasInventoryLevels: boolean;
  visibility: string | null;
  visible: boolean | null;
  isKit: boolean;
  syncStatus: string;
  imageSrc: string | null;
  canonicalUrl: string | null;
  remoteUpdatedAt: Date | null;
  fetchedAt: Date;
  linkStatus: "CONFIRMED" | "NEEDS_REVIEW" | "PENDING" | "AMBIGUOUS" | "UNLINKED";
  linkProductId: number | null;
  linkAdsProductId: number | null;
  linkProductName: string | null;
  linkCriterion: string | null;
  linkConfidence: string | null;
  linkDecidedBy: string | null;
  linkDecidedAt: Date | null;
  reviewReason: string | null;
  componentCount: number;
  suggestionCount: number;
  suggestedProductId: number | null;
  suggestedAdsProductId: number | null;
  suggestedProductName: string | null;
  suggestionCriterion: string | null;
  suggestionConfidence: string | null;
  duplicateSku: boolean;
  duplicateGtin: boolean;
  adsQuantity: string | null;
  adsStatus: string | null;
  safeSellable: number | null;
  nsQuotaSimulated: number | null;
}

const BASE = `
  FROM nuvemshop_variants v
  JOIN nuvemshop_products p ON p.store_id = v.store_id AND p.product_id = v.product_id
  LEFT JOIN LATERAL (SELECT m.* FROM nuvemshop_variant_mappings m WHERE m.store_id = v.store_id AND m.variant_id = v.variant_id AND m.status IN ('CONFIRMED','NEEDS_REVIEW') LIMIT 1) cm ON true
  LEFT JOIN products lp ON lp.id = cm.product_id
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS n, count(DISTINCT s.product_id)::int AS products,
           (array_agg(s.product_id ORDER BY s.confidence = 'HIGH' DESC, s.id))[1] AS product_id,
           (array_agg(s.criterion ORDER BY s.confidence = 'HIGH' DESC, s.id))[1] AS criterion,
           (array_agg(s.confidence ORDER BY s.confidence = 'HIGH' DESC, s.id))[1] AS confidence
    FROM nuvemshop_variant_mappings s WHERE s.store_id = v.store_id AND s.variant_id = v.variant_id AND s.status = 'SUGGESTED') sg ON true
  LEFT JOIN products sp ON sp.id = sg.product_id
  LEFT JOIN inventory_pools ip ON ip.product_id = cm.product_id AND ip.warehouse_code = $2
  LEFT JOIN inventory_channel_allocations na ON na.pool_id = ip.id AND na.channel = 'nuvemshop'`;

const DUP_SKU = `(v.sku_norm IS NOT NULL AND EXISTS (SELECT 1 FROM nuvemshop_variants d WHERE d.store_id = v.store_id AND d.sku_norm = v.sku_norm AND d.variant_id <> v.variant_id AND d.sync_status = 'ACTIVE'))`;
const DUP_GTIN = `(v.gtin IS NOT NULL AND EXISTS (SELECT 1 FROM nuvemshop_variants d WHERE d.store_id = v.store_id AND d.gtin = v.gtin AND d.variant_id <> v.variant_id AND d.sync_status = 'ACTIVE'))`;

const FILTER_SQL: Record<VariantFilter, string> = {
  all: `v.sync_status = 'ACTIVE'`,
  linked: `v.sync_status = 'ACTIVE' AND cm.status = 'CONFIRMED'`,
  unlinked: `v.sync_status = 'ACTIVE' AND cm.id IS NULL`,
  pending: `v.sync_status = 'ACTIVE' AND cm.id IS NULL AND sg.products = 1`,
  ambiguous: `v.sync_status = 'ACTIVE' AND cm.id IS NULL AND sg.products > 1`,
  review: `cm.status = 'NEEDS_REVIEW'`,
  duplicate_sku: `v.sync_status = 'ACTIVE' AND ${DUP_SKU}`,
  no_sku: `v.sync_status = 'ACTIVE' AND v.sku_norm IS NULL`,
  no_gtin: `v.sync_status = 'ACTIVE' AND v.gtin IS NULL`,
  stock_divergent: `v.sync_status = 'ACTIVE' AND cm.status = 'CONFIRMED' AND v.stock_management AND v.stock IS NOT NULL AND ip.ads_status = 'KNOWN' AND v.stock <> floor(ip.ads_quantity)::int`,
  stock_unknown: `v.sync_status = 'ACTIVE' AND (v.stock_management IS DISTINCT FROM true OR v.stock IS NULL)`,
  removed: `v.sync_status = 'REMOVED'`,
};

const SELECT = `
  v.variant_id::text AS "variantId", v.product_id::text AS "productId", p.name AS "productName", v.option_values AS "optionValues", v.sku, v.barcode, v.gtin,
  v.price::text AS price, v.promotional_price::text AS "promotionalPrice", v.stock_management AS "stockManagement", v.stock,
  v.has_inventory_levels AS "hasInventoryLevels", p.visibility, v.visible, p.is_kit AS "isKit", v.sync_status AS "syncStatus",
  COALESCE((SELECT i.src FROM nuvemshop_product_images i WHERE i.store_id = v.store_id AND i.image_id = v.image_id),
           (SELECT i.src FROM nuvemshop_product_images i WHERE i.store_id = v.store_id AND i.product_id = v.product_id ORDER BY i.position NULLS LAST, i.image_id LIMIT 1)) AS "imageSrc",
  p.canonical_url AS "canonicalUrl", v.remote_updated_at AS "remoteUpdatedAt", v.fetched_at AS "fetchedAt",
  CASE WHEN cm.status = 'CONFIRMED' THEN 'CONFIRMED' WHEN cm.status = 'NEEDS_REVIEW' THEN 'NEEDS_REVIEW'
       WHEN sg.products > 1 THEN 'AMBIGUOUS' WHEN sg.products = 1 THEN 'PENDING' ELSE 'UNLINKED' END AS "linkStatus",
  cm.product_id AS "linkProductId", cm.ads_product_id AS "linkAdsProductId", COALESCE(lp.name_custom, lp.name_original) AS "linkProductName",
  cm.criterion AS "linkCriterion", cm.confidence AS "linkConfidence", cm.decided_by AS "linkDecidedBy", cm.decided_at AS "linkDecidedAt", cm.review_reason AS "reviewReason",
  COALESCE((SELECT count(*)::int FROM nuvemshop_mapping_components c WHERE c.mapping_id = cm.id), 0) AS "componentCount",
  COALESCE(sg.products, 0) AS "suggestionCount", sg.product_id AS "suggestedProductId", sp.ads_product_id AS "suggestedAdsProductId",
  COALESCE(sp.name_custom, sp.name_original) AS "suggestedProductName", sg.criterion AS "suggestionCriterion", sg.confidence AS "suggestionConfidence",
  ${DUP_SKU} AS "duplicateSku", ${DUP_GTIN} AS "duplicateGtin",
  trim_scale(ip.ads_quantity)::text AS "adsQuantity", ip.ads_status AS "adsStatus", ip.safe_sellable AS "safeSellable", na.desired_quantity AS "nsQuotaSimulated"`;

export async function nuvemshopWarehouse(sql: Sql): Promise<string> {
  return (await getInventorySettings(sql)).channelWarehouses.nuvemshop ?? "principal";
}

export async function listVariants(
  sql: Sql,
  opts: { storeId: string; filter?: VariantFilter; q?: string; page?: number; pageSize?: number; variantIds?: string[] },
): Promise<{ items: VariantRow[]; total: number; page: number; pageSize: number; counts: Record<VariantFilter, number> }> {
  const filter = opts.filter && VARIANT_FILTERS.includes(opts.filter) ? opts.filter : "all";
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 200);
  const page = Math.max(opts.page ?? 1, 1);
  const warehouse = await nuvemshopWarehouse(sql);
  const q = opts.q?.trim() ? `%${opts.q.trim()}%` : null;
  const where = `v.store_id = $1 AND (${FILTER_SQL[filter]})
    AND ($3::text IS NULL OR p.name ILIKE $3 OR v.sku ILIKE $3 OR v.barcode ILIKE $3 OR v.variant_id::text = trim($4::text) OR v.product_id::text = trim($4::text)
         OR COALESCE(lp.name_custom, lp.name_original, '') ILIKE $3 OR cm.ads_product_id::text = trim($4::text))
    AND ($5::bigint[] IS NULL OR v.variant_id = ANY($5::bigint[]))`;
  const params = [opts.storeId, warehouse, q, opts.q ?? "", opts.variantIds ?? null];
  const items = await sql.query<VariantRow>(
    `SELECT ${SELECT} ${BASE} WHERE ${where} ORDER BY p.name NULLS LAST, v.product_id, v.position NULLS LAST, v.variant_id LIMIT $6::int OFFSET $7::int`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  const [{ total }] = await sql.query<{ total: number }>(`SELECT count(*)::int AS total ${BASE} WHERE ${where}`, params);
  const countCols = VARIANT_FILTERS.map((f) => `count(*) FILTER (WHERE ${FILTER_SQL[f]})::int AS "${f}"`).join(", ");
  const [counts] = await sql.query<Record<VariantFilter, number>>(`SELECT ${countCols} ${BASE} WHERE v.store_id = $1`, [opts.storeId, warehouse]);
  return { items, total, page, pageSize, counts };
}

export async function variantDetail(sql: Sql, storeId: string, variantId: string) {
  if (!/^\d{1,20}$/.test(variantId)) return null;
  const { items } = await listVariants(sql, { storeId, filter: "all", variantIds: [variantId], pageSize: 1 });
  let row = items[0];
  if (!row) row = (await listVariants(sql, { storeId, filter: "removed", variantIds: [variantId], pageSize: 1 })).items[0];
  if (!row) return null;
  const levels = await sql.query<{ locationId: string; stock: number | null; locationName: string | null; mappingStatus: string | null; warehouseCode: string | null }>(
    `SELECT l.location_id AS "locationId", l.stock, nl.name AS "locationName", nl.mapping_status AS "mappingStatus", nl.warehouse_code AS "warehouseCode"
     FROM nuvemshop_inventory_levels l LEFT JOIN nuvemshop_locations nl ON nl.store_id = l.store_id AND nl.location_id = l.location_id
     WHERE l.store_id = $1 AND l.variant_id = $2::bigint ORDER BY l.location_id`,
    [storeId, variantId],
  );
  const components = row.linkProductId
    ? await sql.query<{ productId: number; adsProductId: number; name: string; quantity: number }>(
        `SELECT c.product_id AS "productId", c.ads_product_id AS "adsProductId", COALESCE(p.name_custom, p.name_original) AS name, c.quantity
         FROM nuvemshop_mapping_components c JOIN nuvemshop_variant_mappings m ON m.id = c.mapping_id JOIN products p ON p.id = c.product_id
         WHERE m.store_id = $1 AND m.variant_id = $2::bigint AND m.status IN ('CONFIRMED','NEEDS_REVIEW') ORDER BY c.product_id`,
        [storeId, variantId],
      )
    : [];
  return { row, levels, components };
}

/** Resumo do painel /nuvemshop. */
export async function dashboardSummary(sql: Sql) {
  const store = await getLatestStore(sql);
  const connected = await getConnectedStore(sql);
  const storeId = store?.storeId ?? null;
  const [catalog] = storeId
    ? await sql.query<{ products: number; variants: number; removed: number; linked: number; review: number; noSku: number; images: number }>(
        `SELECT (SELECT count(*)::int FROM nuvemshop_products WHERE store_id = $1 AND sync_status = 'ACTIVE') AS products,
                (SELECT count(*)::int FROM nuvemshop_variants WHERE store_id = $1 AND sync_status = 'ACTIVE') AS variants,
                (SELECT count(*)::int FROM nuvemshop_variants WHERE store_id = $1 AND sync_status = 'REMOVED') AS removed,
                (SELECT count(*)::int FROM nuvemshop_variant_mappings m JOIN nuvemshop_variants v ON v.store_id = m.store_id AND v.variant_id = m.variant_id
                   WHERE m.store_id = $1 AND m.status = 'CONFIRMED' AND v.sync_status = 'ACTIVE') AS linked,
                (SELECT count(*)::int FROM nuvemshop_variant_mappings WHERE store_id = $1 AND status = 'NEEDS_REVIEW') AS review,
                (SELECT count(*)::int FROM nuvemshop_variants WHERE store_id = $1 AND sync_status = 'ACTIVE' AND sku_norm IS NULL) AS "noSku",
                (SELECT count(*)::int FROM nuvemshop_product_images WHERE store_id = $1) AS images`,
        [storeId],
      )
    : [{ products: 0, variants: 0, removed: 0, linked: 0, review: 0, noSku: 0, images: 0 }];
  const counts = storeId ? (await listVariants(sql, { storeId, filter: "all", pageSize: 1 })).counts : null;
  const [lastImport] = await sql.query<{ id: string; mode: string; status: string; startedAt: Date | null; finishedAt: Date | null; productsSeen: number; variantsSeen: number; failedCount: number; lastError: string | null; cursor: { phase?: string; page?: number }; createdAt: Date }>(
    `SELECT id::text AS id, mode, status, started_at AS "startedAt", finished_at AS "finishedAt", products_seen AS "productsSeen", variants_seen AS "variantsSeen",
            failed_count AS "failedCount", last_error AS "lastError", cursor, created_at AS "createdAt"
     FROM nuvemshop_catalog_import_jobs ${storeId ? "WHERE store_id = $1" : ""} ORDER BY created_at DESC LIMIT 1`,
    storeId ? [storeId] : [],
  );
  const [failures] = await sql.query<{ failed: number }>(`SELECT count(*)::int AS failed FROM nuvemshop_catalog_import_jobs WHERE status IN ('FAILED','PARTIALLY_COMPLETED') AND created_at > now() - interval '30 days'`);
  const warehouse = await nuvemshopWarehouse(sql);
  const [inv] = await sql.query<{ pools: number; observed: number; lastRun: Date | null }>(
    `SELECT (SELECT count(DISTINCT ip.id)::int FROM inventory_pools ip JOIN nuvemshop_variant_mappings m ON m.product_id = ip.product_id AND m.status = 'CONFIRMED' WHERE ip.warehouse_code = $1) AS pools,
            (SELECT count(*)::int FROM inventory_channel_allocations a JOIN inventory_pools ip ON ip.id = a.pool_id WHERE a.channel = 'nuvemshop' AND a.confirmed_quantity IS NOT NULL AND ip.warehouse_code = $1) AS observed,
            (SELECT max(finished_at) FROM inventory_reconciliation_runs WHERE status IN ('COMPLETED','PARTIAL')) AS "lastRun"`,
    [warehouse],
  );
  const locations = storeId
    ? await sql.query<{ locationId: string; name: string | null; isDefault: boolean | null; removed: boolean; mappingStatus: string; warehouseCode: string | null }>(
        `SELECT location_id AS "locationId", name, is_default AS "isDefault", (removed_at IS NOT NULL) AS removed, mapping_status AS "mappingStatus", warehouse_code AS "warehouseCode"
         FROM nuvemshop_locations WHERE store_id = $1 ORDER BY removed_at NULLS FIRST, priority NULLS LAST, location_id`,
        [storeId],
      )
    : [];
  return {
    store,
    connected: Boolean(connected && connected.connectionStatus === "ACTIVE"),
    catalog,
    counts,
    lastImport: lastImport ?? null,
    recentFailures: failures?.failed ?? 0,
    inventory: { mode: inventoryCoreMode(), warehouse, ...inv },
    locations,
  };
}

/**
 * Simulação de estoque por produto ADS vinculado: valores do Inventory Core (última reconciliação sombra)
 * lado a lado com o observado em cada canal. Nada aqui é aplicado.
 */
export async function simulationRows(sql: Sql, storeId: string, opts: { page?: number; pageSize?: number; q?: string } = {}) {
  const warehouse = await nuvemshopWarehouse(sql);
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 200);
  const page = Math.max(opts.page ?? 1, 1);
  const q = opts.q?.trim() ? `%${opts.q.trim()}%` : null;
  const where = `EXISTS (SELECT 1 FROM nuvemshop_variant_mappings m WHERE m.store_id = $1 AND m.product_id = pr.id AND m.status = 'CONFIRMED')
    AND ($3::text IS NULL OR COALESCE(pr.name_custom, pr.name_original) ILIKE $3 OR pr.ads_product_id::text = trim($4::text))`;
  const rows = await sql.query<{
    productId: number;
    adsProductId: number;
    name: string;
    variants: number;
    nsStockReported: number | null;
    poolId: string | null;
    adsStatus: string | null;
    adsQuantity: string | null;
    safetyReserve: number | null;
    pendingCommitments: string | null;
    safeSellable: number | null;
    reliability: string | null;
    mlQuota: number | null;
    mlObserved: number | null;
    nsQuota: number | null;
    nsObserved: number | null;
    computedAt: Date | null;
    openAlerts: number;
  }>(
    `SELECT pr.id AS "productId", pr.ads_product_id AS "adsProductId", COALESCE(pr.name_custom, pr.name_original) AS name,
            (SELECT count(*)::int FROM nuvemshop_variant_mappings m WHERE m.store_id = $1 AND m.product_id = pr.id AND m.status = 'CONFIRMED') AS variants,
            (SELECT CASE WHEN bool_and(v.stock_management AND v.stock IS NOT NULL) THEN sum(v.stock)::int END
               FROM nuvemshop_variant_mappings m JOIN nuvemshop_variants v ON v.store_id = m.store_id AND v.variant_id = m.variant_id
               WHERE m.store_id = $1 AND m.product_id = pr.id AND m.status = 'CONFIRMED' AND v.sync_status = 'ACTIVE') AS "nsStockReported",
            ip.id::text AS "poolId", ip.ads_status AS "adsStatus", trim_scale(ip.ads_quantity)::text AS "adsQuantity", ip.safety_reserve AS "safetyReserve",
            trim_scale(ip.pending_commitments)::text AS "pendingCommitments", ip.safe_sellable AS "safeSellable", ip.reliability,
            ml.desired_quantity AS "mlQuota", ml.confirmed_quantity AS "mlObserved", ns.desired_quantity AS "nsQuota", ns.confirmed_quantity AS "nsObserved",
            ip.computed_at AS "computedAt",
            COALESCE((SELECT count(*)::int FROM inventory_discrepancies d WHERE d.pool_id = ip.id AND d.status = 'OPEN'), 0) AS "openAlerts"
     FROM products pr
     LEFT JOIN inventory_pools ip ON ip.product_id = pr.id AND ip.warehouse_code = $2
     LEFT JOIN inventory_channel_allocations ml ON ml.pool_id = ip.id AND ml.channel = 'mercadolivre'
     LEFT JOIN inventory_channel_allocations ns ON ns.pool_id = ip.id AND ns.channel = 'nuvemshop'
     WHERE ${where}
     ORDER BY COALESCE(pr.name_custom, pr.name_original) LIMIT $5::int OFFSET $6::int`,
    [storeId, warehouse, q, opts.q ?? "", pageSize, (page - 1) * pageSize],
  );
  const [{ total }] = await sql.query<{ total: number }>(`SELECT count(*)::int AS total FROM products pr WHERE $2::text IS NOT NULL AND ${where}`, [storeId, warehouse, q, opts.q ?? ""]);
  return { rows, total, page, pageSize, warehouse };
}
