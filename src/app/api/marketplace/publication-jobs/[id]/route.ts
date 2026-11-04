import { adminHandler, type RouteContext } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { getPublicationJob } from "@/lib/publish/service";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminHandler(async (_req, ctx: RouteContext<{ id: string }>) => {
  const { id } = await ctx.params;
  const job = await getPublicationJob(getSql(), id);
  if (!job) return errorJson(404, "not_found", "Job não encontrado");
  return jsonNoStore({ job });
});
