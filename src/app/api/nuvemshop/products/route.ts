import { adminHandler } from "@/lib/api";
import { jsonNoStore } from "@/lib/http";
import { listVariants, VARIANT_FILTERS, type VariantFilter } from "@/lib/nuvemshop/queries";
import { getSql } from "@/lib/sql";
import { catalogStoreId } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/nuvemshop/products?filter=&q=&page= — variantes importadas (dados locais, sem chamada à Nuvemshop). */
export const GET = adminHandler(async (req) => {
  const sp = req.nextUrl.searchParams;
  const sql = getSql();
  const filter = (VARIANT_FILTERS as readonly string[]).includes(sp.get("filter") ?? "") ? (sp.get("filter") as VariantFilter) : "all";
  const data = await listVariants(sql, {
    storeId: await catalogStoreId(sql),
    filter,
    q: sp.get("q")?.slice(0, 120) ?? undefined,
    page: Number(sp.get("page")) || 1,
    pageSize: Number(sp.get("pageSize")) || 50,
  });
  return jsonNoStore(data);
});
