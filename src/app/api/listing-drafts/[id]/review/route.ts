import { adminHandler, type RouteContext } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { getCapabilities } from "@/lib/meli/capabilities";
import { fingerprint, loadContext, reviewSummary } from "@/lib/publish/payload";
import { getSql } from "@/lib/sql";
import { parseId } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Dados para a janela de confirmação: o que exatamente será enviado, para qual conta, com a versão e a
 * impressão digital que o comando de publicação precisa repetir. Se o conteúdo mudou desde a validação,
 * `publishable` é false e é preciso validar de novo.
 */
export const GET = adminHandler(async (_req, ctx: RouteContext<{ id: string }>) => {
  const id = await parseId(ctx.params);
  if (!id) return errorJson(400, "invalid_id", "ID inválido");
  const sql = getSql();
  const caps = await getCapabilities(sql);
  const context = await loadContext(sql, id, caps.publicationModel ?? "CLASSIC");
  if (!context) return errorJson(404, "not_found", "Rascunho não encontrado");
  const fp = fingerprint(context);
  const d = context.draft;
  const publishable = d.status === "VALIDATED" && d.validatedVersion === d.version && d.validatedFingerprint === fp;
  return jsonNoStore({
    review: reviewSummary(context, { meliUserId: caps.meliUserId, nickname: caps.nickname }),
    status: d.status,
    fingerprint: fp,
    publishable,
    reason: publishable
      ? null
      : d.status !== "VALIDATED"
        ? "O anúncio precisa ser validado antes da publicação."
        : "O conteúdo mudou depois da validação. Valide novamente.",
  });
});
