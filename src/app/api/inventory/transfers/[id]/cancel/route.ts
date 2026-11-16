import { adminHandler, type RouteContext } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { cancelTransfer } from "@/lib/inventory/transfer-service";
import { getSql } from "@/lib/sql";
import { actorOf } from "../../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST = adminHandler<RouteContext<{ id: string }>>(
  async (req, ctx) => {
    const { id } = await ctx.params;
    if (!UUID.test(id)) return errorJson(400, "invalid_id", "Identificador inválido");
    return jsonNoStore({ transfer: await cancelTransfer(getSql(), id, actorOf(req)) });
  },
  { mutating: true, rateLimitPerMinute: 20 },
);
