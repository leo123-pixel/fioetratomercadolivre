import { adminHandler, type RouteContext } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { listRunProposals } from "@/lib/inventory/queries";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET = adminHandler<RouteContext<{ id: string }>>(async (_req, ctx) => {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return errorJson(400, "invalid_id", "Identificador inválido");
  const sql = getSql();
  const [run] = await sql.query(
    `SELECT id::text AS id, source, status, requested_by AS "requestedBy", started_at AS "startedAt", finished_at AS "finishedAt", summary, error_message AS "errorMessage"
     FROM inventory_reconciliation_runs WHERE id = $1::uuid`,
    [id],
  );
  if (!run) return errorJson(404, "not_found", "Execução não encontrada");
  return jsonNoStore({ run, proposals: await listRunProposals(sql, id) });
});
