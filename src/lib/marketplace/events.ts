import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { acquireLease, releaseLease, renewLease } from "../imports/jobs";
import { getEnv } from "../env";
import { logger } from "../logger";
import { getSql, type Sql } from "../sql";
import { getStore } from "../store";
import { raiseAlert } from "./alerts";
import { getMarketplaceConfig } from "./config";
import { backoffMs, classifyError } from "./errors";

/**
 * Notificações do Mercado Livre como fila persistente no PostgreSQL (o projeto não usa Redis/BullMQ).
 *
 * - O webhook só valida, grava (marketplace_webhook_events) e responde: nenhuma chamada externa.
 * - O ML não assina as notificações: o corpo é só um gatilho. Os dados são sempre relidos na API
 *   autenticada, e nada é escrito no Mercado Livre nem na ADS a partir de um evento.
 * - Cada "raia" (anúncios, pedidos, envios) tem seu próprio lease e processa em série; um evento em
 *   processamento tem lease próprio (locked_until), então um worker que morrer libera o evento.
 * - Deduplicação pelo _id do ML (UNIQUE); eventos do mesmo recurso recebidos antes de uma leitura
 *   bem-sucedida são marcados como atendidos por ela (coalesced_into).
 */
export type Lane = "listings" | "orders" | "shipments";

export const TOPIC_LANES: Record<string, Lane> = {
  items: "listings",
  items_prices: "listings",
  user_products: "listings",
  user_products_families: "listings",
  orders_v2: "orders",
  shipments: "shipments",
};

export const SUPPORTED_TOPICS = Object.keys(TOPIC_LANES);

/** Recurso esperado por tópico; o primeiro grupo é o identificador usado no processamento. */
const RESOURCE_PATTERNS: Record<string, RegExp> = {
  items: /^\/items\/(MLB\d{1,15})$/,
  items_prices: /^\/items\/(MLB\d{1,15})(?:\/prices)?$/,
  user_products: /^\/user-products\/([A-Z]{3}U?\d{1,20})(?:\/[a-z_-]+)?$/,
  user_products_families: /\/user-products-families\/(\d{1,25})(?:\/[a-z_-]+)?$/,
  orders_v2: /^\/orders\/(\d{1,20})$/,
  shipments: /^\/shipments\/(\d{1,20})$/,
};

export function resourceId(topic: string, resource: string): string | null {
  return RESOURCE_PATTERNS[topic]?.exec(resource)?.[1] ?? null;
}

const idLike = z.union([z.number().int().nonnegative(), z.string().regex(/^\d{1,25}$/)]).transform(String);

/** Somente os campos documentados são aceitos e guardados; o resto é descartado. */
export const notificationSchema = z.object({
  _id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional(),
  id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional(),
  resource: z.string().min(2).max(300).regex(/^\/[A-Za-z0-9_\-/]+$/).refine((r) => !r.includes(".."), "resource inválido"),
  user_id: idLike,
  topic: z.string().min(1).max(60).regex(/^[a-z0-9_-]+$/i),
  application_id: idLike,
  attempts: z.number().int().min(0).max(10_000).optional(),
  sent: z.string().max(40).optional(),
  received: z.string().max(40).optional(),
  actions: z.array(z.string().max(60)).max(20).optional(),
});
export type Notification = z.infer<typeof notificationSchema>;

export type IngestOutcome =
  | { outcome: "stored"; id: string; status: "PENDING" | "IGNORED"; lane: Lane | null; reason?: string }
  | { outcome: "duplicate"; id: string | null }
  | { outcome: "rejected"; httpStatus: 400 | 403; reason: string };

const SELLER_CACHE_MS = 60_000;
let sellerCache: { id: string | null; at: number } | null = null;

/** Conta conectada (cache curto: o webhook precisa responder em < 500 ms). */
async function connectedSellerId(): Promise<string | null> {
  if (sellerCache && Date.now() - sellerCache.at < SELLER_CACHE_MS) return sellerCache.id;
  const conn = await getStore().getCurrentConnection();
  const id = conn && conn.status === "ACTIVE" && conn.refreshTokenEnc ? conn.meliUserId : null;
  sellerCache = { id, at: Date.now() };
  return id;
}

export function resetSellerCacheForTests() {
  sellerCache = null;
}

function parseDate(v: string | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function eventKey(n: Notification): string {
  const mlId = n._id ?? n.id;
  if (mlId) return mlId;
  return `h:${createHash("sha256").update([n.topic, n.resource, n.user_id, n.sent ?? "", (n.actions ?? []).join(",")].join("|")).digest("hex").slice(0, 40)}`;
}

/**
 * Valida e grava a notificação. Só retorna depois do INSERT confirmado (ou de identificar duplicata);
 * qualquer falha de banco é propagada para o webhook responder erro e o ML reenviar.
 */
export async function ingestNotification(
  sql: Sql,
  body: unknown,
  opts: { source?: "webhook" | "missed_feeds" | "manual" | "derived"; eventId?: string } = {},
): Promise<IngestOutcome> {
  const parsed = notificationSchema.safeParse(body);
  if (!parsed.success) return { outcome: "rejected", httpStatus: 400, reason: "invalid_payload" };
  const n = parsed.data;
  if (n.application_id !== getEnv().MELI_CLIENT_ID) return { outcome: "rejected", httpStatus: 403, reason: "unknown_application" };

  const seller = await connectedSellerId();
  const lane = TOPIC_LANES[n.topic] ?? null;
  let status: "PENDING" | "IGNORED" = "PENDING";
  let reason: string | undefined;
  if (!lane) [status, reason] = ["IGNORED", "unsupported_topic"];
  else if (!seller || seller !== n.user_id) [status, reason] = ["IGNORED", "unknown_seller"];
  else if (!resourceId(n.topic, n.resource)) [status, reason] = ["IGNORED", "unrecognized_resource"];

  const payload = Object.fromEntries(Object.entries(n).filter(([, v]) => v !== undefined));
  const rows = await sql.query<{ id: string }>(
    `INSERT INTO marketplace_webhook_events (event_id, source, application_id, seller_id, topic, resource, actions, payload, ml_attempts,
       sent_at, status, ignored_reason, processed_at, max_attempts)
     VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::jsonb, $8::jsonb, $9::int, $10::timestamptz, $11::text, $12::text,
       CASE WHEN $11::text = 'IGNORED' THEN now() END, $13::int)
     ON CONFLICT (event_id) DO NOTHING RETURNING id::text AS id`,
    [
      opts.eventId ?? eventKey(n),
      opts.source ?? "webhook",
      n.application_id,
      n.user_id,
      n.topic,
      n.resource,
      JSON.stringify(n.actions ?? []),
      JSON.stringify(payload),
      n.attempts ?? null,
      parseDate(n.sent),
      status,
      reason ?? null,
      getMarketplaceConfig().eventMaxAttempts,
    ],
  );
  if (!rows.length) return { outcome: "duplicate", id: null };
  return { outcome: "stored", id: rows[0].id, status, lane: status === "PENDING" ? lane : null, reason };
}

export interface EventRow {
  id: string;
  eventId: string;
  source: string;
  topic: string;
  resource: string;
  sellerId: string | null;
  actions: string[];
  status: string;
  attempts: number;
  maxAttempts: number;
  receivedAt: Date;
  startedAt: Date | null;
  correlationId: string;
}

export interface HandlerResult {
  outcome: "completed" | "ignored";
  reason?: string;
  result?: Record<string, unknown>;
}

export type EventHandler = (sql: Sql, event: EventRow & { resourceId: string }) => Promise<HandlerResult>;

let handlersOverride: Partial<Record<string, EventHandler>> | null = null;

/** Somente testes: substitui os handlers por tópico. */
export function setEventHandlersForTesting(h: Partial<Record<string, EventHandler>> | null) {
  if (process.env.NODE_ENV !== "test") throw new Error("setEventHandlersForTesting só pode ser usado em testes");
  handlersOverride = h;
}

async function handlerFor(topic: string): Promise<EventHandler | undefined> {
  if (handlersOverride?.[topic]) return handlersOverride[topic];
  const { HANDLERS } = await import("./handlers");
  return HANDLERS[topic];
}

const EVENT_COLUMNS = `id::text AS id, event_id AS "eventId", source, topic, resource, seller_id AS "sellerId", actions, status, attempts,
  max_attempts AS "maxAttempts", received_at AS "receivedAt", started_at AS "startedAt", correlation_id::text AS "correlationId"`;

const EVENT_LOCK_SECONDS = 180;

/** Reserva o próximo evento devido da raia (inclusive um PROCESSING abandonado por worker que morreu). */
export async function claimNextEvent(sql: Sql, lane: Lane): Promise<EventRow | null> {
  const topics = Object.entries(TOPIC_LANES).filter(([, l]) => l === lane).map(([t]) => t);
  const rows = await sql.query<EventRow>(
    `UPDATE marketplace_webhook_events SET status = 'PROCESSING', attempts = attempts + 1, started_at = now(),
       locked_until = now() + make_interval(secs => $2::int)
     WHERE id = (
       SELECT id FROM marketplace_webhook_events
       WHERE topic = ANY($1::text[])
         AND ((status IN ('PENDING', 'RETRYING') AND next_attempt_at <= now()) OR (status = 'PROCESSING' AND locked_until < now()))
       ORDER BY next_attempt_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING ${EVENT_COLUMNS}`,
    [topics, EVENT_LOCK_SECONDS],
  );
  return rows[0] ?? null;
}

async function finishEvent(sql: Sql, ev: EventRow, status: "COMPLETED" | "IGNORED", r: HandlerResult, durationMs: number) {
  await sql.execute(
    `UPDATE marketplace_webhook_events SET status = $2::text, processed_at = now(), locked_until = NULL, duration_ms = $3::int,
       ignored_reason = $4::text, result = $5::jsonb, last_error = NULL, last_error_code = NULL
     WHERE id = $1::bigint AND status = 'PROCESSING'`,
    [ev.id, status, durationMs, r.reason ?? null, r.result ? JSON.stringify(r.result) : null],
  );
  // A leitura atual do recurso atende às notificações dele recebidas antes do início deste processamento.
  await sql.execute(
    `UPDATE marketplace_webhook_events SET status = 'COMPLETED', processed_at = now(), coalesced_into = $1::bigint,
       result = jsonb_build_object('coalesced', true), last_error = NULL, last_error_code = NULL
     WHERE topic = $2::text AND resource = $3::text AND id <> $1::bigint AND status IN ('PENDING', 'RETRYING')
       AND received_at <= $4::timestamptz`,
    [ev.id, ev.topic, ev.resource, ev.startedAt ?? new Date()],
  );
}

async function failEvent(sql: Sql, ev: EventRow, err: unknown, durationMs: number): Promise<"RETRYING" | "FAILED"> {
  const c = classifyError(err);
  const final = !c.retryable || ev.attempts >= ev.maxAttempts;
  const status = final ? "FAILED" : "RETRYING";
  const delay = backoffMs(ev.attempts, c.retryAfterMs);
  await sql.execute(
    `INSERT INTO marketplace_event_processing_errors (event_id, attempt, error_code, error_message, http_status, retryable)
     VALUES ($1::bigint, $2::int, $3::text, $4::text, $5::int, $6::boolean)`,
    [ev.id, ev.attempts, c.code, c.message, c.httpStatus, c.retryable],
  );
  await sql.execute(
    `UPDATE marketplace_webhook_events SET status = $2::text, locked_until = NULL, duration_ms = $3::int, last_error_code = $4::text,
       last_error = $5::text, next_attempt_at = now() + make_interval(secs => $6::int), processed_at = CASE WHEN $2::text = 'FAILED' THEN now() END
     WHERE id = $1::bigint AND status = 'PROCESSING'`,
    [ev.id, status, durationMs, c.code, c.message, Math.ceil(delay / 1000)],
  );
  const meta = { eventId: ev.id, correlationId: ev.correlationId, topic: ev.topic, attempt: ev.attempts, code: c.code };
  if (final) {
    logger.error("Evento do Mercado Livre falhou definitivamente (dead-letter)", meta);
    await raiseAlert(sql, "event_failed", `Evento ${ev.topic} ${ev.resource} falhou após ${ev.attempts} tentativa(s): ${c.code}`, meta);
  } else {
    logger.warn("Falha ao processar evento do Mercado Livre; nova tentativa agendada", { ...meta, retryInSec: Math.ceil(delay / 1000) });
  }
  return status;
}

/** Processa um evento já reservado. Nunca lança. */
export async function processClaimedEvent(sql: Sql, ev: EventRow): Promise<string> {
  const started = Date.now();
  try {
    if (ev.attempts > ev.maxAttempts) {
      await failEvent(sql, ev, new Error("Limite de tentativas excedido (processamento interrompido repetidamente)"), 0);
      return "FAILED";
    }
    // Nunca processa recurso de uma conta que não é a conectada (inclusive em reprocessamento).
    if (ev.sellerId !== (await connectedSellerId())) {
      await finishEvent(sql, ev, "IGNORED", { outcome: "ignored", reason: "unknown_seller" }, Date.now() - started);
      return "IGNORED";
    }
    const id = resourceId(ev.topic, ev.resource);
    const handler = await handlerFor(ev.topic);
    if (!id || !handler) {
      await finishEvent(sql, ev, "IGNORED", { outcome: "ignored", reason: id ? "unsupported_topic" : "unrecognized_resource" }, Date.now() - started);
      return "IGNORED";
    }
    const r = await handler(sql, { ...ev, resourceId: id });
    const status = r.outcome === "ignored" ? "IGNORED" : "COMPLETED";
    await finishEvent(sql, ev, status, r, Date.now() - started);
    logger.info("Evento do Mercado Livre processado", { eventId: ev.id, correlationId: ev.correlationId, topic: ev.topic, status, ms: Date.now() - started });
    return status;
  } catch (err) {
    try {
      return await failEvent(sql, ev, err, Date.now() - started);
    } catch (inner) {
      logger.error("Falha ao registrar erro de evento", { eventId: ev.id, err: inner });
      return "ERROR";
    }
  }
}

export interface ProcessEventsResult {
  processed: number;
  byStatus: Record<string, number>;
  busyLanes: Lane[];
  more: boolean;
}

/** Processa as raias em paralelo, cada uma em série e com seu lease, até o orçamento de tempo. */
export async function processEvents(opts: { sql?: Sql; budgetMs?: number; lanes?: Lane[] } = {}): Promise<ProcessEventsResult> {
  const sql = opts.sql ?? getSql();
  const budget = opts.budgetMs ?? 20_000;
  const started = Date.now();
  const lanes = opts.lanes ?? (["listings", "orders", "shipments"] as Lane[]);
  const out: ProcessEventsResult = { processed: 0, byStatus: {}, busyLanes: [], more: false };
  await Promise.all(
    lanes.map(async (lane) => {
      const owner = randomUUID();
      const leaseName = `ml-events:${lane}`;
      if (!(await acquireLease(sql, owner, leaseName))) {
        out.busyLanes.push(lane);
        return;
      }
      try {
        while (Date.now() - started < budget) {
          const ev = await claimNextEvent(sql, lane);
          if (!ev) return;
          const status = await processClaimedEvent(sql, ev);
          out.processed++;
          out.byStatus[status] = (out.byStatus[status] ?? 0) + 1;
          if (!(await renewLease(sql, owner, leaseName))) return;
        }
        out.more = true;
      } finally {
        await releaseLease(sql, owner, leaseName).catch(() => undefined);
      }
    }),
  );
  return out;
}

/** Volta um evento para a fila (reprocessamento administrativo). Não reprocessa eventos em andamento. */
export async function reprocessEvent(sql: Sql, id: string): Promise<boolean> {
  const n = await sql.execute(
    `UPDATE marketplace_webhook_events SET status = 'PENDING', attempts = 0, next_attempt_at = now(), locked_until = NULL,
       last_error = NULL, last_error_code = NULL, ignored_reason = NULL, processed_at = NULL, result = NULL, coalesced_into = NULL
     WHERE id = $1::bigint AND status IN ('FAILED', 'IGNORED', 'COMPLETED')
       AND topic = ANY($2::text[]) AND seller_id IS NOT NULL`,
    [id, SUPPORTED_TOPICS],
  );
  return n > 0;
}

/** Recoloca na fila todos os eventos em FAILED (dead-letter). */
export async function reprocessFailed(sql: Sql): Promise<number> {
  return sql.execute(
    `UPDATE marketplace_webhook_events SET status = 'PENDING', attempts = 0, next_attempt_at = now(), locked_until = NULL,
       last_error = NULL, last_error_code = NULL, processed_at = NULL
     WHERE status = 'FAILED'`,
  );
}

/** Enfileira um evento interno (ex.: pedido descoberto por um envio ou pela varredura de recuperação). */
export async function enqueueDerived(sql: Sql, e: { topic: string; resource: string; sellerId: string; key: string }): Promise<boolean> {
  const rows = await sql.query<{ id: string }>(
    `INSERT INTO marketplace_webhook_events (event_id, source, application_id, seller_id, topic, resource, payload, max_attempts)
     VALUES ($1::text, 'derived', $2::text, $3::text, $4::text, $5::text, $6::jsonb, $7::int)
     ON CONFLICT (event_id) DO NOTHING RETURNING id::text AS id`,
    [
      `derived:${e.key}`.slice(0, 200),
      getEnv().MELI_CLIENT_ID,
      e.sellerId,
      e.topic,
      e.resource,
      JSON.stringify({ topic: e.topic, resource: e.resource, user_id: e.sellerId, derived: true }),
      getMarketplaceConfig().eventMaxAttempts,
    ],
  );
  return rows.length > 0;
}

export interface EventListItem {
  id: string;
  eventId: string;
  source: string;
  topic: string;
  resource: string;
  actions: string[];
  status: string;
  attempts: number;
  maxAttempts: number;
  receivedAt: Date;
  sentAt: Date | null;
  processedAt: Date | null;
  nextAttemptAt: Date;
  durationMs: number | null;
  lastErrorCode: string | null;
  lastError: string | null;
  ignoredReason: string | null;
  result: unknown;
  coalescedInto: string | null;
  correlationId: string;
}

export async function listEvents(sql: Sql, opts: { status?: string; topic?: string; q?: string; page?: number; pageSize?: number } = {}) {
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 200);
  const page = Math.max(opts.page ?? 1, 1);
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.status) {
    params.push(opts.status);
    where.push(`status = $${params.length}::text`);
  }
  if (opts.topic) {
    params.push(opts.topic);
    where.push(`topic = $${params.length}::text`);
  }
  if (opts.q?.trim()) {
    params.push(`%${opts.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    where.push(`resource ILIKE $${params.length}`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [{ total }] = await sql.query<{ total: number }>(`SELECT count(*)::int AS total FROM marketplace_webhook_events ${clause}`, params);
  params.push(pageSize, (page - 1) * pageSize);
  const items = await sql.query<EventListItem>(
    `SELECT id::text AS id, event_id AS "eventId", source, topic, resource, actions, status, attempts, max_attempts AS "maxAttempts",
            received_at AS "receivedAt", sent_at AS "sentAt", processed_at AS "processedAt", next_attempt_at AS "nextAttemptAt",
            duration_ms AS "durationMs", last_error_code AS "lastErrorCode", last_error AS "lastError", ignored_reason AS "ignoredReason",
            result, coalesced_into::text AS "coalescedInto", correlation_id::text AS "correlationId"
     FROM marketplace_webhook_events ${clause} ORDER BY id DESC LIMIT $${params.length - 1}::int OFFSET $${params.length}::int`,
    params,
  );
  return { items, total, page, pageSize };
}

export async function getEventErrors(sql: Sql, id: string) {
  return sql.query<{ attempt: number; errorCode: string; errorMessage: string; httpStatus: number | null; retryable: boolean; createdAt: Date }>(
    `SELECT attempt, error_code AS "errorCode", error_message AS "errorMessage", http_status AS "httpStatus", retryable, created_at AS "createdAt"
     FROM marketplace_event_processing_errors WHERE event_id = $1::bigint ORDER BY id DESC LIMIT 50`,
    [id],
  );
}
