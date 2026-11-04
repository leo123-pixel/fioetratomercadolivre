import "server-only";
import type { AdsClient, PagedResource } from "../ads/client";
import { mapPrices, mapProducts, mapStocks } from "../ads/schemas";
import type { Sql } from "../sql";
import { upsertPrices, upsertProducts, upsertStocks, type UpsertCounts } from "../imports/upserts";

export type RefreshScope = "product" | "prices" | "stock";

const MAX_PAGES = 20;

async function fetchAll(client: AdsClient, resource: PagedResource, adsProductId: number): Promise<unknown[]> {
  const items: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await client.getPage(resource, { page, ids: [adsProductId] });
    items.push(...res.items);
    if (!res.hasNext || !res.items.length) break;
  }
  return items;
}

export interface RefreshResult {
  product?: UpsertCounts;
  prices?: UpsertCounts & { received: number };
  stock?: UpsertCounts & { received: number };
  invalidItems: number;
}

/**
 * Consulta sob demanda de um único produto (poucas requisições, sem fila). Somente leitura na ADS.
 * Edições manuais (nome personalizado, imagens, rascunho) não são afetadas.
 */
export async function refreshProduct(sql: Sql, client: AdsClient, productId: number, scopes: RefreshScope[]): Promise<RefreshResult | null> {
  const [product] = await sql.query<{ adsProductId: number }>(`SELECT ads_product_id AS "adsProductId" FROM products WHERE id = $1::int`, [productId]);
  if (!product) return null;
  const id = product.adsProductId;
  const result: RefreshResult = { invalidItems: 0 };

  // Busca tudo primeiro (rede fora da transação) e grava de uma vez.
  const productItems = scopes.includes("product") ? await fetchAll(client, "produtos", id) : null;
  const priceItems = scopes.includes("prices") ? await fetchAll(client, "tabela-precos-itens", id) : null;
  const stockItems = scopes.includes("stock") ? await fetchAll(client, "estoques", id) : null;

  await sql.transaction(async (tx) => {
    if (productItems) {
      const m = mapProducts(productItems.filter((i) => (i as { produtoId?: unknown })?.produtoId === id));
      result.invalidItems += m.errors.length;
      result.product = await upsertProducts(tx, m.rows);
    }
    if (priceItems) {
      const m = mapPrices(priceItems);
      const rows = m.rows.filter((r) => r.ads_product_id === id);
      result.invalidItems += m.errors.length;
      result.prices = { ...(await upsertPrices(tx, rows)), received: rows.length };
    }
    if (stockItems) {
      const m = mapStocks(stockItems);
      const rows = m.rows.filter((r) => r.ads_product_id === id);
      result.invalidItems += m.errors.length;
      result.stock = { ...(await upsertStocks(tx, rows)), received: rows.length };
    }
  });
  return result;
}
