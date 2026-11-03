import { adminHandler } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { MeliApiError } from "@/lib/meli/client";
import { verifyConnection } from "@/lib/meli/connection";
import { MeliAuthError } from "@/lib/meli/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/mercadolivre/connection/test — chamada autenticada a /users/me com o token armazenado. */
export const POST = adminHandler(
  async () => {
    try {
      const user = await verifyConnection();
      return jsonNoStore({ ok: true, ...user, checkedAt: new Date().toISOString() });
    } catch (err) {
      if (err instanceof MeliAuthError) {
        return errorJson(err.code === "not_connected" || err.code === "reauth_required" ? 409 : 503, err.code, err.message);
      }
      if (err instanceof MeliApiError) return errorJson(502, err.errorCode, "Falha na chamada ao Mercado Livre");
      throw err;
    }
  },
  { mutating: true },
);
