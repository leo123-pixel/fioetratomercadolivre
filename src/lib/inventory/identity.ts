import "server-only";
import type { Sql } from "../sql";

/**
 * Identidade central: SKU físico (produto ADS) e pool (SKU × depósito compatível).
 * O código do SKU segue o padrão já usado nos anúncios: ADS-<produtoId>.
 */
export const poolKeyOf = (productId: number, warehouseCode: string) => `sku:${productId}@${warehouseCode}`;

export interface SkuRecord {
  skuId: string;
  productId: number;
  adsProductId: number;
  skuCode: string;
  unit: string | null;
  quantityScale: "INTEGER" | "DECIMAL";
  erpKit: boolean;
}

export interface PoolRecord {
  id: string;
  poolKey: string;
  skuId: string;
  productId: number;
  warehouseCode: string;
  adsStatus: "KNOWN" | "UNKNOWN" | "ERROR";
  adsQuantity: string | null;
  adsFetchedAt: Date | null;
  version: number;
}

export async function ensureSkus(sql: Sql, productIds: number[]): Promise<Map<number, SkuRecord>> {
  const ids = [...new Set(productIds)].filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return new Map();
  await sql.execute(
    `INSERT INTO inventory_skus (product_id, ads_product_id, sku_code, unit, erp_kit, quantity_scale)
     SELECT p.id, p.ads_product_id, 'ADS-' || p.ads_product_id, p.unit, COALESCE(p.raw_payload->>'kit', 'false') = 'true',
            CASE WHEN EXISTS (SELECT 1 FROM product_stocks s WHERE s.product_id = p.id AND s.quantity <> trunc(s.quantity)) THEN 'DECIMAL' ELSE 'INTEGER' END
     FROM products p WHERE p.id = ANY($1::int[])
     ON CONFLICT (product_id) DO UPDATE SET unit = EXCLUDED.unit, erp_kit = EXCLUDED.erp_kit,
       quantity_scale = CASE WHEN inventory_skus.quantity_scale = 'DECIMAL' THEN 'DECIMAL' ELSE EXCLUDED.quantity_scale END, updated_at = now()
     WHERE (inventory_skus.unit, inventory_skus.erp_kit, inventory_skus.quantity_scale) IS DISTINCT FROM (EXCLUDED.unit, EXCLUDED.erp_kit,
       CASE WHEN inventory_skus.quantity_scale = 'DECIMAL' THEN 'DECIMAL' ELSE EXCLUDED.quantity_scale END)`,
    [ids],
  );
  const rows = await sql.query<SkuRecord>(
    `SELECT id::text AS "skuId", product_id AS "productId", ads_product_id AS "adsProductId", sku_code AS "skuCode", unit,
            quantity_scale AS "quantityScale", erp_kit AS "erpKit"
     FROM inventory_skus WHERE product_id = ANY($1::int[])`,
    [ids],
  );
  return new Map(rows.map((r) => [r.productId, r]));
}

const POOL_COLS = `id::text AS id, pool_key AS "poolKey", sku_id::text AS "skuId", product_id AS "productId", warehouse_code AS "warehouseCode",
  ads_status AS "adsStatus", trim_scale(ads_quantity)::text AS "adsQuantity", ads_fetched_at AS "adsFetchedAt", version`;

export async function ensurePool(sql: Sql, sku: SkuRecord, warehouseCode: string): Promise<PoolRecord> {
  const key = poolKeyOf(sku.productId, warehouseCode);
  await sql.execute(
    `INSERT INTO inventory_pools (sku_id, product_id, warehouse_code, pool_key) VALUES ($1::bigint, $2::int, $3::text, $4::text) ON CONFLICT (pool_key) DO NOTHING`,
    [sku.skuId, sku.productId, warehouseCode, key],
  );
  const [row] = await sql.query<PoolRecord>(`SELECT ${POOL_COLS} FROM inventory_pools WHERE pool_key = $1::text`, [key]);
  return row;
}

export async function lockPoolRow(sql: Sql, poolId: string): Promise<PoolRecord> {
  const [row] = await sql.query<PoolRecord>(`SELECT ${POOL_COLS} FROM inventory_pools WHERE id = $1::bigint FOR UPDATE`, [poolId]);
  return row;
}
