import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { jsonNoStore } from "@/lib/http";
import { listPositions, RELIABILITY_FILTERS } from "@/lib/inventory/queries";
import { getSql } from "@/lib/sql";
import { parseQuery } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const query = z.object({
  q: z.string().max(100).optional(),
  reliability: z.enum(RELIABILITY_FILTERS).optional(),
  alerts: z.enum(["1", "0"]).optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});

export const GET = adminHandler(async (req) => {
  const q = parseQuery(req, query);
  if (!q.ok) return q.response;
  return jsonNoStore(await listPositions(getSql(), { ...q.data, alerts: q.data.alerts === "1" }));
});
