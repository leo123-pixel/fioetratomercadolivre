import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { jsonNoStore } from "@/lib/http";
import { getSql } from "@/lib/sql";
import { parseQuery } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const query = z.object({
  itemId: z.string().regex(/^MLB\d{1,15}$/).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/** Trilha de auditoria: vínculos, sugestões recusadas, autorizações, resultados, políticas e configurações. */
export const GET = adminHandler(
  async (req) => {
    const q = parseQuery(req, query);
    if (!q.ok) return q.response;
    const sql = getSql();
    const [history, runs] = await Promise.all([
      sql.query(
        `SELECT id::text AS id, event_type AS "eventType", actor, marketplace_item_id AS "itemId", variation_id AS "variationId", product_id AS "productId",
                mapping_id::text AS "mappingId", job_id::text AS "jobId", details, created_at AS "createdAt"
         FROM stock_sync_history WHERE ($1::text IS NULL OR marketplace_item_id = $1::text OR details->>'poolKey' LIKE '%' || $1::text || '%')
         ORDER BY id DESC LIMIT $2::int`,
        [q.data.itemId ?? null, q.data.limit ?? 100],
      ),
      sql.query(
        `SELECT id::text AS id, mode, requested_by AS "requestedBy", status, summary, error_message AS "errorMessage", started_at AS "startedAt", finished_at AS "finishedAt"
         FROM stock_sync_runs ORDER BY started_at DESC LIMIT 30`,
      ),
    ]);
    return jsonNoStore({ history, runs });
  },
  { rateLimitPerMinute: 120 },
);
