import "server-only";
import { randomUUID } from "node:crypto";
import { after, type NextRequest, NextResponse } from "next/server";
import { logger } from "../logger";
import { rateLimit } from "../rate-limit";
import { getSql } from "../sql";
import { getMarketplaceConfig } from "./config";
import { ingestNotification, processEvents, type Lane } from "./events";
import { ensureSchedulerRegistration } from "./scheduler";

/**
 * POST /api/webhooks/mercadolivre — URL de notificações da aplicação no DevCenter
 * (diferente do callback OAuth). Fluxo: limites → validação → gravação durável → 200 → processamento
 * assíncrono. Sem chamada externa antes da resposta (o ML exige 200 em até 500 ms).
 * Responde 200 SOMENTE depois do INSERT confirmado (ou de reconhecer uma reentrega já gravada).
 */
export const MAX_BODY_BYTES = 16 * 1024;

const ok = () => new NextResponse(null, { status: 200, headers: { "cache-control": "no-store" } });
const fail = (status: number, error: string) => NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });

function clientIp(req: NextRequest): string {
  return req.headers.get("x-real-ip")?.trim() || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

/** Processa a raia do evento logo após a resposta; também garante o registro do agendador (pg_cron). */
async function processLane(lane: Lane): Promise<void> {
  try {
    await ensureSchedulerRegistration(getSql()).catch(() => undefined);
    await processEvents({ lanes: [lane], budgetMs: 25_000 });
  } catch (err) {
    logger.error("Erro ao processar eventos do Mercado Livre", { err });
  }
}

let processor: (lane: Lane) => void = (lane) => after(() => processLane(lane));

/** Somente testes: substitui o disparo do processamento assíncrono. */
export function setWebhookProcessorForTesting(fn: ((lane: Lane) => void) | null) {
  if (process.env.NODE_ENV !== "test") throw new Error("setWebhookProcessorForTesting só pode ser usado em testes");
  processor = fn ?? ((lane) => after(() => processLane(lane)));
}

export async function handleMeliWebhook(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const ip = clientIp(req);
  const cfg = getMarketplaceConfig();
  if (cfg.webhookAllowedIps.length && !cfg.webhookAllowedIps.includes(ip)) return fail(403, "forbidden");
  if (!rateLimit("meli-webhook:global", 1200, 60_000).ok || !rateLimit(`meli-webhook:ip:${ip}`, 600, 60_000).ok) return fail(429, "rate_limited");

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return fail(413, "payload_too_large");
  let text: string;
  try {
    text = await req.text();
  } catch {
    return fail(400, "invalid_body");
  }
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return fail(413, "payload_too_large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail(400, "invalid_json");
  }

  try {
    const sql = getSql();
    const r = await ingestNotification(sql, body, { source: "webhook" });
    if (r.outcome === "rejected") {
      logger.warn("Notificação do Mercado Livre recusada", { requestId, reason: r.reason });
      return fail(r.httpStatus, r.reason);
    }
    const topic = typeof (body as { topic?: unknown })?.topic === "string" ? String((body as { topic: string }).topic).slice(0, 60) : null;
    logger.info("Notificação do Mercado Livre recebida", {
      requestId,
      topic,
      outcome: r.outcome,
      eventId: r.id,
      status: r.outcome === "stored" ? r.status : "DUPLICATE",
      reason: r.outcome === "stored" ? (r.reason ?? null) : null,
    });
    if (r.outcome === "stored" && r.lane) processor(r.lane);
    return ok();
  } catch (err) {
    // Sem gravação durável não há confirmação: o ML reenviará (até 1 h) e o missed_feeds cobre o resto.
    logger.error("Falha ao gravar notificação do Mercado Livre", { requestId, err });
    return fail(500, "storage_error");
  }
}
