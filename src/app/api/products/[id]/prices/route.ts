import { adminHandler, type RouteContext } from "@/lib/api";
import { getProductPrices } from "@/lib/catalog/products";
import { getCatalogSettings } from "@/lib/catalog/settings";
import { errorJson, jsonNoStore } from "@/lib/http";
import { getSql } from "@/lib/sql";
import { parseId } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Preços do produto em todas as tabelas/filiais (valores comerciais originais da ADS). */
export const GET = adminHandler(async (_req, ctx: RouteContext<{ id: string }>) => {
  const id = await parseId(ctx.params);
  if (!id) return errorJson(400, "invalid_id", "ID inválido");
  const sql = getSql();
  const [{ exists }] = await sql.query<{ exists: boolean }>(`SELECT EXISTS (SELECT 1 FROM products WHERE id = $1::int) AS exists`, [id]);
  if (!exists) return errorJson(404, "not_found", "Produto não encontrado");
  return jsonNoStore({ prices: await getProductPrices(sql, id), settings: await getCatalogSettings(sql) });
});
