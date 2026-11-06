import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { jsonNoStore } from "@/lib/http";
import { getSql } from "@/lib/sql";
import { listLegacyListings } from "@/lib/stock/legacy";
import { parseQuery } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const query = z.object({
  q: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});

/** Anúncios sem vínculo confirmado (sem correspondência, sugestão pendente ou ambígua). */
export const GET = adminHandler(
  async (req) => {
    const q = parseQuery(req, query);
    if (!q.ok) return q.response;
    return jsonNoStore(await listLegacyListings(getSql(), { ...q.data, filter: "unmapped" }));
  },
  { rateLimitPerMinute: 120 },
);
