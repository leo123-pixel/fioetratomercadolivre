import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { jsonNoStore } from "@/lib/http";
import { listMovements } from "@/lib/inventory/queries";
import { getSql } from "@/lib/sql";
import { parseQuery } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const query = z.object({ q: z.string().max(100).optional(), type: z.string().regex(/^[A-Z_]{3,40}$/).optional(), limit: z.coerce.number().int().min(1).max(500).optional() });

/** Livro de movimentações (auditoria). Busca por SKU, produto ADS ou pedido. */
export const GET = adminHandler(async (req) => {
  const q = parseQuery(req, query);
  if (!q.ok) return q.response;
  return jsonNoStore({ movements: await listMovements(getSql(), q.data) });
});
