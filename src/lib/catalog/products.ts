import "server-only";
import type { Sql } from "../sql";
import { getCatalogSettings, type CatalogSettings } from "./settings";

export type StockFilter = "positive" | "zero" | "unknown";

export interface ProductFilters {
  q?: string;
  supplierId?: number;
  divisionId?: string;
  stock?: StockFilter;
  status?: "active" | "inactive";
  image?: "with" | "without";
  draft?: "none" | "any" | "DRAFT" | "READY" | "published" | "unpublished";
  price?: "with" | "without";
  sort?: "name" | "ads_id" | "updated" | "stock";
  page?: number;
  pageSize?: number;
}

export interface ProductListItem {
  id: number;
  adsProductId: number;
  name: string;
  nameOriginal: string;
  hasCustomName: boolean;
  ean: string | null;
  manufacturerCode: string | null;
  supplierId: number | null;
  supplierName: string | null;
  inactive: boolean;
  primaryImageUrl: string | null;
  imageCount: number;
  referencePrice: string | null;
  referenceBranch: string | null;
  stockTotal: string | null;
  stockBranches: number;
  stockFetchedAt: Date | null;
  draftId: number | null;
  draftStatus: string | null;
  marketplaceItemId: string | null;
  permalink: string | null;
  listingStatus: string | null;
}

export interface ProductListResult {
  items: ProductListItem[];
  total: number;
  page: number;
  pageSize: number;
  settings: CatalogSettings;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Monta o SELECT base do catálogo com preço de referência (tabela/filial configuradas, apenas preços
 * ativos), estoque agregado (sem linhas = desconhecido), imagem principal e rascunho.
 * $1 = tabela de referência, $2 = filial de referência.
 */
const BASE_FROM = `
  FROM products p
  LEFT JOIN ads_suppliers s ON s.id = p.supplier_id
  LEFT JOIN LATERAL (
    SELECT public_url, count(*) OVER ()::int AS n FROM product_images i
    WHERE i.product_id = p.id ORDER BY i.is_primary DESC, i.position, i.id LIMIT 1
  ) img ON true
  LEFT JOIN LATERAL (
    SELECT pp.price, pp.branch_id FROM product_prices pp
    WHERE pp.product_id = p.id AND pp.price_table_code = $1::text AND NOT pp.inactive AND pp.price IS NOT NULL
      AND ($2::text IS NULL OR pp.branch_id = $2::text)
    ORDER BY pp.branch_id LIMIT 1
  ) rp ON true
  LEFT JOIN LATERAL (
    SELECT sum(st.quantity) AS total, count(*)::int AS branches, max(st.fetched_at) AS fetched_at
    FROM product_stocks st WHERE st.product_id = p.id
  ) stk ON true
  LEFT JOIN listing_drafts d ON d.product_id = p.id
  LEFT JOIN LATERAL (
    SELECT * FROM marketplace_listings x WHERE x.product_id = p.id
    ORDER BY (x.status NOT IN ('closed', 'deleted')) DESC, x.id DESC LIMIT 1
  ) ml ON true`;

export async function listProducts(sql: Sql, filters: ProductFilters): Promise<ProductListResult> {
  const settings = await getCatalogSettings(sql);
  const params: unknown[] = [settings.defaultPriceTable, settings.defaultBranchId];
  const where: string[] = [];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  const q = filters.q?.trim();
  if (q) {
    const like = add(`%${escapeLike(q)}%`);
    const exact = add(q);
    const digits = /^\d+$/.test(q) ? `OR p.ads_product_id = ${add(Number(q) <= 2_147_483_647 ? Number(q) : -1)}::int` : "";
    where.push(`(p.name_original ILIKE ${like} OR p.name_custom ILIKE ${like} OR p.manufacturer_code ILIKE ${like}
      OR p.ean = ${exact}::text OR p.dun14 = ${exact}::text ${digits})`);
  }
  if (filters.supplierId !== undefined) where.push(`p.supplier_id = ${add(filters.supplierId)}::int`);
  if (filters.divisionId) where.push(`p.division_id = ${add(filters.divisionId)}::text`);
  if (filters.status === "active") where.push(`NOT p.inactive`);
  if (filters.status === "inactive") where.push(`p.inactive`);
  if (filters.stock === "positive") where.push(`stk.branches > 0 AND stk.total > 0`);
  if (filters.stock === "zero") where.push(`stk.branches > 0 AND stk.total <= 0`);
  if (filters.stock === "unknown") where.push(`stk.branches = 0`);
  if (filters.image === "with") where.push(`img.public_url IS NOT NULL`);
  if (filters.image === "without") where.push(`img.public_url IS NULL`);
  if (filters.draft === "none") where.push(`d.id IS NULL`);
  if (filters.draft === "any") where.push(`d.id IS NOT NULL`);
  if (filters.draft === "DRAFT" || filters.draft === "READY") where.push(`d.status = ${add(filters.draft)}::text`);
  if (filters.draft === "published") where.push(`ml.id IS NOT NULL AND ml.status NOT IN ('closed', 'deleted')`);
  if (filters.draft === "unpublished") where.push(`(ml.id IS NULL OR ml.status IN ('closed', 'deleted'))`);
  if (filters.price === "with") where.push(`rp.price IS NOT NULL`);
  if (filters.price === "without") where.push(`rp.price IS NULL`);

  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const order =
    filters.sort === "ads_id"
      ? "p.ads_product_id"
      : filters.sort === "updated"
        ? "p.updated_at DESC, p.id"
        : filters.sort === "stock"
          ? "stk.total DESC NULLS LAST, p.id"
          : "lower(COALESCE(p.name_custom, p.name_original)), p.id";

  const pageSize = Math.min(Math.max(filters.pageSize ?? 50, 1), 100);
  const page = Math.max(filters.page ?? 1, 1);

  const countRows = await sql.query<{ total: number }>(`SELECT count(*)::int AS total ${BASE_FROM} ${clause}`, params);
  const limit = add(pageSize);
  const offset = add((page - 1) * pageSize);
  const items = await sql.query<ProductListItem>(
    `SELECT p.id, p.ads_product_id AS "adsProductId", COALESCE(p.name_custom, p.name_original) AS name,
            p.name_original AS "nameOriginal", (p.name_custom IS NOT NULL) AS "hasCustomName",
            p.ean, p.manufacturer_code AS "manufacturerCode", p.supplier_id AS "supplierId",
            COALESCE(s.trade_name, s.name) AS "supplierName", p.inactive,
            img.public_url AS "primaryImageUrl", COALESCE(img.n, 0) AS "imageCount",
            rp.price::text AS "referencePrice", rp.branch_id AS "referenceBranch",
            stk.total::text AS "stockTotal", stk.branches AS "stockBranches", stk.fetched_at AS "stockFetchedAt",
            d.id AS "draftId", d.status AS "draftStatus",
            ml.marketplace_item_id AS "marketplaceItemId", ml.permalink, ml.status AS "listingStatus"
     ${BASE_FROM} ${clause}
     ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return { items, total: countRows[0]?.total ?? 0, page, pageSize, settings };
}

export interface CatalogKpis {
  total: number;
  active: number;
  stockPositive: number;
  stockZero: number;
  stockUnknown: number;
  withoutImage: number;
  withDraft: number;
  readyDrafts: number;
  lastProductImportAt: Date | null;
}

export async function getCatalogKpis(sql: Sql): Promise<CatalogKpis> {
  const [row] = await sql.query<CatalogKpis>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE NOT p.inactive)::int AS active,
            count(*) FILTER (WHERE stk.branches > 0 AND stk.total > 0)::int AS "stockPositive",
            count(*) FILTER (WHERE stk.branches > 0 AND stk.total <= 0)::int AS "stockZero",
            count(*) FILTER (WHERE stk.branches = 0)::int AS "stockUnknown",
            count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM product_images i WHERE i.product_id = p.id))::int AS "withoutImage",
            count(d.id)::int AS "withDraft",
            count(d.id) FILTER (WHERE d.status = 'READY')::int AS "readyDrafts",
            max(p.updated_at) AS "lastProductImportAt"
     FROM products p
     LEFT JOIN LATERAL (SELECT sum(quantity) AS total, count(*)::int AS branches FROM product_stocks WHERE product_id = p.id) stk ON true
     LEFT JOIN listing_drafts d ON d.product_id = p.id`,
  );
  return row;
}

export async function listFilterOptions(sql: Sql) {
  const suppliers = await sql.query<{ id: number; name: string | null }>(
    `SELECT DISTINCT p.supplier_id AS id, COALESCE(s.trade_name, s.name) AS name
     FROM products p LEFT JOIN ads_suppliers s ON s.id = p.supplier_id
     WHERE p.supplier_id IS NOT NULL ORDER BY 2 NULLS LAST, 1`,
  );
  const divisions = await sql.query<{ code: string; description: string | null }>(
    `SELECT DISTINCT p.division_id AS code, d.description
     FROM products p LEFT JOIN ads_divisions d ON d.code = p.division_id
     WHERE p.division_id IS NOT NULL ORDER BY 1`,
  );
  return { suppliers, divisions };
}

export interface ProductDetail {
  id: number;
  adsProductId: number;
  nameOriginal: string;
  nameCustom: string | null;
  manufacturerCode: string | null;
  ean: string | null;
  dun14: string | null;
  ncm: string | null;
  supplierId: number | null;
  supplierName: string | null;
  divisionId: string | null;
  divisionName: string | null;
  presentation: string | null;
  unit: string | null;
  packageQty: number | null;
  grossWeight: string | null;
  netWeight: string | null;
  width: string | null;
  height: string | null;
  length: string | null;
  inactive: boolean;
  b2b: boolean | null;
  erpImageRef: string | null;
  adsUpdatedAt: Date | null;
  importedAt: Date;
  updatedAt: Date;
  customUpdatedAt: Date | null;
  rawPayload: unknown;
}

export async function getProduct(sql: Sql, id: number): Promise<ProductDetail | null> {
  const rows = await sql.query<ProductDetail>(
    `SELECT p.id, p.ads_product_id AS "adsProductId", p.name_original AS "nameOriginal", p.name_custom AS "nameCustom",
            p.manufacturer_code AS "manufacturerCode", p.ean, p.dun14, p.ncm, p.supplier_id AS "supplierId",
            COALESCE(s.trade_name, s.name) AS "supplierName", p.division_id AS "divisionId", dv.description AS "divisionName",
            p.presentation, p.unit, p.package_qty AS "packageQty", p.gross_weight::text AS "grossWeight",
            p.net_weight::text AS "netWeight", p.width::text AS width, p.height::text AS height, p.length::text AS length,
            p.inactive, p.b2b, p.erp_image_ref AS "erpImageRef", p.ads_updated_at AS "adsUpdatedAt",
            p.imported_at AS "importedAt", p.updated_at AS "updatedAt", p.custom_updated_at AS "customUpdatedAt",
            p.raw_payload AS "rawPayload"
     FROM products p
     LEFT JOIN ads_suppliers s ON s.id = p.supplier_id
     LEFT JOIN ads_divisions dv ON dv.code = p.division_id
     WHERE p.id = $1::int`,
    [id],
  );
  return rows[0] ?? null;
}

export interface ProductPriceRow {
  branchId: string;
  priceTableCode: string;
  priceTableDescription: string | null;
  priceTableInactive: boolean | null;
  price: string | null;
  discount: string | null;
  commission: string | null;
  ceilingValue: string | null;
  pvs: string | null;
  minimumQuantity: string | null;
  inactive: boolean;
  promotion: boolean;
  adsUpdatedAt: Date | null;
  fetchedAt: Date;
}

export async function getProductPrices(sql: Sql, productId: number): Promise<ProductPriceRow[]> {
  return sql.query<ProductPriceRow>(
    `SELECT pp.branch_id AS "branchId", pp.price_table_code AS "priceTableCode", t.description AS "priceTableDescription",
            t.inactive AS "priceTableInactive", pp.price::text AS price, pp.discount::text AS discount,
            pp.commission::text AS commission, pp.ceiling_value::text AS "ceilingValue", pp.pvs::text AS pvs,
            pp.minimum_quantity::text AS "minimumQuantity", pp.inactive, pp.promotion,
            pp.ads_updated_at AS "adsUpdatedAt", pp.fetched_at AS "fetchedAt"
     FROM product_prices pp LEFT JOIN price_tables t ON t.code = pp.price_table_code
     WHERE pp.product_id = $1::int ORDER BY pp.price_table_code, pp.branch_id`,
    [productId],
  );
}

export interface ProductStockRow {
  branchId: string;
  quantity: string;
  lastSaleAt: Date | null;
  fetchedAt: Date;
}

export async function getProductStocks(sql: Sql, productId: number): Promise<ProductStockRow[]> {
  return sql.query<ProductStockRow>(
    `SELECT branch_id AS "branchId", quantity::text AS quantity, last_sale_at AS "lastSaleAt", fetched_at AS "fetchedAt"
     FROM product_stocks WHERE product_id = $1::int ORDER BY branch_id`,
    [productId],
  );
}

/** Situação do estoque: sem linhas = desconhecido (nunca zero). */
export function stockStatus(rows: { quantity: string }[]): StockFilter {
  if (!rows.length) return "unknown";
  const positive = rows.some((r) => Number(r.quantity) > 0);
  return positive ? "positive" : "zero";
}

/** Atualiza apenas campos editados manualmente (nunca sobrescritos pela importação). */
export async function updateProductCustom(sql: Sql, id: number, patch: { nameCustom?: string | null }): Promise<ProductDetail | null> {
  if (patch.nameCustom !== undefined) {
    const value = patch.nameCustom?.trim() || null;
    const n = await sql.execute(
      `UPDATE products SET name_custom = $2::text, custom_updated_at = now() WHERE id = $1::int`,
      [id, value],
    );
    if (!n) return null;
  }
  return getProduct(sql, id);
}

/** Preço ativo da tabela/filial indicadas (ou menor filial com preço ativo). */
export async function findActivePrice(sql: Sql, productId: number, table: string | null, branch: string | null) {
  if (!table) return null;
  const rows = await sql.query<{ price: string; branchId: string }>(
    `SELECT price::text AS price, branch_id AS "branchId" FROM product_prices
     WHERE product_id = $1::int AND price_table_code = $2::text AND NOT inactive AND price IS NOT NULL
       AND ($3::text IS NULL OR branch_id = $3::text)
     ORDER BY branch_id LIMIT 1`,
    [productId, table, branch],
  );
  return rows[0] ?? null;
}
