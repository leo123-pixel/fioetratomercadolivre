import "server-only";
import type { Sql } from "../sql";
import { CatalogItemError, mapProduct, mapVariant, upsertProduct, type MappedVariant } from "./catalog";
import { NuvemshopApiError, type NsProduct, type NsVariant, type NuvemshopApiClient } from "./client";
import { refreshMappingSuggestions } from "./mapping";

/**
 * Estado remoto atual de produtos/variantes (somente GET), gravado no catálogo local.
 *
 * Usado antes de cada decisão e de cada escrita (para não escrever com dado velho) e depois de cada escrita
 * (para confirmar o resultado pela leitura, não pelo código HTTP). GET /products aceita até 150 ids.
 */
export interface RemoteVariantState {
  storeId: string;
  productId: string;
  variantId: string;
  price: string | null;
  promotionalPrice: string | null;
  stockManagement: boolean | null;
  stock: number | null;
  levels: { locationId: string; stock: number | null }[] | null;
  sku: string | null;
  updatedAt: string | null;
  removed: boolean;
  readAt: Date;
}

const IDS_PER_CALL = 150;

export interface RefreshResult {
  variants: Map<string, RemoteVariantState>;
  /** Produtos que não existem mais na loja (404). */
  removedProducts: string[];
  failed: { productId: string; message: string }[];
}

async function fetchVariants(client: NuvemshopApiClient, productId: string): Promise<NsVariant[]> {
  const out: NsVariant[] = [];
  for (let page = 1; page <= 10; page++) {
    const r = await client.getPage<NsVariant>(`/products/${productId}/variants`, page, 200);
    out.push(...r.items);
    if (!r.hasNext) break;
  }
  return out;
}

/** Relê produtos da loja e atualiza o catálogo local. Não muda o last_seen_job_id (não interfere numa importação em curso). */
export async function refreshProducts(sql: Sql, client: NuvemshopApiClient, storeId: string, productIds: string[], now = new Date()): Promise<RefreshResult> {
  const ids = [...new Set(productIds.filter((p) => /^\d{1,20}$/.test(p)))];
  const result: RefreshResult = { variants: new Map(), removedProducts: [], failed: [] };
  for (let i = 0; i < ids.length; i += IDS_PER_CALL) {
    const chunk = ids.slice(i, i + IDS_PER_CALL);
    const { data } = await client.get<NsProduct[]>("/products", { ids: chunk.join(","), per_page: 200 });
    if (!Array.isArray(data)) throw new NuvemshopApiError("invalid_response", "Lista de produtos esperada");
    const returned = new Map(data.map((p) => [String(p.id), p]));
    for (const id of chunk) {
      let raw = returned.get(id);
      if (!raw) {
        // Ausente na lista: confirma pelo recurso individual antes de considerar removido.
        try {
          raw = (await client.get<NsProduct>(`/products/${id}`)).data;
        } catch (err) {
          if (err instanceof NuvemshopApiError && err.kind === "not_found") {
            await markProductRemoved(sql, storeId, id, now);
            result.removedProducts.push(id);
            continue;
          }
          throw err;
        }
      }
      try {
        const p = mapProduct(raw);
        const rawVariants = p.variants && p.variants.length ? p.variants : await fetchVariants(client, p.productId);
        const variants: MappedVariant[] = rawVariants.map((v) => mapVariant(v, Number(p.productId)));
        const removed = await sql.transaction(async (tx) => {
          const [prev] = await tx.query<{ jobId: string | null }>(`SELECT last_seen_job_id::text AS "jobId" FROM nuvemshop_products WHERE store_id = $1 AND product_id = $2::bigint`, [storeId, p.productId]);
          const r = await upsertProduct(tx, storeId, prev?.jobId ?? null, p, variants, now);
          if (r.removedVariants.length) await refreshMappingSuggestions(tx, storeId, "system:nuvemshop-refresh", r.removedVariants);
          return r.removedVariants;
        });
        for (const v of variants) {
          result.variants.set(v.variantId, {
            storeId,
            productId: p.productId,
            variantId: v.variantId,
            price: v.price,
            promotionalPrice: v.promotionalPrice,
            stockManagement: v.stockManagement,
            stock: v.stock,
            levels: v.inventoryLevels,
            sku: v.sku,
            updatedAt: v.updatedAt,
            removed: false,
            readAt: now,
          });
        }
        for (const id of removed) result.variants.set(id, { storeId, productId: p.productId, variantId: id, price: null, promotionalPrice: null, stockManagement: null, stock: null, levels: null, sku: null, updatedAt: null, removed: true, readAt: now });
      } catch (err) {
        if (err instanceof CatalogItemError) result.failed.push({ productId: id, message: err.message });
        else throw err;
      }
    }
  }
  return result;
}

export async function markProductRemoved(sql: Sql, storeId: string, productId: string, now = new Date()): Promise<string[]> {
  return sql.transaction(async (tx) => {
    await tx.execute(`UPDATE nuvemshop_products SET sync_status = 'REMOVED', removed_at = COALESCE(removed_at, $3::timestamptz), updated_at = now() WHERE store_id = $1 AND product_id = $2::bigint`, [storeId, productId, now.toISOString()]);
    const rows = await tx.query<{ variantId: string }>(
      `UPDATE nuvemshop_variants SET sync_status = 'REMOVED', removed_at = COALESCE(removed_at, $3::timestamptz), updated_at = now()
       WHERE store_id = $1 AND product_id = $2::bigint AND sync_status = 'ACTIVE' RETURNING variant_id::text AS "variantId"`,
      [storeId, productId, now.toISOString()],
    );
    if (rows.length) await refreshMappingSuggestions(tx, storeId, "system:nuvemshop-refresh", rows.map((r) => r.variantId));
    return rows.map((r) => r.variantId);
  });
}

/** Valor de estoque numa localização (ou o total, para loja sem várias localizações). null = desconhecido. */
export function stockAt(v: Pick<RemoteVariantState, "stockManagement" | "stock" | "levels">, locationId: string | null): number | null {
  if (v.stockManagement !== true) return null;
  if (v.levels && v.levels.length) {
    if (!locationId) return v.levels.length === 1 ? v.levels[0].stock : null;
    const l = v.levels.find((x) => x.locationId === locationId);
    return l ? l.stock : null;
  }
  return v.stock;
}

/** Centavos de um decimal em texto ("19.90" → 1990). */
export function cents(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export const fromCents = (c: number): string => (c / 100).toFixed(2);
