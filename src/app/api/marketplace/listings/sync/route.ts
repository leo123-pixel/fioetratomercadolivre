import { adminHandler } from "@/lib/api";
import { jsonNoStore } from "@/lib/http";
import { syncAllListings } from "@/lib/publish/listings";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Relê no Mercado Livre o status de todos os anúncios publicados (somente leitura). */
export const POST = adminHandler(async () => jsonNoStore(await syncAllListings(getSql())), { mutating: true, rateLimitPerMinute: 6 });
