import { adminHandler } from "@/lib/api";
import { getCatalogSettings, listBranches, listPriceTables } from "@/lib/catalog/settings";
import { jsonNoStore } from "@/lib/http";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminHandler(async () => {
  const sql = getSql();
  const [tables, settings, branches] = await Promise.all([listPriceTables(sql), getCatalogSettings(sql), listBranches(sql)]);
  return jsonNoStore({ tables, settings, branches });
});
