import { adminHandler, type RouteContext } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { processOrder } from "@/lib/marketplace/orders";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Relê o pedido no Mercado Livre (somente leitura) e atualiza o registro local. Não envia nada à ADS. */
export const POST = adminHandler(
  async (_req, ctx: RouteContext<{ id: string }>) => {
    const { id } = await ctx.params;
    if (!/^\d{1,18}$/.test(id)) return errorJson(400, "invalid_id", "ID inválido");
    const sql = getSql();
    const [row] = await sql.query<{ orderId: string }>(`SELECT marketplace_order_id AS "orderId" FROM marketplace_order_inbox WHERE id = $1::bigint`, [id]);
    if (!row) return errorJson(404, "not_found", "Pedido não encontrado");
    const result = await processOrder(sql, row.orderId);
    if (!result) return errorJson(404, "not_found_remote", "Pedido não encontrado no Mercado Livre");
    return jsonNoStore({ result });
  },
  { mutating: true, rateLimitPerMinute: 20 },
);
