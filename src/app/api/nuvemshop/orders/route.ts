import { adminHandler } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { listNsOrdersForAds } from "@/lib/nuvemshop/ads-orders";
import { listOrders } from "@/lib/nuvemshop/orders";
import { getSql } from "@/lib/sql";
import { catalogStoreId } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATES = ["NONE", "COMMITTED", "REFLECTED_IN_ERP", "RELEASED", "REQUIRES_RECONCILIATION"];
const ADS_FILTERS = ["pending", "sent", "all"] as const;

/**
 * GET /api/nuvemshop/orders?state — pedidos Nuvemshop usados na proteção de estoque (sem dados pessoais).
 * GET /api/nuvemshop/orders?ads=pending|sent|all — pedidos com a situação do envio à ADS.
 */
export const GET = adminHandler(async (req) => {
  const sql = getSql();
  const ads = req.nextUrl.searchParams.get("ads");
  if (ads !== null) {
    if (!(ADS_FILTERS as readonly string[]).includes(ads)) return errorJson(422, "invalid_filter", "Filtro inválido");
    return jsonNoStore({ items: await listNsOrdersForAds(sql, await catalogStoreId(sql), { filter: ads as (typeof ADS_FILTERS)[number] }) });
  }
  const state = req.nextUrl.searchParams.get("state");
  if (state && !STATES.includes(state)) return errorJson(422, "invalid_state", "Situação inválida");
  return jsonNoStore({ items: await listOrders(sql, await catalogStoreId(sql), { state }) });
});
