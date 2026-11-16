import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { jsonNoStore } from "@/lib/http";
import { listRuns } from "@/lib/inventory/queries";
import { runShadowReconciliation } from "@/lib/inventory/shadow";
import { getSql } from "@/lib/sql";
import { parseJsonBody } from "@/lib/validation";
import { actorOf } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const body = z
  .object({
    /** Consulta o saldo ao vivo na ADS (somente GET). Padrão: cache local. */
    live: z.boolean().optional(),
    productIds: z.array(z.number().int().positive().max(2_147_483_647)).max(500).optional(),
  })
  .strict();

export const GET = adminHandler(async () => jsonNoStore({ runs: await listRuns(getSql(), 30) }));

/** Reconciliação em MODO SOMBRA: lê, calcula e grava só nas tabelas inventory_*. Nenhuma escrita externa. */
export const POST = adminHandler(
  async (req) => {
    const b = await parseJsonBody(req, body);
    if (!b.ok) return b.response;
    const r = await runShadowReconciliation(getSql(), { requestedBy: actorOf(req), live: b.data.live, productIds: b.data.productIds, deadline: Date.now() + 50_000 });
    return jsonNoStore(r);
  },
  { mutating: true, rateLimitPerMinute: 6 },
);
