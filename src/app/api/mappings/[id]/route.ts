import { adminHandler, type RouteContext } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { deactivateMapping } from "@/lib/marketplace/mappings";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Desativa um vínculo (pedidos já mapeados não mudam; vale para os próximos). */
export const DELETE = adminHandler(
  async (_req, ctx: RouteContext<{ id: string }>) => {
    const { id } = await ctx.params;
    if (!/^\d{1,18}$/.test(id)) return errorJson(400, "invalid_id", "ID inválido");
    if (!(await deactivateMapping(getSql(), id))) return errorJson(404, "not_found", "Vínculo não encontrado");
    return jsonNoStore({ ok: true });
  },
  { mutating: true, rateLimitPerMinute: 30 },
);
