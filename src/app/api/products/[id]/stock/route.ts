import { adminHandler, type RouteContext } from "@/lib/api";
import { getProductStocks, stockStatus } from "@/lib/catalog/products";
import { errorJson, jsonNoStore } from "@/lib/http";
import { getSql } from "@/lib/sql";
import { parseId } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Estoque por filial. Lista vazia = estoque desconhecido (não zero). */
export const GET = adminHandler(async (_req, ctx: RouteContext<{ id: string }>) => {
  const id = await parseId(ctx.params);
  if (!id) return errorJson(400, "invalid_id", "ID inválido");
  const sql = getSql();
  const [{ exists }] = await sql.query<{ exists: boolean }>(`SELECT EXISTS (SELECT 1 FROM products WHERE id = $1::int) AS exists`, [id]);
  if (!exists) return errorJson(404, "not_found", "Produto não encontrado");
  const stocks = await getProductStocks(sql, id);
  return jsonNoStore({ stocks, status: stockStatus(stocks) });
});
