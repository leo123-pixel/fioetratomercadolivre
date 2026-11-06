import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { jsonNoStore } from "@/lib/http";
import { getSql } from "@/lib/sql";
import { LEGACY_FILTERS, listLegacyListings } from "@/lib/stock/legacy";
import { getStockSettings } from "@/lib/stock/settings";
import { parseQuery } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const query = z.object({
  filter: z.enum(LEGACY_FILTERS).optional(),
  q: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});

/** Inventário de anúncios da conta com vínculo, sugestão, saldo ADS (cache) e situação de sincronização. */
export const GET = adminHandler(
  async (req) => {
    const q = parseQuery(req, query);
    if (!q.ok) return q.response;
    const sql = getSql();
    const settings = await getStockSettings(sql);
    return jsonNoStore(await listLegacyListings(sql, { ...q.data, branchIds: settings.branchIds }));
  },
  { rateLimitPerMinute: 120 },
);
