import { adminHandler } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { listOrders } from "@/lib/nuvemshop/orders";
import { getSql } from "@/lib/sql";
import { catalogStoreId } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATES = ["NONE", "COMMITTED", "REFLECTED_IN_ERP", "RELEASED", "REQUIRES_RECONCILIATION"];

/** GET /api/nuvemshop/orders?state — pedidos Nuvemshop usados na proteção de estoque (sem dados pessoais). */
export const GET = adminHandler(async (req) => {
  const state = req.nextUrl.searchParams.get("state");
  if (state && !STATES.includes(state)) return errorJson(422, "invalid_state", "Situação inválida");
  const sql = getSql();
  return jsonNoStore({ items: await listOrders(sql, await catalogStoreId(sql), { state }) });
});
