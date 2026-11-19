import { adminHandler } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { automationVariants } from "@/lib/nuvemshop/automation-queries";
import { getSql } from "@/lib/sql";
import { catalogStoreId } from "../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/nuvemshop/automation/variants?kind=PRICE|STOCK&q&participation&page — seleção de SKUs participantes. */
export const GET = adminHandler(async (req) => {
  const kind = req.nextUrl.searchParams.get("kind");
  if (kind !== "PRICE" && kind !== "STOCK") return errorJson(422, "invalid_kind", "kind deve ser PRICE ou STOCK");
  const participation = req.nextUrl.searchParams.get("participation");
  if (participation && !["NONE", "PILOT", "INCLUDED", "EXCLUDED"].includes(participation)) return errorJson(422, "invalid_participation", "Participação inválida");
  const sql = getSql();
  const items = await automationVariants(sql, await catalogStoreId(sql), {
    kind,
    q: req.nextUrl.searchParams.get("q"),
    participation,
    page: Number(req.nextUrl.searchParams.get("page") ?? 1) || 1,
  });
  return jsonNoStore({ items });
});
