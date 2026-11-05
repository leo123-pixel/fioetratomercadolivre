import { adminHandler, type RouteContext } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { processEvents, reprocessEvent, TOPIC_LANES } from "@/lib/marketplace/events";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Reprocessamento autorizado de um evento (releitura do recurso na API; nada é escrito no ML). */
export const POST = adminHandler(
  async (_req, ctx: RouteContext<{ id: string }>) => {
    const { id } = await ctx.params;
    if (!/^\d{1,18}$/.test(id)) return errorJson(400, "invalid_id", "ID inválido");
    const sql = getSql();
    if (!(await reprocessEvent(sql, id))) return errorJson(409, "not_reprocessable", "Evento em andamento, inexistente ou de tópico não suportado");
    const [row] = await sql.query<{ topic: string }>(`SELECT topic FROM marketplace_webhook_events WHERE id = $1::bigint`, [id]);
    const lane = TOPIC_LANES[row?.topic ?? ""];
    const run = lane ? await processEvents({ sql, lanes: [lane], budgetMs: 40_000 }) : null;
    const [event] = await sql.query(
      `SELECT status, last_error AS "lastError", ignored_reason AS "ignoredReason", result FROM marketplace_webhook_events WHERE id = $1::bigint`,
      [id],
    );
    return jsonNoStore({ event, processed: run?.processed ?? 0 });
  },
  { mutating: true, rateLimitPerMinute: 20 },
);
