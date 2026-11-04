import { adminHandler, type RouteContext } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { listEvents } from "@/lib/publish/events";
import { listPublicationJobs } from "@/lib/publish/service";
import { getSql } from "@/lib/sql";
import { parseId } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Trilha de auditoria do rascunho: eventos e jobs de publicação. */
export const GET = adminHandler(async (_req, ctx: RouteContext<{ id: string }>) => {
  const id = await parseId(ctx.params);
  if (!id) return errorJson(400, "invalid_id", "ID inválido");
  const sql = getSql();
  const [events, jobs] = await Promise.all([listEvents(sql, id), listPublicationJobs(sql, { draftId: id, limit: 20 })]);
  return jsonNoStore({ events, jobs: jobs.items });
});
