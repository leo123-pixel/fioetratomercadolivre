import { adminHandler, type RouteContext } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { validateDraft } from "@/lib/publish/validate";
import { getSql } from "@/lib/sql";
import { parseId } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Validação completa (regras internas + categoria + atributos + imagens + POST /items/validate). Não publica. */
export const POST = adminHandler(
  async (_req, ctx: RouteContext<{ id: string }>) => {
    const id = await parseId(ctx.params);
    if (!id) return errorJson(400, "invalid_id", "ID inválido");
    const result = await validateDraft(getSql(), id);
    if (!result) return errorJson(404, "not_found", "Rascunho não encontrado");
    return jsonNoStore({ validation: result });
  },
  { mutating: true, rateLimitPerMinute: 30 },
);
