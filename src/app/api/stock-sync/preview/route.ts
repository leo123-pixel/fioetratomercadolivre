import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { getAdminSession } from "@/lib/auth/admin";
import { jsonNoStore } from "@/lib/http";
import { requesterFromSession } from "@/lib/publish/service";
import { getSql } from "@/lib/sql";
import { runPreview } from "@/lib/stock/reconcile";
import { parseJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const body = z.object({
  /** Anúncios a simular (vazio = todos os vinculados). */
  itemIds: z.array(z.string().regex(/^MLB\d{1,15}$/)).max(500).optional(),
});

/**
 * SIMULAÇÃO (DRY RUN): consulta o saldo real na ADS e o estoque real no ML, calcula divergências e grava
 * propostas. Nenhuma escrita no Mercado Livre.
 */
export const POST = adminHandler(
  async (req) => {
    const b = await parseJsonBody(req, body);
    if (!b.ok) return b.response;
    const r = await runPreview(getSql(), {
      requestedBy: requesterFromSession(getAdminSession(req)?.sid),
      mode: "DRY_RUN",
      itemIds: b.data.itemIds,
      deadline: Date.now() + 45_000,
    });
    return jsonNoStore(r);
  },
  { mutating: true, rateLimitPerMinute: 10 },
);
