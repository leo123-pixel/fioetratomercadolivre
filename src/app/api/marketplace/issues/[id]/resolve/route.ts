import { adminHandler, type RouteContext } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Marca uma divergência como ciente (somente local; reabre se a próxima leitura confirmar o problema). */
export const POST = adminHandler(
  async (_req, ctx: RouteContext<{ id: string }>) => {
    const { id } = await ctx.params;
    if (!/^\d{1,18}$/.test(id)) return errorJson(400, "invalid_id", "ID inválido");
    const n = await getSql().execute(
      `UPDATE marketplace_reconciliation_issues SET resolved_at = now(), resolution = 'acknowledged' WHERE id = $1::bigint AND resolved_at IS NULL`,
      [id],
    );
    if (!n) return errorJson(404, "not_found", "Divergência não encontrada ou já resolvida");
    return jsonNoStore({ ok: true });
  },
  { mutating: true, rateLimitPerMinute: 60 },
);
