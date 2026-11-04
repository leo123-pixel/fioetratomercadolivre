import { adminHandler, type RouteContext } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { listEvents } from "@/lib/publish/events";
import { getListing } from "@/lib/publish/listings";
import { getSql } from "@/lib/sql";
import { parseId } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminHandler(async (_req, ctx: RouteContext<{ id: string }>) => {
  const id = await parseId(ctx.params);
  if (!id) return errorJson(400, "invalid_id", "ID inválido");
  const sql = getSql();
  const listing = await getListing(sql, id);
  if (!listing) return errorJson(404, "not_found", "Anúncio não encontrado");
  return jsonNoStore({ listing, events: await listEvents(sql, listing.listingDraftId) });
});
