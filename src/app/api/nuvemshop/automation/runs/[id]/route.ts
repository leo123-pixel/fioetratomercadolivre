import { adminHandler, type RouteContext } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { runDetail } from "@/lib/nuvemshop/automation-queries";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/nuvemshop/automation/runs/:id — execução e decisão por variante. */
export const GET = adminHandler<RouteContext<{ id: string }>>(async (_req, ctx) => {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return errorJson(422, "invalid_id", "ID inválido");
  const r = await runDetail(getSql(), id);
  return r ? jsonNoStore(r) : errorJson(404, "not_found", "Execução não encontrada");
});
