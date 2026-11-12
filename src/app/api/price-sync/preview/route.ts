import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { getAdminSession } from "@/lib/auth/admin";
import { jsonNoStore } from "@/lib/http";
import { requesterFromSession } from "@/lib/publish/service";
import { getSql } from "@/lib/sql";
import { runPricePreview } from "@/lib/stock/prices";
import { parseJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const body = z.object({
  /** Anúncios a simular (vazio = todos os legados vinculados). */
  itemIds: z.array(z.string().regex(/^MLB\d{1,15}$/)).max(500).optional(),
});

/**
 * SIMULAÇÃO de preço: consulta ao vivo a tabela de preço configurada na ADS e o preço atual no ML (com
 * verificação de promoção) e grava propostas. Nenhuma escrita no Mercado Livre.
 */
export const POST = adminHandler(
  async (req) => {
    const b = await parseJsonBody(req, body);
    if (!b.ok) return b.response;
    const r = await runPricePreview(getSql(), {
      requestedBy: requesterFromSession(getAdminSession(req)?.sid),
      itemIds: b.data.itemIds,
      deadline: Date.now() + 45_000,
    });
    return jsonNoStore(r);
  },
  { mutating: true, rateLimitPerMinute: 10 },
);
