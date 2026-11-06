import { adminHandler } from "@/lib/api";
import { jsonNoStore } from "@/lib/http";
import { getSql } from "@/lib/sql";
import { discoverLegacyListings } from "@/lib/stock/legacy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Varre os anúncios da conta no Mercado Livre (somente leitura) e atualiza o inventário e as sugestões.
 * Contas grandes: cada chamada trabalha até ~40 s; chamar de novo continua de onde parou (complete=false).
 */
export const POST = adminHandler(
  async () => {
    const r = await discoverLegacyListings(getSql(), { deadline: Date.now() + 40_000 });
    return jsonNoStore(r);
  },
  { mutating: true, rateLimitPerMinute: 10 },
);
