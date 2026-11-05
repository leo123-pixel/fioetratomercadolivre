import { adminHandler } from "@/lib/api";
import { fetchCommercialOptions, getAdsOrderSettings, saveAdsOrderSettings } from "@/lib/ads/commercial";
import { jsonNoStore } from "@/lib/http";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Configuração comercial atual + listas reais da ADS (operações, origens, formas, prazos, representantes, classes). */
export const GET = adminHandler(
  async () => {
    const sql = getSql();
    const [settings, options] = await Promise.all([getAdsOrderSettings(sql), fetchCommercialOptions(sql)]);
    return jsonNoStore({ settings, options });
  },
  { rateLimitPerMinute: 20 },
);

/** Grava a configuração depois de validar cada código contra a ADS. */
export const PUT = adminHandler(
  async (req) => {
    const body = await req.json().catch(() => null);
    return jsonNoStore({ settings: await saveAdsOrderSettings(getSql(), body) });
  },
  { mutating: true, rateLimitPerMinute: 10 },
);
