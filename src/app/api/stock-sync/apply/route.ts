import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { getAdminSession } from "@/lib/auth/admin";
import { jsonNoStore } from "@/lib/http";
import { requesterFromSession } from "@/lib/publish/service";
import { getSql } from "@/lib/sql";
import { applyProposals } from "@/lib/stock/reconcile";
import { parseJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const body = z.object({
  proposalIds: z.array(z.string().regex(/^\d{1,18}$/)).min(1).max(200),
  /** Token devolvido por /api/stock-sync/validate para exatamente estas propostas. */
  confirmationToken: z.string().min(20).max(20_000),
  /** Confirmação explícita do operador. */
  confirm: z.literal(true),
});

/**
 * "Sincronizar estoque selecionado": cria jobs persistentes (um por estoque do ML), reavalia cada um
 * imediatamente antes da escrita e confere a quantidade no ML depois. Registra quem autorizou.
 */
export const POST = adminHandler(
  async (req) => {
    const b = await parseJsonBody(req, body);
    if (!b.ok) return b.response;
    const r = await applyProposals(getSql(), {
      proposalIds: b.data.proposalIds,
      confirmationToken: b.data.confirmationToken,
      actor: requesterFromSession(getAdminSession(req)?.sid),
      deadline: Date.now() + 45_000,
    });
    return jsonNoStore(r);
  },
  { mutating: true, rateLimitPerMinute: 10 },
);
