import { adminHandler, type RouteContext } from "@/lib/api";
import { getAdminSession } from "@/lib/auth/admin";
import { errorJson, jsonNoStore } from "@/lib/http";
import { PublishRejectedError, reopenForRepublish, requesterFromSession } from "@/lib/publish/service";
import { getSql } from "@/lib/sql";
import { parseId } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Reabre o rascunho para uma nova publicação quando o anúncio anterior foi encerrado ou excluído
 * no Mercado Livre (status relido na hora). Não publica nada: a nova publicação segue o fluxo
 * normal (validar, revisar, confirmar).
 */
export const POST = adminHandler(
  async (req, ctx: RouteContext<{ id: string }>) => {
    const id = await parseId(ctx.params);
    if (!id) return errorJson(400, "invalid_id", "ID inválido");
    try {
      const r = await reopenForRepublish(getSql(), id, requesterFromSession(getAdminSession(req)?.sid));
      return jsonNoStore(r);
    } catch (err) {
      if (err instanceof PublishRejectedError) return jsonNoStore({ error: err.code, message: err.message }, err.status);
      throw err;
    }
  },
  { mutating: true, rateLimitPerMinute: 10 },
);
