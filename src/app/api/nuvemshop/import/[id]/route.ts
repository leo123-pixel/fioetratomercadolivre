import { adminHandler, type RouteContext } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { getImportJob, importAttempts } from "@/lib/nuvemshop/import";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/nuvemshop/import/:id — progresso e tentativas da importação. */
export const GET = adminHandler<RouteContext<{ id: string }>>(async (_req, ctx) => {
  const { id } = await ctx.params;
  const sql = getSql();
  const job = await getImportJob(sql, id);
  if (!job) return errorJson(404, "not_found", "Importação não encontrada");
  return jsonNoStore({ job, attempts: await importAttempts(sql, id, 100) });
});
