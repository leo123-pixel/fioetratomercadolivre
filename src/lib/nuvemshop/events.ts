import "server-only";
import { after } from "next/server";
import { getEnv } from "../env";
import { logger, redactString } from "../logger";
import { raiseAlert } from "../marketplace/alerts";
import { sha256Hex } from "../crypto";
import { getSql, type Sql } from "../sql";
import { NuvemshopApiError, type NuvemshopApiClient } from "./client";
import { fetchOrder, upsertOrder } from "./orders";
import { markProductRemoved, refreshProducts, stockAt } from "./remote-state";
import { clientForConnectedStore, type StoreRow } from "./store";
import { issueWritePermit } from "./write-gate";
import type { WorkerDeps } from "./write-jobs";

/**
 * Webhooks Nuvemshop (pedidos e produtos) — persistidos ANTES do processamento.
 *
 * Endpoint: POST /api/webhooks/nuvemshop/events. A assinatura x-linkedstore-hmac-sha256 (HMAC-SHA256 do corpo com o
 * segredo do aplicativo) é verificada; o evento é gravado e a resposta sai em milissegundos (a Nuvemshop exige 2xx
 * em até 3 s). O processamento roda depois, na fila (lote curto após a resposta e no tick do agendador).
 *
 * O payload traz só {store_id, event, id[, event_launch_ts]}: o pedido/produto é RELIDO na API. A ordem de entrega
 * não é garantida e há duplicatas: o processamento é idempotente e uma leitura mais antiga nunca substitui a mais nova.
 *
 * Sem loop Inventory Core ↔ Nuvemshop: um product/updated nunca gera escrita diretamente. Ele só atualiza o
 * catálogo local; se a quantidade lida é a última que o integrador escreveu, o evento é o eco da nossa escrita
 * (origem INTEGRATOR); se é outra (venda, edição manual), a variante é marcada para reavaliação na próxima execução,
 * que compara o estado atual antes de enfileirar qualquer escrita.
 */
export const EVENTS_PATH = "/api/webhooks/nuvemshop/events";
export const SUBSCRIBED_EVENTS = ["order/created", "order/updated", "product/created", "product/updated", "product/deleted"] as const;
const MAX_ATTEMPTS = 8;

export interface WebhookPayload {
  store_id?: number | string;
  event?: string;
  id?: number | string;
  event_launch_ts?: number | string;
}

export async function recordWebhookEvent(sql: Sql, raw: string, payload: WebhookPayload, now = new Date()): Promise<{ stored: boolean; id: string | null; reason?: string }> {
  const storeId = payload.store_id !== undefined ? String(payload.store_id) : "";
  const event = typeof payload.event === "string" ? payload.event : "";
  if (!/^\d{1,20}$/.test(storeId) || !/^[a-z_]+\/[a-z_]+$/.test(event)) return { stored: false, id: null, reason: "payload inválido" };
  const resourceId = payload.id !== undefined && /^\d{1,20}$/.test(String(payload.id)) ? String(payload.id) : null;
  const ts = payload.event_launch_ts !== undefined && /^\d{1,13}$/.test(String(payload.event_launch_ts)) ? String(payload.event_launch_ts) : null;
  // Sem event_launch_ts, reenvios idênticos chegam minutos depois: agrupa por janela de 1 min (o processamento é idempotente).
  const dedup = `${storeId}:${event}:${resourceId ?? "-"}:${ts ?? `w${Math.floor(now.getTime() / 60_000)}`}`;
  const [row] = await sql.query<{ id: string }>(
    `INSERT INTO nuvemshop_webhook_events (store_id, event, resource_id, event_ts, dedup_key, body_hash) VALUES ($1, $2, $3, $4::bigint, $5, $6)
     ON CONFLICT (dedup_key) DO NOTHING RETURNING id::text AS id`,
    [storeId, event, resourceId, ts, dedup, sha256Hex(raw)],
  );
  return row ? { stored: true, id: row.id } : { stored: false, id: null, reason: "duplicado" };
}

interface EventRow {
  id: string;
  storeId: string;
  event: string;
  resourceId: string | null;
  attempts: number;
}

/** Processa a fila de webhooks (FOR UPDATE SKIP LOCKED: vários workers não pegam o mesmo evento). */
export async function processWebhookEvents(sql: Sql, opts: { deadline?: number; deps?: WorkerDeps; limit?: number } = {}): Promise<{ processed: number; failed: number; ignored: number }> {
  const deadline = opts.deadline ?? Date.now() + 20_000;
  const out = { processed: 0, failed: 0, ignored: 0 };
  let conn: { store: StoreRow; client: NuvemshopApiClient } | null = null;
  while (Date.now() < deadline - 3_000 && out.processed + out.failed + out.ignored < (opts.limit ?? 200)) {
    const batch = await sql.transaction(async (tx) => {
      const rows = await tx.query<EventRow>(
        `SELECT id::text AS id, store_id AS "storeId", event, resource_id AS "resourceId", attempts FROM nuvemshop_webhook_events
         WHERE (status = 'PENDING' OR (status = 'PROCESSING' AND locked_until < now())) AND next_run_at <= now() ORDER BY id LIMIT 10 FOR UPDATE SKIP LOCKED`,
      );
      if (rows.length) await tx.execute(`UPDATE nuvemshop_webhook_events SET status = 'PROCESSING', locked_until = now() + interval '2 minutes', attempts = attempts + 1 WHERE id = ANY($1::bigint[])`, [rows.map((r) => r.id)]);
      return rows;
    });
    if (!batch.length) break;
    for (const e of batch) {
      try {
        conn ??= opts.deps?.client ?? (await clientForConnectedStore(sql, { fetchImpl: opts.deps?.fetchImpl, sleep: opts.deps?.sleep, maxRetries: opts.deps?.maxRetries }));
        if (conn.store.storeId !== e.storeId) {
          await sql.execute(`UPDATE nuvemshop_webhook_events SET status = 'IGNORED', processed_at = now(), result = '{"reason":"outra loja"}'::jsonb WHERE id = $1::bigint`, [e.id]);
          out.ignored++;
          continue;
        }
        const result = await handleEvent(sql, conn, e);
        await sql.execute(`UPDATE nuvemshop_webhook_events SET status = $2, processed_at = now(), locked_until = NULL, last_error = NULL, result = $3::jsonb WHERE id = $1::bigint`, [e.id, result.ignored ? "IGNORED" : "COMPLETED", JSON.stringify(result)]);
        if (result.ignored) out.ignored++;
        else out.processed++;
      } catch (err) {
        const api = err instanceof NuvemshopApiError ? err : null;
        const attempts = e.attempts + 1;
        const giveUp = attempts >= MAX_ATTEMPTS || (api !== null && !api.retryable && api.kind !== "unauthorized");
        const wait = Math.min(3600, 30 * 2 ** (attempts - 1));
        await sql.execute(
          `UPDATE nuvemshop_webhook_events SET status = $2, locked_until = NULL, last_error = $3, next_run_at = now() + make_interval(secs => $4::int),
             processed_at = CASE WHEN $2 = 'FAILED' THEN now() ELSE NULL END WHERE id = $1::bigint`,
          [e.id, giveUp ? "FAILED" : "PENDING", redactString((err as Error).message ?? "erro").slice(0, 500), wait],
        );
        out.failed++;
        if (giveUp) await raiseAlert(sql, `nuvemshop_webhook_failed:${e.event}`, `Webhook Nuvemshop ${e.event} (${e.resourceId}) falhou definitivamente: a reconciliação periódica cobre o evento`, { eventId: e.id });
        if (api?.kind === "unauthorized") break;
      }
    }
  }
  return out;
}

async function handleEvent(sql: Sql, conn: { store: StoreRow; client: NuvemshopApiClient }, e: EventRow): Promise<Record<string, unknown> & { ignored?: boolean }> {
  const storeId = conn.store.storeId;
  if (!e.resourceId) return { ignored: true, reason: "sem id do recurso" };
  if (e.event.startsWith("order/")) {
    const order = await fetchOrder(conn.client, e.resourceId);
    if (!order) return { ignored: true, reason: "pedido não encontrado" };
    const r = await upsertOrder(sql, storeId, order, "WEBHOOK");
    return { ...r };
  }
  if (e.event === "product/deleted") {
    const removed = await markProductRemoved(sql, storeId, e.resourceId);
    return { removedVariants: removed.length };
  }
  if (e.event === "product/created" || e.event === "product/updated") {
    const r = await refreshProducts(sql, conn.client, storeId, [e.resourceId]);
    let echoes = 0;
    let external = 0;
    for (const v of r.variants.values()) {
      if (v.removed) continue;
      const [state] = await sql.query<{ written: string | null; writtenAt: Date | null; locationId: string | null }>(
        `SELECT sv.last_written_value AS written, sv.last_written_at AS "writtenAt",
                (SELECT j.location_id FROM nuvemshop_write_jobs j WHERE j.id = sv.last_job_id) AS "locationId"
         FROM nuvemshop_sync_variants sv WHERE sv.store_id = $1 AND sv.variant_id = $2::bigint AND sv.kind = 'STOCK'`,
        [storeId, v.variantId],
      );
      if (!state?.written) continue;
      const now = stockAt(v, state.locationId);
      const echo = now !== null && String(now) === state.written && state.writtenAt && Date.now() - new Date(state.writtenAt).getTime() < 15 * 60_000;
      if (echo) {
        echoes++;
        await sql.execute(`UPDATE nuvemshop_sync_variants SET last_origin = 'INTEGRATOR_ECHO', last_remote_value = $3, updated_at = now() WHERE store_id = $1 AND variant_id = $2::bigint AND kind = 'STOCK'`, [storeId, v.variantId, String(now)]);
      } else {
        external++;
        await sql.execute(
          `UPDATE nuvemshop_sync_variants SET last_origin = 'EXTERNAL', last_remote_value = $3, dirty_at = now(), updated_at = now() WHERE store_id = $1 AND variant_id = $2::bigint AND kind = 'STOCK'`,
          [storeId, v.variantId, now === null ? null : String(now)],
        );
      }
    }
    return { variants: r.variants.size, removedProducts: r.removedProducts.length, echoes, external };
  }
  return { ignored: true, reason: "evento não tratado" };
}

/** URL pública do endpoint (exige https e host que não seja localhost, como a Nuvemshop pede). */
export function webhookUrl(): string {
  const url = new URL(EVENTS_PATH, getEnv().APP_BASE_URL);
  if (url.protocol !== "https:" || /^(localhost|127\.|\[::1\])/.test(url.hostname)) throw new NuvemshopApiError("bad_request", "Webhooks exigem APP_BASE_URL em https público (não localhost)");
  return url.toString();
}

/** Cadastra (ou confirma) os webhooks do integrador na loja. Idempotente: não duplica cadastros existentes. */
export async function registerWebhooks(sql: Sql, actor: string, deps: WorkerDeps = {}): Promise<{ created: string[]; existing: string[]; failed: { event: string; message: string }[] }> {
  const conn = deps.client ?? (await clientForConnectedStore(sql, { fetchImpl: deps.fetchImpl, sleep: deps.sleep, maxRetries: deps.maxRetries }));
  const url = webhookUrl();
  const permit = await issueWritePermit(sql, conn.store, "WEBHOOK", "POST /webhooks");
  const { data } = await conn.client.get<{ id: number; event: string; url: string }[]>("/webhooks", { url, per_page: 200 });
  const current = new Map((Array.isArray(data) ? data : []).filter((w) => w.url === url).map((w) => [w.event, w.id]));
  const out = { created: [] as string[], existing: [] as string[], failed: [] as { event: string; message: string }[] };
  for (const event of SUBSCRIBED_EVENTS) {
    let remoteId = current.get(event) ?? null;
    try {
      if (remoteId) out.existing.push(event);
      else {
        const res = await conn.client.send<{ id: number }>(permit, "POST", "/webhooks", { event, url }, { idempotent: false });
        remoteId = res.data?.id ?? null;
        out.created.push(event);
      }
      await sql.execute(
        `INSERT INTO nuvemshop_webhook_registrations (store_id, event, url, remote_id, status, last_error, registered_by, updated_at) VALUES ($1, $2, $3, $4::bigint, 'ACTIVE', NULL, $5, now())
         ON CONFLICT (store_id, event) DO UPDATE SET url = EXCLUDED.url, remote_id = EXCLUDED.remote_id, status = 'ACTIVE', last_error = NULL, registered_by = EXCLUDED.registered_by, updated_at = now()`,
        [conn.store.storeId, event, url, remoteId, actor],
      );
    } catch (err) {
      const message = (err as Error).message?.slice(0, 300) ?? "erro";
      out.failed.push({ event, message });
      await sql.execute(
        `INSERT INTO nuvemshop_webhook_registrations (store_id, event, url, status, last_error, registered_by, updated_at) VALUES ($1, $2, $3, 'FAILED', $4, $5, now())
         ON CONFLICT (store_id, event) DO UPDATE SET status = 'FAILED', last_error = EXCLUDED.last_error, updated_at = now()`,
        [conn.store.storeId, event, url, message, actor],
      );
      logger.warn("Falha ao cadastrar webhook Nuvemshop", { event, err: message });
    }
  }
  return out;
}

export async function webhookOverview(sql: Sql, storeId: string) {
  const registrations = await sql.query(`SELECT event, url, remote_id::text AS "remoteId", status, last_error AS "lastError", updated_at AS "updatedAt" FROM nuvemshop_webhook_registrations WHERE store_id = $1 ORDER BY event`, [storeId]);
  const [queue] = await sql.query<{ pending: number; failed: number; oldestPendingAt: Date | null; last24h: number }>(
    `SELECT count(*) FILTER (WHERE status IN ('PENDING', 'PROCESSING'))::int AS pending, count(*) FILTER (WHERE status = 'FAILED' AND received_at > now() - interval '7 days')::int AS failed,
            min(received_at) FILTER (WHERE status IN ('PENDING', 'PROCESSING')) AS "oldestPendingAt", count(*) FILTER (WHERE received_at > now() - interval '24 hours')::int AS last24h
     FROM nuvemshop_webhook_events WHERE store_id = $1`,
    [storeId],
  );
  return { registrations, queue };
}

let processor: () => void = () =>
  after(() =>
    processWebhookEvents(getSql(), { deadline: Date.now() + 20_000 }).then(
      () => undefined,
      (err) => logger.error("Falha ao processar webhooks Nuvemshop", { err }),
    ),
  );

/** Processa a fila logo depois da resposta HTTP do webhook (o agendador cobre o que sobrar). */
export function scheduleWebhookProcessing(): void {
  processor();
}

/** Somente testes. */
export function setNuvemshopEventProcessorForTesting(fn: (() => void) | null) {
  if (process.env.NODE_ENV !== "test") throw new Error("setNuvemshopEventProcessorForTesting só pode ser usado em testes");
  processor = fn ?? (() => undefined);
}
