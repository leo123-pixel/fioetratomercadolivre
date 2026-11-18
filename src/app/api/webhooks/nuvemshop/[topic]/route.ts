import type { NextRequest } from "next/server";
import { ConfigError } from "@/lib/env";
import { errorJson, jsonNoStore } from "@/lib/http";
import { logger } from "@/lib/logger";
import { handlePrivacyWebhook, verifyWebhookSignature, type PrivacyTopic } from "@/lib/nuvemshop/webhooks";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOPICS: Record<string, PrivacyTopic> = {
  "store-redact": "store/redact",
  "customers-redact": "customers/redact",
  "customers-data-request": "customers/data_request",
};

/**
 * POST /api/webhooks/nuvemshop/{store-redact|customers-redact|customers-data-request}
 * Webhooks obrigatórios de privacidade (URLs cadastradas no Portal de Parceiros). Exigem a assinatura
 * x-linkedstore-hmac-sha256 válida; corpo limitado a 64 KB.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ topic: string }> }) {
  const { topic } = await ctx.params;
  const t = TOPICS[topic];
  if (!t) return errorJson(404, "not_found", "Tópico desconhecido");
  const raw = await req.text();
  if (raw.length > 65_536) return errorJson(413, "too_large", "Corpo muito grande");
  try {
    if (!verifyWebhookSignature(raw, req.headers.get("x-linkedstore-hmac-sha256"))) return errorJson(401, "invalid_signature", "Assinatura inválida");
  } catch (err) {
    if (err instanceof ConfigError) return errorJson(503, "not_configured", "Integração Nuvemshop não configurada");
    throw err;
  }
  let payload: { store_id?: number | string };
  try {
    payload = JSON.parse(raw);
  } catch {
    return errorJson(400, "invalid_json", "JSON inválido");
  }
  try {
    const result = await handlePrivacyWebhook(getSql(), t, payload);
    return jsonNoStore({ received: true, ...result });
  } catch (err) {
    logger.error("Falha ao processar webhook de privacidade da Nuvemshop", { topic: t, err });
    return errorJson(500, "internal_error", "Erro interno");
  }
}
