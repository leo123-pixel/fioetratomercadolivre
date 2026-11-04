import { adminHandler, type RouteContext } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { syncListing } from "@/lib/publish/listings";
import { getSql } from "@/lib/sql";
import { parseId } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Relê status e permalink no Mercado Livre (somente leitura). */
export const POST = adminHandler(
  async (_req, ctx: RouteContext<{ id: string }>) => {
    const id = await parseId(ctx.params);
    if (!id) return errorJson(400, "invalid_id", "ID inválido");
    const listing = await syncListing(getSql(), id);
    if (!listing) return errorJson(404, "not_found", "Anúncio não encontrado");
    return jsonNoStore({ listing });
  },
  { mutating: true, rateLimitPerMinute: 30 },
);
