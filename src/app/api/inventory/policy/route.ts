import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { jsonNoStore } from "@/lib/http";
import { listPolicyVersions, policyInputSchema, savePolicy } from "@/lib/inventory/settings";
import { getSql } from "@/lib/sql";
import { parseJsonBody, parseQuery } from "@/lib/validation";
import { actorOf } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const query = z.object({ productId: z.coerce.number().int().positive().max(2_147_483_647).optional() });

/** Versões da política de alocação (global ou de um produto). */
export const GET = adminHandler(async (req) => {
  const q = parseQuery(req, query);
  if (!q.ok) return q.response;
  return jsonNoStore({ versions: await listPolicyVersions(getSql(), q.data.productId ?? null) });
});

/** Nova versão da política (configuração interna; não publica nada). */
export const PUT = adminHandler(
  async (req) => {
    const b = await parseJsonBody(req, policyInputSchema);
    if (!b.ok) return b.response;
    return jsonNoStore({ policy: await savePolicy(getSql(), b.data, actorOf(req)) });
  },
  { mutating: true, rateLimitPerMinute: 20 },
);
