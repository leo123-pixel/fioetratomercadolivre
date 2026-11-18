import { adminHandler, type RouteContext } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { findNsCandidates, mappingHistory, strongest } from "@/lib/nuvemshop/mapping";
import { variantDetail } from "@/lib/nuvemshop/queries";
import { getSql } from "@/lib/sql";
import { catalogStoreId, isVariantId } from "../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/nuvemshop/products/:variantId — detalhe, estoque por localização, candidatos ADS e histórico. */
export const GET = adminHandler<RouteContext<{ variantId: string }>>(async (_req, ctx) => {
  const { variantId } = await ctx.params;
  if (!isVariantId(variantId)) return errorJson(404, "not_found", "Variante não encontrada");
  const sql = getSql();
  const storeId = await catalogStoreId(sql);
  const detail = await variantDetail(sql, storeId, variantId);
  if (!detail) return errorJson(404, "not_found", "Variante não encontrada");
  const candidates = (await findNsCandidates(sql, storeId, [variantId])).get(variantId) ?? [];
  return jsonNoStore({
    ...detail,
    candidates,
    ambiguous: strongest(candidates).length > 1,
    history: await mappingHistory(sql, storeId, variantId),
  });
});
