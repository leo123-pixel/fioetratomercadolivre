import { adminHandler, type RouteContext } from "@/lib/api";
import { getAdminSession } from "@/lib/auth/admin";
import { publishSchema } from "@/lib/catalog/draft-schemas";
import { errorJson, jsonNoStore } from "@/lib/http";
import { scheduleWorker } from "@/lib/imports/scheduler";
import { PublishRejectedError, requesterFromSession, requestPublication } from "@/lib/publish/service";
import { getSql } from "@/lib/sql";
import { parseId, parseJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Comando explícito de publicação. Exige { confirm: true, draftVersion, fingerprint } vindos da janela
 * de revisão. Registra o job (idempotente) e responde 202; o envio ao Mercado Livre ocorre no worker.
 */
export const POST = adminHandler(
  async (req, ctx: RouteContext<{ id: string }>) => {
    const id = await parseId(ctx.params);
    if (!id) return errorJson(400, "invalid_id", "ID inválido");
    const body = await parseJsonBody(req, publishSchema);
    if (!body.ok) return body.response;
    try {
      const { job, replayed } = await requestPublication(getSql(), {
        draftId: id,
        draftVersion: body.data.draftVersion,
        fingerprint: body.data.fingerprint,
        requestedBy: requesterFromSession(getAdminSession(req)?.sid),
      });
      scheduleWorker();
      return jsonNoStore({ job, replayed }, replayed ? 200 : 202);
    } catch (err) {
      if (err instanceof PublishRejectedError) return jsonNoStore({ error: err.code, message: err.message }, err.status);
      throw err;
    }
  },
  { mutating: true, rateLimitPerMinute: 30 },
);
