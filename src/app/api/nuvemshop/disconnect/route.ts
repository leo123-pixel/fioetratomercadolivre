import { actorOf } from "@/app/api/inventory/_shared";
import { adminHandler } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { disconnectStore } from "@/lib/nuvemshop/store";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/nuvemshop/disconnect — desconexão administrativa: apaga o token local. O catálogo importado e os
 * vínculos ficam como histórico. Para revogar o acesso na Nuvemshop, desinstale o aplicativo no painel da loja.
 */
export const POST = adminHandler(
  async (req) => {
    const store = await disconnectStore(getSql(), actorOf(req));
    if (!store) return errorJson(404, "not_connected", "Nenhuma loja Nuvemshop conectada");
    return jsonNoStore({ ok: true, storeId: store.storeId });
  },
  { mutating: true, rateLimitPerMinute: 5 },
);
