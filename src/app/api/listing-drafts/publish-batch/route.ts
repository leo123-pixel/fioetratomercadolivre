import { adminHandler } from "@/lib/api";
import { getAdminSession } from "@/lib/auth/admin";
import { publishBatchSchema } from "@/lib/catalog/draft-schemas";
import { jsonNoStore } from "@/lib/http";
import { scheduleWorker } from "@/lib/imports/scheduler";
import { requestBatch, requesterFromSession } from "@/lib/publish/service";
import { getSql } from "@/lib/sql";
import { parseJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Publicação manual em lote: cada item precisa da versão e da impressão digital validadas.
 * Os jobs vão para a fila persistente (processados um a um, com espaçamento); cada um tem resultado próprio.
 */
export const POST = adminHandler(
  async (req) => {
    const body = await parseJsonBody(req, publishBatchSchema);
    if (!body.ok) return body.response;
    const result = await requestBatch(getSql(), body.data.items, requesterFromSession(getAdminSession(req)?.sid));
    if (result.results.some((r) => r.ok)) scheduleWorker();
    return jsonNoStore(result, 202);
  },
  { mutating: true, rateLimitPerMinute: 10 },
);
