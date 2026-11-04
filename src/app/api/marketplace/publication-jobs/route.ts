import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { jsonNoStore } from "@/lib/http";
import { scheduleWorker } from "@/lib/imports/scheduler";
import { cancelBatch, listPublicationJobs, PUBLICATION_JOB_STATUSES } from "@/lib/publish/service";
import { needsPublishWorker } from "@/lib/publish/worker";
import { getSql } from "@/lib/sql";
import { parseJsonBody, parseQuery } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const query = z.object({
  status: z.enum(PUBLICATION_JOB_STATUSES).optional(),
  batchId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Jobs de publicação. Também retoma o worker se houver fila parada (ex.: após timeout). */
export const GET = adminHandler(async (req) => {
  const q = parseQuery(req, query);
  if (!q.ok) return q.response;
  const sql = getSql();
  const result = await listPublicationJobs(sql, q.data);
  if (await needsPublishWorker(sql)) scheduleWorker();
  return jsonNoStore(result);
});

const cancelBody = z.object({ cancelBatch: z.string().uuid() }).strict();

/** Cancela os jobs ainda não iniciados de um lote. */
export const POST = adminHandler(
  async (req) => {
    const b = await parseJsonBody(req, cancelBody);
    if (!b.ok) return b.response;
    return jsonNoStore({ canceled: await cancelBatch(getSql(), b.data.cancelBatch) });
  },
  { mutating: true },
);
