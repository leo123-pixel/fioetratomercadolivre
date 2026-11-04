import { adminHandler, type RouteContext } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { getPublicationJob, listAttempts } from "@/lib/publish/service";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Tentativas registradas (requisição e resposta sanitizadas, status HTTP, erro). */
export const GET = adminHandler(async (_req, ctx: RouteContext<{ id: string }>) => {
  const { id } = await ctx.params;
  const sql = getSql();
  if (!(await getPublicationJob(sql, id))) return errorJson(404, "not_found", "Job não encontrado");
  return jsonNoStore({ attempts: await listAttempts(sql, id) });
});
