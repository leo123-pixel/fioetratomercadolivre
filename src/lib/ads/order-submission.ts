import "server-only";
import { logger, redactString } from "../logger";
import type { Sql } from "../sql";
import { adsCall, AdsApiError, adsEnvironment, assertAdsWriteAllowed } from "./client";
import { externalIdForGroup, resolveOrderGroup } from "./order-group";
import { buildAdsOrder, sanitizePayload } from "./order-payload";

/**
 * Envio MANUAL de um pedido para a ADS (ambiente configurado), com idempotência local e remota:
 * - um envio vigente por pedido em cada ambiente (índice único parcial: SENDING/SENT/UNKNOWN);
 *   pack com vários pedidos = um envio só, gravado no pedido principal do pack (ver order-group.ts);
 * - produção só com ADS_PRODUCTION_WRITE_ENABLED=true (ver assertAdsWriteAllowed);
 * - antes do POST consulta GET /pedidos/{idExterno}: se já existe, só registra (não duplica);
 * - write-ahead (SENDING) antes do POST; 201 com pedidoId → SENT (só aí é considerado enviado);
 * - timeout/rede/5xx → UNKNOWN: nunca reenvia sozinho; a conciliação consulta o idExterno;
 * - 4xx → FAILED com a resposta registrada (o operador corrige e pode enviar de novo).
 * Nunca é chamado por webhook ou rotina automática.
 */
export class SubmissionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "SubmissionError";
  }
}

export interface Submission {
  id: string;
  orderId: string;
  externalId: string;
  environment: string;
  status: "SENDING" | "SENT" | "UNKNOWN" | "FAILED" | "CANCELED";
  adsPedidoId: number | null;
  adsStatus: string | null;
  attempts: number;
  requestedBy: string;
  lastError: string | null;
  sentAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  payload: unknown;
}

const COLS = `id::text AS id, order_id::text AS "orderId", external_id AS "externalId", environment, status, ads_pedido_id AS "adsPedidoId",
  ads_status AS "adsStatus", attempts, requested_by AS "requestedBy", last_error AS "lastError", sent_at AS "sentAt",
  completed_at AS "completedAt", created_at AS "createdAt", payload`;

async function logAttempt(sql: Sql, submissionId: string | null, orderInboxId: string, a: { operation: string; status?: number | null; request?: unknown; response?: unknown; error?: string | null; durationMs?: number | null }) {
  await sql.execute(
    `INSERT INTO ads_order_attempts (submission_id, order_id, operation, http_status, request, response, error, duration_ms, environment)
     VALUES ($1::uuid, $2::bigint, $3::text, $4::int, $5::jsonb, $6::jsonb, $7::text, $8::int, $9::text)`,
    [
      submissionId,
      orderInboxId,
      a.operation,
      a.status ?? null,
      a.request === undefined ? null : JSON.stringify(a.request),
      a.response === undefined ? null : JSON.stringify(a.response),
      a.error ? redactString(a.error).slice(0, 1000) : null,
      a.durationMs ?? null,
      adsEnvironment().environment,
    ],
  );
}

const ids = (v: string | string[]) => (Array.isArray(v) ? v : [v]);

/** Envios do pedido — ou de todos os pedidos do pack (o envio do pack fica no pedido principal). */
export async function listSubmissions(sql: Sql, orderInboxIds: string | string[]): Promise<Submission[]> {
  return sql.query<Submission>(`SELECT ${COLS} FROM ads_order_submissions WHERE order_id = ANY($1::bigint[]) ORDER BY created_at DESC`, [ids(orderInboxIds)]);
}

export async function listAttempts(sql: Sql, orderInboxIds: string | string[]) {
  return sql.query(
    `SELECT id::text AS id, submission_id::text AS "submissionId", operation, http_status AS "httpStatus", request, response, error,
            duration_ms AS "durationMs", created_at AS "createdAt"
     FROM ads_order_attempts WHERE order_id = ANY($1::bigint[]) ORDER BY id DESC LIMIT 100`,
    [ids(orderInboxIds)],
  );
}

async function activeSubmission(sql: Sql, orderInboxIds: string[]): Promise<Submission | null> {
  const [s] = await sql.query<Submission>(
    `SELECT ${COLS} FROM ads_order_submissions WHERE order_id = ANY($1::bigint[]) AND environment = $2::text AND status IN ('SENDING', 'SENT', 'UNKNOWN')
     ORDER BY created_at LIMIT 1`,
    [orderInboxIds, adsEnvironment().environment],
  );
  return s ?? null;
}

/** Consulta o pedido na ADS pelo idExterno. "found" só com pedidoId > 0; "unknown" quando a ADS não respondeu claramente. */
export async function lookupByExternalId(externalId: string): Promise<{ result: "found" | "not_found" | "unknown"; pedidoId: number | null; status: number | null; data: unknown; durationMs: number | null }> {
  try {
    const r = await adsCall<{ pedidoId?: number }>("GET", `pedidos/${encodeURIComponent(externalId)}`);
    const id = typeof r.data?.pedidoId === "number" && r.data.pedidoId > 0 ? r.data.pedidoId : null;
    if (r.status === 200 && id) return { result: "found", pedidoId: id, status: r.status, data: r.data, durationMs: r.durationMs };
    if (r.status === 404 || (r.status === 200 && !id)) return { result: "not_found", pedidoId: null, status: r.status, data: r.data, durationMs: r.durationMs };
    return { result: "unknown", pedidoId: null, status: r.status, data: r.data, durationMs: r.durationMs };
  } catch (err) {
    if (err instanceof AdsApiError && err.kind === "auth") throw err;
    return { result: "unknown", pedidoId: null, status: null, data: { error: err instanceof Error ? err.message : "erro" }, durationMs: null };
  }
}

/**
 * Envia o pedido. Exige: validação sem bloqueios, o MESMO payload que o operador visualizou (hash),
 * confirmação explícita e ambiente de homologação.
 */
export async function sendOrderToAds(sql: Sql, orderInboxId: string, opts: { payloadHash: string; requestedBy: string }): Promise<Submission> {
  assertAdsWriteAllowed();
  const env = adsEnvironment();
  // Pack com vários pedidos: um envio só, registrado no pedido principal, qualquer que seja a tela de origem.
  const group = await resolveOrderGroup(sql, orderInboxId);
  const active = await activeSubmission(sql, group.memberIds);
  if (active && active.externalId !== externalIdForGroup(group)) {
    throw new SubmissionError("member_already_sent", `Um pedido deste pack já foi enviado sozinho à ADS (idExterno ${active.externalId}); o restante precisa ser lançado direto no ADSNET`);
  }
  if (active?.status === "SENT") return active; // idempotente: já enviado
  if (active?.status === "UNKNOWN") throw new SubmissionError("needs_reconcile", "Envio anterior com resultado incerto: consulte o resultado na ADS antes de qualquer reenvio");
  if (active?.status === "SENDING") throw new SubmissionError("in_progress", "Envio em andamento");

  const built = await buildAdsOrder(sql, orderInboxId, { group });
  if (!built.ok || !built.payload) throw new SubmissionError("not_valid", "Pedido não passou na validação", built.issues.filter((i) => i.blocking));
  if (built.payloadHash !== opts.payloadHash) throw new SubmissionError("payload_changed", "Os dados do pedido mudaram desde a visualização: valide e confira de novo antes de enviar");
  const sanitized = sanitizePayload(built.payload);
  orderInboxId = group.leadId;

  // Idempotência remota: o idExterno já existe na ADS?
  const pre = await lookupByExternalId(built.externalId);
  await logAttempt(sql, null, orderInboxId, { operation: "PRECHECK", status: pre.status, request: { idExterno: built.externalId }, response: pre.data, durationMs: pre.durationMs });
  if (pre.result === "unknown") throw new SubmissionError("precheck_failed", "Não foi possível confirmar na ADS se o pedido já existe; tente novamente em instantes");

  let submission: Submission;
  try {
    [submission] = await sql.query<Submission>(
      `INSERT INTO ads_order_submissions (order_id, marketplace_order_id, external_id, environment, status, payload, payload_hash, requested_by, ads_pedido_id, sent_at, completed_at)
       VALUES ($1::bigint, $2::text, $3::text, $4::text, $5::text, $6::jsonb, $7::text, $8::text, $9::int, now(), CASE WHEN $5::text = 'SENT' THEN now() END)
       RETURNING ${COLS}`,
      [orderInboxId, built.marketplaceOrderId, built.externalId, env.environment, pre.result === "found" ? "SENT" : "SENDING", JSON.stringify(sanitized), built.payloadHash, opts.requestedBy, pre.pedidoId],
    );
  } catch (err) {
    if (/23505|unique/i.test((err as Error)?.message ?? "") || (err as { code?: string })?.code === "23505") throw new SubmissionError("in_progress", "Já existe um envio vigente para este pedido");
    throw err;
  }
  if (pre.result === "found") {
    await sql.execute(`UPDATE ads_order_submissions SET last_error = 'Pedido já existia na ADS com este idExterno (nenhum POST enviado)' WHERE id = $1::uuid`, [submission.id]);
    logger.warn("Pedido já existia na ADS; registrado sem novo POST", { orderInboxId, pedidoId: pre.pedidoId });
    return (await sql.query<Submission>(`SELECT ${COLS} FROM ads_order_submissions WHERE id = $1::uuid`, [submission.id]))[0];
  }

  await sql.execute(`UPDATE ads_order_submissions SET attempts = attempts + 1, updated_at = now() WHERE id = $1::uuid`, [submission.id]);
  let next: { status: Submission["status"]; pedidoId: number | null; error: string | null };
  try {
    const r = await adsCall<{ pedidoId?: number }>("POST", "pedidos", { body: built.payload, timeoutMs: 30_000 });
    await logAttempt(sql, submission.id, orderInboxId, { operation: "POST", status: r.status, request: sanitized, response: r.data, durationMs: r.durationMs });
    const pedidoId = typeof r.data?.pedidoId === "number" && r.data.pedidoId > 0 ? r.data.pedidoId : null;
    if (r.status === 201 && pedidoId) next = { status: "SENT", pedidoId, error: null };
    else if (r.status === 201 || r.status >= 500) next = { status: "UNKNOWN", pedidoId: null, error: `Resposta sem confirmação (HTTP ${r.status}); conciliar pelo idExterno` };
    else next = { status: "FAILED", pedidoId: null, error: redactString(`ADS recusou o pedido (HTTP ${r.status}): ${JSON.stringify(r.data).slice(0, 800)}`) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "erro";
    await logAttempt(sql, submission.id, orderInboxId, { operation: "POST", request: sanitized, error: msg });
    // Auth recusada: o pedido certamente não foi criado. Timeout/rede: resultado incerto.
    next = err instanceof AdsApiError && err.kind === "auth" ? { status: "FAILED", pedidoId: null, error: msg } : { status: "UNKNOWN", pedidoId: null, error: `${msg}: resultado incerto, conciliar pelo idExterno` };
  }
  await sql.execute(
    `UPDATE ads_order_submissions SET status = $2::text, ads_pedido_id = $3::int, last_error = $4::text,
       completed_at = CASE WHEN $2::text IN ('SENT', 'FAILED') THEN now() END, updated_at = now() WHERE id = $1::uuid`,
    [submission.id, next.status, next.pedidoId, next.error],
  );
  logger.info("Envio de pedido para a ADS", { orderInboxId, submissionId: submission.id, status: next.status, pedidoId: next.pedidoId, environment: env.environment });
  return (await sql.query<Submission>(`SELECT ${COLS} FROM ads_order_submissions WHERE id = $1::uuid`, [submission.id]))[0];
}

/** Concilia um envio incerto consultando o idExterno na ADS (nunca reenvia o POST). */
export async function reconcileSubmission(sql: Sql, orderInboxId: string): Promise<Submission> {
  const active = await activeSubmission(sql, (await resolveOrderGroup(sql, orderInboxId, { verify: false })).memberIds);
  if (!active) throw new SubmissionError("nothing_to_reconcile", "Nenhum envio vigente para conciliar");
  const r = await lookupByExternalId(active.externalId);
  await logAttempt(sql, active.id, active.orderId, { operation: "RECONCILE", status: r.status, request: { idExterno: active.externalId }, response: r.data, durationMs: r.durationMs });
  if (r.result === "found") {
    await sql.execute(
      `UPDATE ads_order_submissions SET status = 'SENT', ads_pedido_id = $2::int, last_error = NULL, completed_at = COALESCE(completed_at, now()), updated_at = now() WHERE id = $1::uuid`,
      [active.id, r.pedidoId],
    );
  } else if (r.result === "not_found" && active.status !== "SENT") {
    // Não chegou à ADS: o envio é encerrado e o operador pode enviar de novo.
    await sql.execute(
      `UPDATE ads_order_submissions SET status = 'FAILED', last_error = 'Conciliação: pedido não encontrado na ADS pelo idExterno; pode ser enviado novamente', completed_at = now(), updated_at = now() WHERE id = $1::uuid`,
      [active.id],
    );
  }
  return (await sql.query<Submission>(`SELECT ${COLS} FROM ads_order_submissions WHERE id = $1::uuid`, [active.id]))[0];
}

/** Situação do pedido na ADS (Em análise, Faturado, Nota Emitida...). Somente leitura. */
export async function refreshAdsStatus(sql: Sql, orderInboxId: string): Promise<Submission> {
  const active = await activeSubmission(sql, (await resolveOrderGroup(sql, orderInboxId, { verify: false })).memberIds);
  if (!active || active.status !== "SENT" || !active.adsPedidoId) throw new SubmissionError("not_sent", "Pedido ainda não confirmado na ADS");
  const r = await adsCall<{ pedidoId?: number; status?: string; nf?: number }[]>("GET", "pedidos/status", { query: { pedidoIds: [active.adsPedidoId] } });
  await logAttempt(sql, active.id, active.orderId, { operation: "STATUS", status: r.status, request: { pedidoIds: [active.adsPedidoId] }, response: r.data, durationMs: r.durationMs });
  const row = Array.isArray(r.data) ? r.data.find((x) => x.pedidoId === active.adsPedidoId) : undefined;
  if (row?.status) await sql.execute(`UPDATE ads_order_submissions SET ads_status = $2::text, updated_at = now() WHERE id = $1::uuid`, [active.id, String(row.status).slice(0, 60)]);
  return (await sql.query<Submission>(`SELECT ${COLS} FROM ads_order_submissions WHERE id = $1::uuid`, [active.id]))[0];
}
