import { adminHandler, type RouteContext } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { getEventErrors } from "@/lib/marketplace/events";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Detalhe de um evento com o histórico de tentativas com erro. */
export const GET = adminHandler(
  async (_req, ctx: RouteContext<{ id: string }>) => {
    const { id } = await ctx.params;
    if (!/^\d{1,18}$/.test(id)) return errorJson(400, "invalid_id", "ID inválido");
    const sql = getSql();
    const [event] = await sql.query<Record<string, unknown>>(
      `SELECT id::text AS id, event_id AS "eventId", source, topic, resource, actions, payload, status, attempts,
              max_attempts AS "maxAttempts", received_at AS "receivedAt", sent_at AS "sentAt", processed_at AS "processedAt",
              next_attempt_at AS "nextAttemptAt", duration_ms AS "durationMs", last_error_code AS "lastErrorCode", last_error AS "lastError",
              ignored_reason AS "ignoredReason", result, coalesced_into::text AS "coalescedInto", correlation_id::text AS "correlationId"
       FROM marketplace_webhook_events WHERE id = $1::bigint`,
      [id],
    );
    if (!event) return errorJson(404, "not_found", "Evento não encontrado");
    return jsonNoStore({ event, errors: await getEventErrors(sql, id) });
  },
  { rateLimitPerMinute: 120 },
);
