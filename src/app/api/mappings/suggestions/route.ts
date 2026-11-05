import { adminHandler } from "@/lib/api";
import { jsonNoStore } from "@/lib/http";
import { suggestByBarcode } from "@/lib/marketplace/mappings";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Sugestões por código de barras (GTIN do anúncio no ML = EAN/DUN-14 do produto ADS). Somente leitura. */
export const GET = adminHandler(async () => jsonNoStore({ items: await suggestByBarcode(getSql()) }), { rateLimitPerMinute: 6 });
