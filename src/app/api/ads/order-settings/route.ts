import type { NextRequest } from "next/server";
import { adminHandler } from "@/lib/api";
import { fetchCommercialOptions, getAdsOrderSettings, isSalesChannel, saveAdsOrderSettings, type SalesChannel } from "@/lib/ads/commercial";
import { errorJson, jsonNoStore } from "@/lib/http";
import { NUVEMSHOP_DEFAULT_PRICE_TABLE } from "@/lib/nuvemshop/automation";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** ?channel=mercadolivre (padrão) | nuvemshop — cada canal tem a própria configuração comercial. */
function channelOf(req: NextRequest): SalesChannel | null {
  const c = req.nextUrl.searchParams.get("channel") ?? "mercadolivre";
  return isSalesChannel(c) ? c : null;
}

/**
 * Configuração comercial atual do canal + listas reais da ADS (operações, origens, formas, prazos, representantes,
 * classes). Canal sem configuração: sugere a do Mercado Livre (com a tabela padrão do canal), sem gravar.
 */
export const GET = adminHandler(
  async (req) => {
    const channel = channelOf(req);
    if (!channel) return errorJson(422, "invalid_channel", "Canal inválido");
    const sql = getSql();
    const [settings, options] = await Promise.all([getAdsOrderSettings(sql, channel), fetchCommercialOptions(sql)]);
    let suggested = null;
    if (!settings && channel === "nuvemshop") {
      const ml = await getAdsOrderSettings(sql, "mercadolivre");
      suggested = ml ? { ...ml, tabela: NUVEMSHOP_DEFAULT_PRICE_TABLE } : null;
    }
    return jsonNoStore({ channel, settings, suggested, options });
  },
  { rateLimitPerMinute: 20 },
);

/** Grava a configuração do canal depois de validar cada código contra a ADS. */
export const PUT = adminHandler(
  async (req) => {
    const channel = channelOf(req);
    if (!channel) return errorJson(422, "invalid_channel", "Canal inválido");
    const body = await req.json().catch(() => null);
    return jsonNoStore({ channel, settings: await saveAdsOrderSettings(getSql(), body, channel) });
  },
  { mutating: true, rateLimitPerMinute: 10 },
);
