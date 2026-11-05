import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { jsonNoStore } from "@/lib/http";
import { processEvents } from "@/lib/marketplace/events";
import { runSyncJob } from "@/lib/marketplace/scheduler";
import { getSql } from "@/lib/sql";
import { parseJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Últimas execuções das rotinas periódicas. */
export const GET = adminHandler(
  async () => {
    const items = await getSql().query(
      `SELECT id::text AS id, type, trigger, status, started_at AS "startedAt", finished_at AS "finishedAt", total_processed AS processed,
              total_changed AS changed, total_failed AS failed, details, error_message AS error
       FROM marketplace_sync_jobs ORDER BY started_at DESC LIMIT 50`,
    );
    return jsonNoStore({ items });
  },
  { rateLimitPerMinute: 60 },
);

const body = z.object({ type: z.enum(["LISTINGS_RECONCILE", "MISSED_FEEDS", "ORDERS_RECOVERY"]) });

/** Executa agora uma rotina de LEITURA (reconciliação, missed_feeds ou varredura de pedidos). */
export const POST = adminHandler(
  async (req) => {
    const b = await parseJsonBody(req, body);
    if (!b.ok) return b.response;
    const sql = getSql();
    const job = await runSyncJob(sql, b.data.type, "manual");
    if (job.status !== "BUSY" && b.data.type !== "LISTINGS_RECONCILE" && job.changed > 0) await processEvents({ sql, budgetMs: 30_000 });
    return jsonNoStore({ job }, job.status === "BUSY" ? 409 : 200);
  },
  { mutating: true, rateLimitPerMinute: 6 },
);
