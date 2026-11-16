import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { jsonNoStore } from "@/lib/http";
import { listDiscrepancies } from "@/lib/inventory/queries";
import { getSql } from "@/lib/sql";
import { parseQuery } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const query = z.object({
  status: z.enum(["OPEN", "RESOLVED"]).optional(),
  severity: z.enum(["INFO", "WARNING", "CRITICAL"]).optional(),
  type: z.string().regex(/^[A-Z_]{3,40}$/).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

export const GET = adminHandler(async (req) => {
  const q = parseQuery(req, query);
  if (!q.ok) return q.response;
  return jsonNoStore({ discrepancies: await listDiscrepancies(getSql(), q.data) });
});
