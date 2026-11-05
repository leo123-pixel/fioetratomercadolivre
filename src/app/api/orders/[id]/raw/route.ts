import { adminHandler, type RouteContext } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { logger } from "@/lib/logger";
import { getOrderRaw } from "@/lib/marketplace/orders";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * JSON original do pedido (contém dados pessoais do comprador): acesso restrito ao administrador,
 * limite baixo de requisições, sem cache e com registro do acesso (sem o conteúdo).
 */
export const GET = adminHandler(
  async (_req, ctx: RouteContext<{ id: string }>) => {
    const { id } = await ctx.params;
    const raw = await getOrderRaw(getSql(), id);
    if (raw === null) return errorJson(404, "not_found", "JSON original indisponível (inexistente ou expirado pela retenção)");
    logger.info("Acesso ao JSON original de pedido", { orderInboxId: id });
    const res = jsonNoStore({ raw });
    res.headers.set("X-Robots-Tag", "noindex");
    return res;
  },
  { rateLimitPerMinute: 10 },
);
