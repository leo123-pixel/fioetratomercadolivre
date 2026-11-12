import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { getAdminSession } from "@/lib/auth/admin";
import { jsonNoStore } from "@/lib/http";
import { requesterFromSession } from "@/lib/publish/service";
import { getSql } from "@/lib/sql";
import { applyPriceProposals } from "@/lib/stock/prices";
import { parseJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const body = z.object({
  proposalIds: z.array(z.string().regex(/^\d{1,18}$/)).min(1).max(200),
  /** Confirmação explícita do operador. */
  confirm: z.literal(true),
  /** Confirmação adicional para variações acima do limite configurado. */
  allowLargeChanges: z.boolean().default(false),
});

/**
 * "Atualizar preço selecionado": reconsulta ADS, ML e promoções de cada anúncio, escreve somente o preço e
 * confere o valor no ML depois. Registra quem autorizou.
 */
export const POST = adminHandler(
  async (req) => {
    const b = await parseJsonBody(req, body);
    if (!b.ok) return b.response;
    const r = await applyPriceProposals(getSql(), {
      proposalIds: b.data.proposalIds,
      actor: requesterFromSession(getAdminSession(req)?.sid),
      allowLargeChanges: b.data.allowLargeChanges,
      deadline: Date.now() + 45_000,
    });
    return jsonNoStore(r);
  },
  { mutating: true, rateLimitPerMinute: 10 },
);
