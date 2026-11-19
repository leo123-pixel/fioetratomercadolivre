import type { NextRequest } from "next/server";
import { ConfigError } from "@/lib/env";
import { errorJson, jsonNoStore } from "@/lib/http";
import { logger } from "@/lib/logger";
import { recordWebhookEvent, scheduleWebhookProcessing, type WebhookPayload } from "@/lib/nuvemshop/events";
import { verifyWebhookSignature } from "@/lib/nuvemshop/webhooks";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/nuvemshop/events — pedidos e produtos (cadastrados pelo integrador em POST /webhooks).
 * Verifica o HMAC, PERSISTE o evento e responde já (limite de 3 s da Nuvemshop); o processamento (releitura na
 * API, compromissos de estoque, catálogo) roda depois da resposta e no agendador.
 */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (raw.length > 65_536) return errorJson(413, "too_large", "Corpo muito grande");
  try {
    if (!verifyWebhookSignature(raw, req.headers.get("x-linkedstore-hmac-sha256"))) return errorJson(401, "invalid_signature", "Assinatura inválida");
  } catch (err) {
    if (err instanceof ConfigError) return errorJson(503, "not_configured", "Integração Nuvemshop não configurada");
    throw err;
  }
  let payload: WebhookPayload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return errorJson(400, "invalid_json", "JSON inválido");
  }
  try {
    const r = await recordWebhookEvent(getSql(), raw, payload);
    if (r.stored) scheduleWebhookProcessing();
    // Duplicado ou inválido também recebe 2xx: a Nuvemshop não deve reenviar (o evento já está na fila ou não é útil).
    return jsonNoStore({ received: true, stored: r.stored, reason: r.reason ?? null });
  } catch (err) {
    logger.error("Falha ao gravar webhook Nuvemshop", { err });
    return errorJson(500, "internal_error", "Erro interno");
  }
}
