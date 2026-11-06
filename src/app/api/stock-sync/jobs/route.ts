import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { jsonNoStore } from "@/lib/http";
import { getSql } from "@/lib/sql";
import { listJobs } from "@/lib/stock/reconcile";
import { parseQuery } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const query = z.object({
  id: z.string().uuid().optional(),
  status: z.enum(["QUEUED", "RUNNING", "SUCCEEDED", "DIVERGED", "FAILED", "STALE", "SKIPPED"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/** Jobs de atualização de estoque (com as chamadas feitas ao ML quando `id` é informado). */
export const GET = adminHandler(
  async (req) => {
    const q = parseQuery(req, query);
    if (!q.ok) return q.response;
    const sql = getSql();
    const jobs = await listJobs(sql, { ids: q.data.id ? [q.data.id] : undefined, status: q.data.status, limit: q.data.limit });
    const attempts = q.data.id
      ? await sql.query(
          `SELECT id::text AS id, operation, request, response, http_status AS "httpStatus", error_code AS "errorCode", error_message AS "errorMessage",
                  duration_ms AS "durationMs", created_at AS "createdAt" FROM stock_sync_attempts WHERE job_id = $1::uuid ORDER BY id`,
          [q.data.id],
        )
      : undefined;
    return jsonNoStore({ jobs, attempts });
  },
  { rateLimitPerMinute: 120 },
);
