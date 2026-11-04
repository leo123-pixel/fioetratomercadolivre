import { z } from "zod";
import { adminHandler, type RouteContext } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { getJob, listJobErrors, needsWorker } from "@/lib/imports/jobs";
import { scheduleWorker } from "@/lib/imports/scheduler";
import { getSql } from "@/lib/sql";
import { parseQuery } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const query = z.object({
  errorsLimit: z.coerce.number().int().min(1).max(500).default(100),
  errorsOffset: z.coerce.number().int().min(0).default(0),
});

export const GET = adminHandler(async (req, ctx: RouteContext<{ id: string }>) => {
  const q = parseQuery(req, query);
  if (!q.ok) return q.response;
  const { id } = await ctx.params;
  const sql = getSql();
  const job = await getJob(sql, id);
  if (!job) return errorJson(404, "not_found", "Importação não encontrada");
  const errors = await listJobErrors(sql, job.id, q.data.errorsLimit, q.data.errorsOffset);
  if ((job.status === "PENDING" || job.status === "RUNNING") && (await needsWorker(sql))) scheduleWorker();
  return jsonNoStore({ job, errors });
});
