import "server-only";
import type { DivisionRow, PriceRow, PriceTableRow, ProductRow, StockRow, SupplierRow } from "../ads/schemas";
import type { Sql } from "../sql";

/**
 * UPSERTs em lote (INSERT ... ON CONFLICT) a partir de um único parâmetro JSON
 * (jsonb_to_recordset), o que mantém a consulta parametrizada e idempotente.
 *
 * created   = linhas novas (xmax = 0)
 * updated   = linhas existentes cujo JSON de origem mudou
 * unchanged = linhas existentes sem mudança (só o horário de consulta é atualizado, quando aplicável)
 *
 * Campos editados manualmente (name_custom, imagens, rascunhos) não aparecem nestes comandos.
 */
export interface UpsertCounts {
  created: number;
  updated: number;
  unchanged: number;
}

const ZERO: UpsertCounts = { created: 0, updated: 0, unchanged: 0 };

/** Remove duplicatas do mesmo lote (ON CONFLICT não aceita afetar a mesma linha duas vezes). Mantém a última. */
export function dedupeBy<T>(rows: T[], key: (row: T) => string): T[] {
  const map = new Map<string, T>();
  for (const row of rows) map.set(key(row), row);
  return [...map.values()];
}

function counts(result: { created: number; updated: number }[] | undefined, total: number): UpsertCounts {
  const created = Number(result?.[0]?.created ?? 0);
  const updated = Number(result?.[0]?.updated ?? 0);
  return { created, updated, unchanged: Math.max(0, total - created - updated) };
}

export async function upsertProducts(sql: Sql, input: ProductRow[]): Promise<UpsertCounts> {
  const rows = dedupeBy(input, (r) => String(r.ads_product_id));
  if (!rows.length) return ZERO;
  const result = await sql.query<{ created: number; updated: number }>(
    `WITH input AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(
         ads_product_id int, name_original text, manufacturer_code text, ean text, dun14 text, ncm text,
         supplier_id int, division_id text, presentation text, unit text, package_qty int,
         gross_weight numeric, net_weight numeric, width numeric, height numeric, length numeric,
         inactive boolean, b2b boolean, erp_image_ref text, ads_updated_at timestamptz, raw_payload jsonb)
     ), up AS (
       INSERT INTO products (ads_product_id, name_original, manufacturer_code, ean, dun14, ncm, supplier_id, division_id,
         presentation, unit, package_qty, gross_weight, net_weight, width, height, length, inactive, b2b, erp_image_ref,
         ads_updated_at, raw_payload, imported_at, updated_at)
       SELECT ads_product_id, name_original, manufacturer_code, ean, dun14, ncm, supplier_id, division_id,
         presentation, unit, package_qty, gross_weight, net_weight, width, height, length, inactive, b2b, erp_image_ref,
         ads_updated_at, raw_payload, now(), now()
       FROM input
       ON CONFLICT (ads_product_id) DO UPDATE SET
         name_original = EXCLUDED.name_original, manufacturer_code = EXCLUDED.manufacturer_code, ean = EXCLUDED.ean,
         dun14 = EXCLUDED.dun14, ncm = EXCLUDED.ncm, supplier_id = EXCLUDED.supplier_id, division_id = EXCLUDED.division_id,
         presentation = EXCLUDED.presentation, unit = EXCLUDED.unit, package_qty = EXCLUDED.package_qty,
         gross_weight = EXCLUDED.gross_weight, net_weight = EXCLUDED.net_weight, width = EXCLUDED.width,
         height = EXCLUDED.height, length = EXCLUDED.length, inactive = EXCLUDED.inactive, b2b = EXCLUDED.b2b,
         erp_image_ref = EXCLUDED.erp_image_ref, ads_updated_at = EXCLUDED.ads_updated_at,
         raw_payload = EXCLUDED.raw_payload, updated_at = now()
       WHERE products.raw_payload IS DISTINCT FROM EXCLUDED.raw_payload
       RETURNING (xmax = 0) AS inserted
     )
     SELECT count(*) FILTER (WHERE inserted)::int AS created, count(*) FILTER (WHERE NOT inserted)::int AS updated FROM up`,
    [JSON.stringify(rows)],
  );
  return counts(result, rows.length);
}

export async function upsertPriceTables(sql: Sql, input: PriceTableRow[]): Promise<UpsertCounts> {
  const rows = dedupeBy(input, (r) => r.code);
  if (!rows.length) return ZERO;
  const result = await sql.query<{ created: number; updated: number }>(
    `WITH input AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(
         code text, description text, base text, expense numeric, commission numeric, profit numeric, freight numeric,
         markup numeric, is_normal boolean, inactive boolean, ads_updated_at timestamptz, raw_payload jsonb)
     ), up AS (
       INSERT INTO price_tables (code, description, base, expense, commission, profit, freight, markup, is_normal, inactive,
         ads_updated_at, raw_payload, updated_at)
       SELECT code, description, base, expense, commission, profit, freight, markup, is_normal, inactive,
         ads_updated_at, raw_payload, now()
       FROM input
       ON CONFLICT (code) DO UPDATE SET
         description = EXCLUDED.description, base = EXCLUDED.base, expense = EXCLUDED.expense,
         commission = EXCLUDED.commission, profit = EXCLUDED.profit, freight = EXCLUDED.freight, markup = EXCLUDED.markup,
         is_normal = EXCLUDED.is_normal, inactive = EXCLUDED.inactive, ads_updated_at = EXCLUDED.ads_updated_at,
         raw_payload = EXCLUDED.raw_payload, updated_at = now()
       WHERE price_tables.raw_payload IS DISTINCT FROM EXCLUDED.raw_payload
       RETURNING (xmax = 0) AS inserted
     )
     SELECT count(*) FILTER (WHERE inserted)::int AS created, count(*) FILTER (WHERE NOT inserted)::int AS updated FROM up`,
    [JSON.stringify(rows)],
  );
  return counts(result, rows.length);
}

/** Separa linhas cujo produto ainda não foi importado (sem relacionamento possível). */
export async function splitByKnownProducts<T extends { ads_product_id: number }>(sql: Sql, rows: T[]): Promise<{ known: T[]; orphans: T[] }> {
  if (!rows.length) return { known: [], orphans: [] };
  const ids = [...new Set(rows.map((r) => r.ads_product_id))];
  const found = await sql.query<{ ads_product_id: number }>(
    `SELECT ads_product_id FROM products WHERE ads_product_id = ANY($1::int[])`,
    [ids],
  );
  const known = new Set(found.map((r) => Number(r.ads_product_id)));
  return { known: rows.filter((r) => known.has(r.ads_product_id)), orphans: rows.filter((r) => !known.has(r.ads_product_id)) };
}

/** Preços: chave lógica filial + produto + tabela. Linhas sem produto local devem ser filtradas antes. */
export async function upsertPrices(sql: Sql, input: PriceRow[]): Promise<UpsertCounts> {
  const rows = dedupeBy(input, (r) => `${r.ads_product_id}|${r.branch_id}|${r.price_table_code}`);
  if (!rows.length) return ZERO;
  const result = await sql.query<{ created: number; updated: number }>(
    `WITH input AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(
         ads_product_id int, branch_id text, price_table_code text, price numeric, discount numeric, commission numeric,
         ceiling_value numeric, pvs numeric, minimum_quantity numeric, inactive boolean, promotion boolean,
         ads_updated_at timestamptz, raw_payload jsonb)
     ), up AS (
       INSERT INTO product_prices (product_id, ads_product_id, branch_id, price_table_code, price, discount, commission,
         ceiling_value, pvs, minimum_quantity, inactive, promotion, ads_updated_at, raw_payload, fetched_at, updated_at)
       SELECT p.id, i.ads_product_id, i.branch_id, i.price_table_code, i.price, i.discount, i.commission,
         i.ceiling_value, i.pvs, i.minimum_quantity, i.inactive, i.promotion, i.ads_updated_at, i.raw_payload, now(), now()
       FROM input i JOIN products p ON p.ads_product_id = i.ads_product_id
       ON CONFLICT (ads_product_id, branch_id, price_table_code) DO UPDATE SET
         product_id = EXCLUDED.product_id, price = EXCLUDED.price, discount = EXCLUDED.discount,
         commission = EXCLUDED.commission, ceiling_value = EXCLUDED.ceiling_value, pvs = EXCLUDED.pvs,
         minimum_quantity = EXCLUDED.minimum_quantity, inactive = EXCLUDED.inactive, promotion = EXCLUDED.promotion,
         ads_updated_at = EXCLUDED.ads_updated_at, raw_payload = EXCLUDED.raw_payload, fetched_at = now(),
         updated_at = CASE WHEN product_prices.raw_payload IS DISTINCT FROM EXCLUDED.raw_payload THEN now() ELSE product_prices.updated_at END
       RETURNING (xmax = 0) AS inserted, (updated_at = now()) AS changed
     )
     SELECT count(*) FILTER (WHERE inserted)::int AS created,
            count(*) FILTER (WHERE NOT inserted AND changed)::int AS updated FROM up`,
    [JSON.stringify(rows)],
  );
  return counts(result, rows.length);
}

/** Estoque: chave filial + produto. fetched_at registra o momento da consulta pelo integrador. */
export async function upsertStocks(sql: Sql, input: StockRow[]): Promise<UpsertCounts> {
  const rows = dedupeBy(input, (r) => `${r.ads_product_id}|${r.branch_id}`);
  if (!rows.length) return ZERO;
  const result = await sql.query<{ created: number; updated: number }>(
    `WITH input AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(
         ads_product_id int, branch_id text, quantity numeric, last_sale_at timestamptz, raw_payload jsonb)
     ), prev AS (
       SELECT s.ads_product_id, s.branch_id, s.quantity, s.last_sale_at FROM product_stocks s
       JOIN input i ON i.ads_product_id = s.ads_product_id AND i.branch_id = s.branch_id
     ), up AS (
       INSERT INTO product_stocks (product_id, ads_product_id, branch_id, quantity, last_sale_at, raw_payload, fetched_at)
       SELECT p.id, i.ads_product_id, i.branch_id, i.quantity, i.last_sale_at, i.raw_payload, now()
       FROM input i JOIN products p ON p.ads_product_id = i.ads_product_id
       ON CONFLICT (ads_product_id, branch_id) DO UPDATE SET
         product_id = EXCLUDED.product_id, quantity = EXCLUDED.quantity, last_sale_at = EXCLUDED.last_sale_at,
         raw_payload = EXCLUDED.raw_payload, fetched_at = now()
       RETURNING (xmax = 0) AS inserted, ads_product_id, branch_id, quantity, last_sale_at
     )
     SELECT count(*) FILTER (WHERE up.inserted)::int AS created,
            count(*) FILTER (WHERE NOT up.inserted AND (prev.quantity IS DISTINCT FROM up.quantity
                                                       OR prev.last_sale_at IS DISTINCT FROM up.last_sale_at))::int AS updated
     FROM up LEFT JOIN prev ON prev.ads_product_id = up.ads_product_id AND prev.branch_id = up.branch_id`,
    [JSON.stringify(rows)],
  );
  return counts(result, rows.length);
}

export async function upsertSuppliers(sql: Sql, input: SupplierRow[]): Promise<UpsertCounts> {
  const rows = dedupeBy(input, (r) => String(r.id));
  if (!rows.length) return ZERO;
  const result = await sql.query<{ created: number; updated: number }>(
    `WITH input AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(id int, name text, trade_name text, inactive boolean)
     ), up AS (
       INSERT INTO ads_suppliers (id, name, trade_name, inactive, updated_at)
       SELECT id, name, trade_name, inactive, now() FROM input
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, trade_name = EXCLUDED.trade_name,
         inactive = EXCLUDED.inactive, updated_at = now()
       WHERE (ads_suppliers.name, ads_suppliers.trade_name, ads_suppliers.inactive)
             IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.trade_name, EXCLUDED.inactive)
       RETURNING (xmax = 0) AS inserted
     )
     SELECT count(*) FILTER (WHERE inserted)::int AS created, count(*) FILTER (WHERE NOT inserted)::int AS updated FROM up`,
    [JSON.stringify(rows)],
  );
  return counts(result, rows.length);
}

export async function upsertDivisions(sql: Sql, input: DivisionRow[]): Promise<UpsertCounts> {
  const rows = dedupeBy(input, (r) => r.code);
  if (!rows.length) return ZERO;
  const result = await sql.query<{ created: number; updated: number }>(
    `WITH input AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(code text, description text, inactive boolean)
     ), up AS (
       INSERT INTO ads_divisions (code, description, inactive, updated_at)
       SELECT code, description, inactive, now() FROM input
       ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description, inactive = EXCLUDED.inactive, updated_at = now()
       WHERE (ads_divisions.description, ads_divisions.inactive) IS DISTINCT FROM (EXCLUDED.description, EXCLUDED.inactive)
       RETURNING (xmax = 0) AS inserted
     )
     SELECT count(*) FILTER (WHERE inserted)::int AS created, count(*) FILTER (WHERE NOT inserted)::int AS updated FROM up`,
    [JSON.stringify(rows)],
  );
  return counts(result, rows.length);
}
