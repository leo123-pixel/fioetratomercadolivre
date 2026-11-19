import { adminHandler, type RouteContext } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { jobDetail } from "@/lib/nuvemshop/automation-queries";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/nuvemshop/automation/jobs/:id — tentativas de uma escrita (antes/depois, HTTP, verificação). */
export const GET = adminHandler<RouteContext<{ id: string }>>(async (_req, ctx) => {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return errorJson(422, "invalid_id", "ID inválido");
  return jsonNoStore(await jobDetail(getSql(), id));
});
