import "server-only";
import { z } from "zod";
import { adminHandler } from "../api";
import { errorJson, jsonNoStore } from "../http";
import { getSql } from "../sql";
import { adsProductIdsSchema, parseJsonBody } from "../validation";
import { createJob, JobConflictError, type JobType } from "./jobs";
import { scheduleWorker } from "./scheduler";

const bodySchema = z.object({ adsProductIds: adsProductIdsSchema.optional() }).strict();

/** POST /api/import/{products|prices|stocks|price-tables}: cria a tarefa e agenda o worker (não bloqueia). */
export function importRoute(type: JobType) {
  return adminHandler(
    async (req) => {
      const body = await parseJsonBody(req, bodySchema);
      if (!body.ok) return body.response;
      if (type === "PRICE_TABLES" && body.data.adsProductIds) {
        return errorJson(400, "validation_error", "Tabelas comerciais não aceitam filtro por produto");
      }
      const sql = getSql();
      if (type === "PRICES" || type === "STOCKS") {
        const [{ n }] = await sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM products`);
        if (n === 0) return errorJson(409, "catalog_empty", "Importe os produtos antes de preços ou estoque");
      }
      try {
        const params = body.data.adsProductIds ? { adsProductIds: [...new Set(body.data.adsProductIds)] } : {};
        const job = await createJob(sql, type, params);
        scheduleWorker();
        return jsonNoStore({ job }, 202);
      } catch (err) {
        if (err instanceof JobConflictError) {
          return jsonNoStore({ error: "import_in_progress", message: err.message, activeJobId: err.activeJobId }, 409);
        }
        throw err;
      }
    },
    { mutating: true },
  );
}
