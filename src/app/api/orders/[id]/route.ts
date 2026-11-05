import { adminHandler, type RouteContext } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { getOrder } from "@/lib/marketplace/orders";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminHandler(
  async (_req, ctx: RouteContext<{ id: string }>) => {
    const { id } = await ctx.params;
    const order = await getOrder(getSql(), id);
    if (!order) return errorJson(404, "not_found", "Pedido não encontrado");
    return jsonNoStore(order);
  },
  { rateLimitPerMinute: 120 },
);
