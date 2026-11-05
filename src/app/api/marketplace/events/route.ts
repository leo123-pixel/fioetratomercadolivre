import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { jsonNoStore } from "@/lib/http";
import { listEvents, processEvents, reprocessFailed } from "@/lib/marketplace/events";
import { getSql } from "@/lib/sql";
import { parseJsonBody, parseQuery } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const query = z.object({
  status: z.enum(["PENDING", "PROCESSING", "COMPLETED", "FAILED", "RETRYING", "IGNORED"]).optional(),
  topic: z.string().regex(/^[a-z0-9_-]{1,60}$/i).optional(),
  q: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** Histórico de notificações recebidas. */
export const GET = adminHandler(
  async (req) => {
    const q = parseQuery(req, query);
    if (!q.ok) return q.response;
    return jsonNoStore(await listEvents(getSql(), q.data));
  },
  { rateLimitPerMinute: 120 },
);

const body = z.object({ action: z.literal("reprocess-failed"), confirm: z.literal(true) });

/** Recoloca na fila todos os eventos em FAILED e processa uma fatia. Somente leituras no ML. */
export const POST = adminHandler(
  async (req) => {
    const b = await parseJsonBody(req, body);
    if (!b.ok) return b.response;
    const sql = getSql();
    const requeued = await reprocessFailed(sql);
    const run = await processEvents({ sql, budgetMs: 40_000 });
    return jsonNoStore({ requeued, processed: run.processed, byStatus: run.byStatus });
  },
  { mutating: true, rateLimitPerMinute: 6 },
);
