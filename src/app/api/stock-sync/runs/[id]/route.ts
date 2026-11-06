import { adminHandler, type RouteContext } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { getSql } from "@/lib/sql";
import { getRunProposals } from "@/lib/stock/reconcile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Propostas de uma simulação. */
export const GET = adminHandler(
  async (_req, ctx: RouteContext<{ id: string }>) => {
    const { id } = await ctx.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return errorJson(400, "invalid_id", "ID inválido");
    const sql = getSql();
    const [run] = await sql.query(
      `SELECT id::text AS id, mode, requested_by AS "requestedBy", status, summary, started_at AS "startedAt", finished_at AS "finishedAt" FROM stock_sync_runs WHERE id = $1::uuid`,
      [id],
    );
    if (!run) return errorJson(404, "not_found", "Simulação não encontrada");
    return jsonNoStore({ run, proposals: await getRunProposals(sql, id) });
  },
  { rateLimitPerMinute: 120 },
);
