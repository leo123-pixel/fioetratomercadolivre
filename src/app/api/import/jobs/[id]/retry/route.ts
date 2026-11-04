import { adminHandler, type RouteContext } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { getJob, JobConflictError, retryJob } from "@/lib/imports/jobs";
import { scheduleWorker } from "@/lib/imports/scheduler";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Retoma do cursor salvo (tarefa interrompida) ou reprocessa com os mesmos parâmetros. */
export const POST = adminHandler(
  async (_req, ctx: RouteContext<{ id: string }>) => {
    const { id } = await ctx.params;
    const sql = getSql();
    if (!(await getJob(sql, id))) return errorJson(404, "not_found", "Importação não encontrada");
    try {
      const { job, resumed } = await retryJob(sql, id);
      scheduleWorker();
      return jsonNoStore({ job, resumed }, 202);
    } catch (err) {
      if (err instanceof JobConflictError) {
        return jsonNoStore({ error: "import_in_progress", message: err.message, activeJobId: err.activeJobId }, 409);
      }
      throw err;
    }
  },
  { mutating: true },
);
