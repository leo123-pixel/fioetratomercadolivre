import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { jsonNoStore } from "@/lib/http";
import { JOB_TYPES, listJobs, needsWorker } from "@/lib/imports/jobs";
import { scheduleWorker } from "@/lib/imports/scheduler";
import { getSql } from "@/lib/sql";
import { parseQuery } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const query = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  type: z.enum(JOB_TYPES).optional(),
  status: z.enum(["PENDING", "RUNNING", "COMPLETED", "PARTIALLY_COMPLETED", "FAILED", "CANCELED"]).optional(),
});

/** Histórico de importações. Também retoma o worker se uma tarefa ativa ficou sem processamento. */
export const GET = adminHandler(async (req) => {
  const q = parseQuery(req, query);
  if (!q.ok) return q.response;
  const sql = getSql();
  const result = await listJobs(sql, q.data);
  if (await needsWorker(sql)) scheduleWorker();
  return jsonNoStore(result);
});
