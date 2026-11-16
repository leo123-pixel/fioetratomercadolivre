import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { jsonNoStore } from "@/lib/http";
import { listReservations } from "@/lib/inventory/queries";
import { getSql } from "@/lib/sql";
import { parseQuery } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATES = ["PENDING_ERP", "REFLECTED_IN_ERP", "RELEASED", "REQUIRES_RECONCILIATION"] as const;
const query = z.object({
  state: z.string().optional().transform((v, ctx) => {
    if (!v) return undefined;
    const list = v.split(",");
    if (list.some((s) => !(STATES as readonly string[]).includes(s))) {
      ctx.addIssue({ code: "custom", message: "Estado inválido" });
      return z.NEVER;
    }
    return list;
  }),
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

/** Compromissos de estoque (relatório de pedidos pendentes de reflexo na ADS). */
export const GET = adminHandler(async (req) => {
  const q = parseQuery(req, query);
  if (!q.ok) return q.response;
  return jsonNoStore({ reservations: await listReservations(getSql(), { states: q.data.state, q: q.data.q, limit: q.data.limit }) });
});
