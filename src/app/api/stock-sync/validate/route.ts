import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { jsonNoStore } from "@/lib/http";
import { getSql } from "@/lib/sql";
import { validateProposals } from "@/lib/stock/reconcile";
import { parseJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const body = z.object({ proposalIds: z.array(z.string().regex(/^\d{1,18}$/)).min(1).max(200) });

/**
 * Antes de aplicar: reconsulta ADS e ML, confere vínculos, versão e jobs em andamento e devolve o resumo da
 * operação com um token de confirmação (10 min). Nada é escrito no Mercado Livre.
 */
export const POST = adminHandler(
  async (req) => {
    const b = await parseJsonBody(req, body);
    if (!b.ok) return b.response;
    return jsonNoStore(await validateProposals(getSql(), [...new Set(b.data.proposalIds)]));
  },
  { mutating: true, rateLimitPerMinute: 20 },
);
