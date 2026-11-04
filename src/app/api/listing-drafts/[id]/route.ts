import { adminHandler, type RouteContext } from "@/lib/api";
import { draftPatchSchema } from "@/lib/catalog/draft-schemas";
import { checkReadiness, DraftNotReadyError, getDraft, updateDraft } from "@/lib/catalog/drafts";
import { errorJson, jsonNoStore } from "@/lib/http";
import { getSql } from "@/lib/sql";
import { parseId, parseJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = RouteContext<{ id: string }>;

export const GET = adminHandler(async (_req, ctx: Ctx) => {
  const id = await parseId(ctx.params);
  if (!id) return errorJson(400, "invalid_id", "ID inválido");
  const draft = await getDraft(getSql(), id);
  if (!draft) return errorJson(404, "not_found", "Rascunho não encontrado");
  return jsonNoStore({ draft, readiness: checkReadiness(draft) });
});

/** Salva o rascunho. status=READY só é aceito se os requisitos mínimos forem atendidos (422 caso contrário). */
export const PATCH = adminHandler(
  async (req, ctx: Ctx) => {
    const id = await parseId(ctx.params);
    if (!id) return errorJson(400, "invalid_id", "ID inválido");
    const body = await parseJsonBody(req, draftPatchSchema);
    if (!body.ok) return body.response;
    try {
      const draft = await updateDraft(getSql(), id, body.data);
      if (!draft) return errorJson(404, "not_found", "Rascunho não encontrado");
      return jsonNoStore({ draft, readiness: checkReadiness(draft) });
    } catch (err) {
      if (err instanceof DraftNotReadyError) {
        return jsonNoStore({ error: "not_ready", message: err.message, readiness: err.readiness }, 422);
      }
      throw err;
    }
  },
  { mutating: true },
);
