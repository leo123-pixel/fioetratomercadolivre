import { adminHandler } from "@/lib/api";
import { jsonNoStore } from "@/lib/http";
import { inventoryCoreMode } from "@/lib/inventory/mode";
import { simulationRows } from "@/lib/nuvemshop/queries";
import { getSql } from "@/lib/sql";
import { catalogStoreId } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/nuvemshop/simulation — cotas SIMULADAS do Inventory Core para produtos vinculados, ao lado do
 * observado em cada canal. Para recalcular, rode a reconciliação sombra do Inventory Core.
 */
export const GET = adminHandler(async (req) => {
  const sp = req.nextUrl.searchParams;
  const sql = getSql();
  const data = await simulationRows(sql, await catalogStoreId(sql), { page: Number(sp.get("page")) || 1, q: sp.get("q")?.slice(0, 120) ?? undefined });
  return jsonNoStore({ mode: inventoryCoreMode(), simulated: true, ...data });
});
