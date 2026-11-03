import { adminHandler } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { disconnect } from "@/lib/meli/connection";
import { DISCONNECT_CONFIRMATION } from "@/lib/meli/messages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/mercadolivre/disconnect — body: { "confirm": "DESCONECTAR" }.
 * Revoga a autorização no ML quando possível e sempre remove os tokens locais.
 */
export const POST = adminHandler(
  async (req) => {
    const body = (await req.json().catch(() => null)) as { confirm?: unknown } | null;
    if (body?.confirm !== DISCONNECT_CONFIRMATION) {
      return errorJson(400, "confirmation_required", `Envie {"confirm":"${DISCONNECT_CONFIRMATION}"} para confirmar`);
    }
    const result = await disconnect();
    return jsonNoStore({
      ok: true,
      ...result,
      note: result.revokedRemotely
        ? "Autorização revogada no Mercado Livre e tokens locais removidos."
        : "Tokens locais removidos. A revogação no Mercado Livre não foi confirmada; se necessário, remova o aplicativo em Minha conta > Segurança no Mercado Livre.",
    });
  },
  { mutating: true },
);
