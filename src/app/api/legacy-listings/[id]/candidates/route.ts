import { adminHandler, type RouteContext } from "@/lib/api";
import { jsonNoStore } from "@/lib/http";
import { getSql } from "@/lib/sql";
import { getLegacyListing } from "@/lib/stock/legacy";
import { getCandidates } from "@/lib/stock/links";
import { getStockSettings } from "@/lib/stock/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Produtos ADS candidatos (SKU, GTIN, fabricante) + dicas por título (apenas visuais). */
export const GET = adminHandler(
  async (_req, ctx: RouteContext<{ id: string }>) => {
    const { id } = await ctx.params;
    const sql = getSql();
    const result = await getCandidates(sql, id);
    const listing = await getLegacyListing(sql, id, (await getStockSettings(sql)).branchIds);
    return jsonNoStore({ listing, ...result });
  },
  { rateLimitPerMinute: 120 },
);
