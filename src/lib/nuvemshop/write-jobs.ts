import "server-only";
import { randomUUID } from "node:crypto";
import { acquireLease, releaseLease, renewLease } from "../imports/jobs";
import { logger, redactString } from "../logger";
import { raiseAlert } from "../marketplace/alerts";
import { isUniqueViolation, type Sql } from "../sql";
import { AutomationError, cancelPendingJobs, getAutomation, type AutomationKind } from "./automation";
import { NuvemshopApiError, type NuvemshopApiClient } from "./client";
import { cents, refreshProducts, stockAt, type RemoteVariantState } from "./remote-state";
import { clientForConnectedStore, recordStoreError, type StoreRow } from "./store";
import { getEmergencyStop, issueWritePermit } from "./write-gate";

/**
 * Fila persistente de escritas na Nuvemshop (preço e estoque) — uma linha por variante.
 *
 * Garantias:
 *  - um único job ativo por SKU × canal × localização (índice único parcial em lock_key), inclusive enquanto o
 *    resultado está incerto ou aguardando reconciliação: dois sincronizadores nunca escrevem o mesmo estoque;
 *  - um único worker por vez (lease "nuvemshop-writer");
 *  - antes de enviar: modo da automação, desligamento de emergência, validade do job e releitura remota
 *    (compare-and-set: se o valor remoto mudou desde o cálculo, o job é SUPERSEDED e o próximo ciclo recalcula);
 *  - envio em lote pelo PATCH /products/stock-price (até 50 variantes), decreases antes de increases;
 *  - depois: releitura e confirmação por variante. Resultado incerto (timeout, rede, 5xx) NUNCA é reenviado às
 *    cegas no estoque: fica UNCERTAIN e é resolvido por leitura (aplicado, não aplicado ou reconciliação).
 */
export const WRITER_LEASE = "nuvemshop-writer";
const BATCH_LIMIT = 50;
const STOCK_JOB_TTL_MIN = 10;
const PRICE_JOB_TTL_MIN = 30;

export type JobStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "UNCERTAIN" | "REQUIRES_RECONCILIATION" | "SUPERSEDED" | "CANCELED";

export interface WriteJob {
  id: string;
  kind: AutomationKind;
  storeId: string;
  nsProductId: string;
  variantId: string;
  locationId: string | null;
  lockKey: string;
  status: JobStatus;
  mode: "PILOT" | "AUTOMATIC" | "MANUAL";
  expectedValue: string | null;
  targetValue: string;
  direction: "INCREASE" | "DECREASE" | "NONE" | null;
  isolate: boolean;
  attempts: number;
  maxAttempts: number;
  expiresAt: Date;
  createdBy: string;
}

const cols = (t = "") => `${t}id::text AS id, ${t}kind, ${t}store_id AS "storeId", ${t}nuvemshop_product_id::text AS "nsProductId", ${t}variant_id::text AS "variantId", ${t}location_id AS "locationId",
  ${t}lock_key AS "lockKey", ${t}status, ${t}mode, ${t}expected_value AS "expectedValue", ${t}target_value AS "targetValue", ${t}direction, ${t}isolate, ${t}attempts,
  ${t}max_attempts AS "maxAttempts", ${t}expires_at AS "expiresAt", ${t}created_by AS "createdBy"`;
const COLS = cols();

export const lockKeyOf = (kind: AutomationKind, storeId: string, variantId: string, locationId: string | null) =>
  kind === "STOCK" ? `stock:${storeId}:${variantId}:${locationId ?? "default"}` : `price:${storeId}:${variantId}`;

export interface EnqueueInput {
  kind: AutomationKind;
  storeId: string;
  nsProductId: string;
  variantId: string;
  locationId: string | null;
  expected: string | null;
  target: string;
  mode: "PILOT" | "AUTOMATIC" | "MANUAL";
  runId: string | null;
  sourceVersion?: string | null;
  createdBy: string;
  approvedBy?: string | null;
}

export type EnqueueResult = { created: true; jobId: string } | { created: false; reason: "ACTIVE_JOB" | "EMERGENCY_STOP"; jobId?: string };

/** Cria a escrita (idempotente por execução × variante). Recusa com desligamento de emergência ativo. */
export async function enqueueWrite(sql: Sql, input: EnqueueInput): Promise<EnqueueResult> {
  const stop = await getEmergencyStop(sql);
  if (stop.active) return { created: false, reason: "EMERGENCY_STOP" };
  const lockKey = lockKeyOf(input.kind, input.storeId, input.variantId, input.locationId);
  const idem = `${lockKey}:${input.runId ?? randomUUID()}:${input.target}`;
  const ttl = input.kind === "STOCK" ? STOCK_JOB_TTL_MIN : PRICE_JOB_TTL_MIN;
  const direction = input.expected === null ? null : Number(input.target) > Number(input.expected) ? "INCREASE" : Number(input.target) < Number(input.expected) ? "DECREASE" : "NONE";
  try {
    const [row] = await sql.query<{ id: string }>(
      `INSERT INTO nuvemshop_write_jobs (kind, store_id, nuvemshop_product_id, variant_id, location_id, lock_key, mode, run_id, expected_value, target_value, direction,
         source_version, expires_at, idempotency_key, created_by, approved_by)
       VALUES ($1, $2, $3::bigint, $4::bigint, $5, $6, $7, $8::uuid, $9, $10, $11, $12, now() + make_interval(mins => $13::int), $14, $15, $16)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING id::text AS id`,
      [input.kind, input.storeId, input.nsProductId, input.variantId, input.locationId, lockKey, input.mode, input.runId, input.expected, input.target, direction, input.sourceVersion ?? null, ttl, idem, input.createdBy, input.approvedBy ?? null],
    );
    if (!row) return { created: false, reason: "ACTIVE_JOB" };
    return { created: true, jobId: row.id };
  } catch (err) {
    if (isUniqueViolation(err)) {
      const [active] = await sql.query<{ id: string }>(
        `SELECT id::text AS id FROM nuvemshop_write_jobs WHERE lock_key = $1 AND status IN ('PENDING', 'RUNNING', 'UNCERTAIN', 'REQUIRES_RECONCILIATION')`,
        [lockKey],
      );
      return { created: false, reason: "ACTIVE_JOB", jobId: active?.id };
    }
    throw err;
  }
}

/** Valor remoto atual do que o job escreve (texto comparável com expected/target). */
export function remoteValueOf(job: Pick<WriteJob, "kind" | "locationId">, v: RemoteVariantState | undefined): string | null {
  if (!v || v.removed) return null;
  if (job.kind === "PRICE") {
    const c = cents(v.price);
    return c === null ? null : String(c);
  }
  const s = stockAt(v, job.locationId);
  return s === null ? null : String(s);
}

async function finish(
  sql: Sql,
  job: WriteJob,
  status: JobStatus,
  outcome: string,
  extra: { message?: string | null; code?: string | null; httpStatus?: number | null; before?: string | null; after?: string | null; verified?: boolean; batchId?: string; batchSize?: number; durationMs?: number } = {},
) {
  const done = ["SUCCEEDED", "FAILED", "SUPERSEDED", "CANCELED"].includes(status);
  await sql.execute(
    `UPDATE nuvemshop_write_jobs SET status = $2, verified = $3, observed_after = COALESCE($4, observed_after), error_code = $5, error_message = $6,
       finished_at = CASE WHEN $7::boolean THEN now() ELSE finished_at END, updated_at = now() WHERE id = $1::uuid`,
    [job.id, status, extra.verified ?? false, extra.after ?? null, extra.code ?? null, extra.message ? redactString(extra.message).slice(0, 500) : null, done],
  );
  await sql.execute(
    `INSERT INTO nuvemshop_write_attempts (job_id, attempt, batch_id, batch_size, outcome, http_status, error_code, message, observed_before, observed_after, duration_ms)
     VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [job.id, job.attempts, extra.batchId ?? null, extra.batchSize ?? null, outcome, extra.httpStatus ?? null, extra.code ?? null, extra.message ? redactString(extra.message).slice(0, 500) : null, extra.before ?? null, extra.after ?? null, extra.durationMs ?? null],
  );
  if (status === "SUCCEEDED") {
    await sql.execute(
      `INSERT INTO nuvemshop_sync_variants (store_id, variant_id, kind, last_written_value, last_written_at, last_verified_at, last_job_id, last_origin, last_remote_value)
       VALUES ($1, $2::bigint, $3, $4, now(), CASE WHEN $5::boolean THEN now() END, $6::uuid, 'INTEGRATOR', $7)
       ON CONFLICT (store_id, variant_id, kind) DO UPDATE SET last_written_value = EXCLUDED.last_written_value, last_written_at = now(),
         last_verified_at = CASE WHEN $5::boolean THEN now() ELSE nuvemshop_sync_variants.last_verified_at END, last_job_id = EXCLUDED.last_job_id,
         last_origin = 'INTEGRATOR', last_remote_value = EXCLUDED.last_remote_value, updated_at = now()`,
      [job.storeId, job.variantId, job.kind, job.targetValue, extra.verified ?? false, job.id, extra.after ?? null],
    );
  }
  if (status === "SUPERSEDED") {
    await sql.execute(
      `INSERT INTO nuvemshop_sync_variants (store_id, variant_id, kind, dirty_at, last_remote_value) VALUES ($1, $2::bigint, $3, now(), $4)
       ON CONFLICT (store_id, variant_id, kind) DO UPDATE SET dirty_at = now(), last_remote_value = EXCLUDED.last_remote_value, updated_at = now()`,
      [job.storeId, job.variantId, job.kind, extra.before ?? null],
    );
  }
}

function bodyFor(jobs: WriteJob[], multiLocation: boolean): unknown[] {
  const byProduct = new Map<string, Record<string, unknown>[]>();
  // Reduções primeiro: se o lote for interrompido, o que entrou só diminui exposição.
  const ordered = [...jobs].sort((a, b) => (a.direction === "DECREASE" ? 0 : 1) - (b.direction === "DECREASE" ? 0 : 1));
  for (const j of ordered) {
    const list = byProduct.get(j.nsProductId) ?? [];
    if (j.kind === "PRICE") list.push({ id: Number(j.variantId), price: Number((Number(j.targetValue) / 100).toFixed(2)) });
    else list.push({ id: Number(j.variantId), inventory_levels: [multiLocation && j.locationId ? { location_id: j.locationId, stock: Number(j.targetValue) } : { stock: Number(j.targetValue) }] });
    byProduct.set(j.nsProductId, list);
  }
  return [...byProduct.entries()].map(([id, variants]) => ({ id: Number(id), variants }));
}

/** Resposta do PATCH stock-price: [{id, variants:[{id, success}]}]. */
function successByVariant(data: unknown): Map<string, boolean> {
  const out = new Map<string, boolean>();
  if (!Array.isArray(data)) return out;
  for (const p of data as { variants?: { id?: number | string; success?: boolean }[] }[]) {
    for (const v of p?.variants ?? []) if (v?.id !== undefined) out.set(String(v.id), v.success === true);
  }
  return out;
}

export interface WorkerDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  client?: { store: StoreRow; client: NuvemshopApiClient };
}

export interface WorkerResult {
  busy: boolean;
  processed: number;
  succeeded: number;
  failed: number;
  uncertain: number;
  superseded: number;
  canceled: number;
  batches: number;
  stoppedReason: string | null;
}

/** Processa a fila de escritas (um worker por vez). */
export async function processWriteJobs(sql: Sql, opts: { deadline?: number; deps?: WorkerDeps } = {}): Promise<WorkerResult> {
  const result: WorkerResult = { busy: false, processed: 0, succeeded: 0, failed: 0, uncertain: 0, superseded: 0, canceled: 0, batches: 0, stoppedReason: null };
  const owner = randomUUID();
  if (!(await acquireLease(sql, owner, WRITER_LEASE))) return { ...result, busy: true };
  const deadline = opts.deadline ?? Date.now() + 40_000;
  try {
    // Job RUNNING deixado por um worker que morreu: o resultado é desconhecido → conferir por leitura.
    await sql.execute(
      `UPDATE nuvemshop_write_jobs SET status = 'UNCERTAIN', error_code = 'INTERRUPTED', error_message = 'Worker interrompido durante a escrita', updated_at = now()
       WHERE status = 'RUNNING' AND started_at < now() - interval '2 minutes'`,
    );
    await sql.execute(
      `UPDATE nuvemshop_write_jobs SET status = 'CANCELED', error_code = 'EXPIRED', error_message = 'Escrita expirou antes de ser executada (dados recalculados no próximo ciclo)', finished_at = now(), updated_at = now()
       WHERE status = 'PENDING' AND expires_at < now()`,
    );
    let conn: { store: StoreRow; client: NuvemshopApiClient } | null = null;
    while (Date.now() < deadline - 8_000) {
      const stop = await getEmergencyStop(sql);
      if (stop.active) {
        result.canceled += await cancelPendingJobs(sql, null, `Desligamento de emergência: ${stop.reason ?? ""}`);
        result.stoppedReason = "emergency_stop";
        break;
      }
      const jobs = await claimBatch(sql);
      if (!jobs.length) break;
      await renewLease(sql, owner, WRITER_LEASE);
      conn ??= opts.deps?.client ?? (await clientForConnectedStore(sql, { fetchImpl: opts.deps?.fetchImpl, sleep: opts.deps?.sleep, maxRetries: opts.deps?.maxRetries }));
      await runBatch(sql, conn, jobs, result);
      result.batches++;
    }
    return result;
  } finally {
    await releaseLease(sql, owner, WRITER_LEASE).catch(() => undefined);
  }
}

/** Reserva o próximo lote: até 50 jobs do mesmo tipo, ou 1 job isolado (repetição após 422 de lote). */
async function claimBatch(sql: Sql): Promise<WriteJob[]> {
  return sql.transaction(async (tx) => {
    const [first] = await tx.query<WriteJob>(
      `SELECT ${COLS} FROM nuvemshop_write_jobs WHERE status = 'PENDING' AND next_run_at <= now() ORDER BY isolate DESC, created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
    );
    if (!first) return [];
    let jobs = [first];
    if (!first.isolate) {
      const more = await tx.query<WriteJob>(
        `SELECT ${COLS} FROM nuvemshop_write_jobs WHERE status = 'PENDING' AND next_run_at <= now() AND kind = $1 AND store_id = $2 AND NOT isolate AND id <> $3::uuid
         ORDER BY created_at LIMIT $4 FOR UPDATE SKIP LOCKED`,
        [first.kind, first.storeId, first.id, BATCH_LIMIT - 1],
      );
      jobs = [first, ...more];
    }
    await tx.execute(`UPDATE nuvemshop_write_jobs SET status = 'RUNNING', attempts = attempts + 1, started_at = now(), updated_at = now() WHERE id = ANY($1::uuid[])`, [jobs.map((j) => j.id)]);
    return jobs.map((j) => ({ ...j, attempts: j.attempts + 1, status: "RUNNING" as JobStatus }));
  });
}

async function runBatch(sql: Sql, conn: { store: StoreRow; client: NuvemshopApiClient }, claimed: WriteJob[], result: WorkerResult): Promise<void> {
  const kind = claimed[0].kind;
  const batchId = randomUUID();
  result.processed += claimed.length;
  // 1. A automação ainda permite escrever? (pausa/desligamento depois da criação do job)
  const automation = await getAutomation(sql, kind);
  const allowed = (j: WriteJob) => (j.mode === "MANUAL" ? automation.mode !== "PAUSED" && automation.mode !== "DISABLED" : automation.mode === "PILOT" || automation.mode === "AUTOMATIC");
  let jobs: WriteJob[] = [];
  for (const j of claimed) {
    if (!allowed(j)) {
      await finish(sql, j, "CANCELED", "CANCELED", { code: "AUTOMATION_NOT_ACTIVE", message: `Automação ${kind} em ${automation.mode}: escrita não executada` });
      result.canceled++;
    } else if (new Date(j.expiresAt).getTime() < Date.now()) {
      await finish(sql, j, "CANCELED", "CANCELED", { code: "EXPIRED", message: "Escrita expirada" });
      result.canceled++;
    } else jobs.push(j);
  }
  if (!jobs.length) return;

  // 2. Portão (ambiente, escopo, emergência).
  let permit;
  try {
    permit = await issueWritePermit(sql, conn.store, kind, `${kind} lote ${batchId}`);
  } catch (err) {
    for (const j of jobs) await finish(sql, j, "CANCELED", "CANCELED", { code: "WRITE_BLOCKED", message: (err as Error).message, batchId });
    result.canceled += jobs.length;
    return;
  }

  // 3. Releitura imediatamente antes de escrever (compare-and-set).
  let before: Map<string, RemoteVariantState>;
  try {
    before = (await refreshProducts(sql, conn.client, conn.store.storeId, [...new Set(jobs.map((j) => j.nsProductId))])).variants;
  } catch (err) {
    await retryLater(sql, jobs, err, result, batchId);
    return;
  }
  const toSend: WriteJob[] = [];
  for (const j of jobs) {
    const current = remoteValueOf(j, before.get(j.variantId));
    if (current === j.targetValue) {
      await finish(sql, j, "SUCCEEDED", "SUCCEEDED", { message: "Valor remoto já era o desejado (nada enviado)", before: current, after: current, verified: true, batchId });
      result.succeeded++;
    } else if (current === null) {
      await finish(sql, j, "SUPERSEDED", "SUPERSEDED", { code: "REMOTE_UNKNOWN", message: "Valor remoto desconhecido ou variante removida: não escrito", batchId });
      result.superseded++;
    } else if (j.expectedValue !== null && current !== j.expectedValue) {
      await finish(sql, j, "SUPERSEDED", "SUPERSEDED", { code: "REMOTE_CHANGED", message: `Valor remoto mudou desde o cálculo (${j.expectedValue} → ${current}): recalculado no próximo ciclo`, before: current, batchId });
      result.superseded++;
    } else toSend.push(j);
  }
  if (!toSend.length) return;

  // 4. Envio em lote.
  const started = Date.now();
  let success: Map<string, boolean>;
  try {
    const res = await conn.client.send<unknown>(permit, "PATCH", "/products/stock-price", bodyFor(toSend, conn.store.multiLocation === true), { idempotent: kind === "PRICE" });
    success = successByVariant(res.data);
  } catch (err) {
    const api = err instanceof NuvemshopApiError ? err : null;
    const durationMs = Date.now() - started;
    if (api?.kind === "unprocessable" || api?.kind === "bad_request") {
      if (toSend.length > 1) {
        // Falha de validação do lote: repete cada variante sozinha para isolar a(s) inválida(s).
        await sql.execute(`UPDATE nuvemshop_write_jobs SET status = 'PENDING', isolate = true, updated_at = now() WHERE id = ANY($1::uuid[])`, [toSend.map((j) => j.id)]);
        for (const j of toSend) {
          await sql.execute(`INSERT INTO nuvemshop_write_attempts (job_id, attempt, batch_id, batch_size, outcome, http_status, error_code, message, duration_ms) VALUES ($1::uuid, $2, $3::uuid, $4, 'RETRY', $5, 'BATCH_REJECTED', $6, $7)`, [j.id, j.attempts, batchId, toSend.length, api.status, api.message.slice(0, 500), durationMs]);
        }
        return;
      }
      await finish(sql, toSend[0], "FAILED", "FAILED", { code: api.kind, httpStatus: api.status, message: api.message, batchId, batchSize: 1, durationMs });
      result.failed++;
      return;
    }
    if (api && (api.kind === "unauthorized" || api.kind === "forbidden" || api.kind === "payment_required")) {
      await recordStoreError(sql, conn.store.storeId, api.message, api.kind === "unauthorized");
      for (const j of toSend) await finish(sql, j, "FAILED", "FAILED", { code: api.kind, httpStatus: api.status, message: api.message, batchId, batchSize: toSend.length, durationMs });
      result.failed += toSend.length;
      await raiseAlert(sql, `nuvemshop_write_${api.kind}`, `Escrita na Nuvemshop recusada (${api.kind}): ${api.message}`);
      return;
    }
    if (api?.uncertain || !api) {
      for (const j of toSend) {
        await finish(sql, j, "UNCERTAIN", "UNCERTAIN", { code: api?.kind ?? "internal", httpStatus: api?.status ?? null, message: api?.message ?? (err as Error).message, before: j.expectedValue, batchId, batchSize: toSend.length, durationMs });
      }
      result.uncertain += toSend.length;
      return;
    }
    await retryLater(sql, toSend, err, result, batchId);
    return;
  }

  // 5. Confirmação por leitura.
  let after: Map<string, RemoteVariantState>;
  try {
    after = (await refreshProducts(sql, conn.client, conn.store.storeId, [...new Set(toSend.map((j) => j.nsProductId))])).variants;
  } catch (err) {
    for (const j of toSend) await finish(sql, j, "UNCERTAIN", "UNCERTAIN", { code: "VERIFY_FAILED", message: `Escrita enviada; leitura de confirmação falhou: ${(err as Error).message}`, batchId, batchSize: toSend.length });
    result.uncertain += toSend.length;
    return;
  }
  const durationMs = Date.now() - started;
  for (const j of toSend) {
    const observed = remoteValueOf(j, after.get(j.variantId));
    const flagged = success.get(j.variantId);
    if (observed === j.targetValue) {
      await finish(sql, j, "SUCCEEDED", "SUCCEEDED", { before: j.expectedValue, after: observed, verified: true, batchId, batchSize: toSend.length, durationMs, httpStatus: 200 });
      result.succeeded++;
    } else if (j.kind === "STOCK" && observed !== null && Number(observed) < Number(j.targetValue) && flagged !== false) {
      // Venda logo após a escrita: a loja desconta sozinha. Aplicado, mas a leitura já mostra menos.
      await finish(sql, j, "SUCCEEDED", "VERIFIED_MISMATCH", { message: `Leitura mostra ${observed} (alvo ${j.targetValue}): provável venda após a escrita`, before: j.expectedValue, after: observed, verified: false, batchId, batchSize: toSend.length, durationMs });
      await sql.execute(`UPDATE nuvemshop_sync_variants SET dirty_at = now() WHERE store_id = $1 AND variant_id = $2::bigint AND kind = 'STOCK'`, [j.storeId, j.variantId]);
      result.succeeded++;
    } else if (observed === j.expectedValue || flagged === false) {
      await finish(sql, j, "FAILED", "FAILED", { code: "NOT_APPLIED", message: `A Nuvemshop não aplicou a escrita (leitura: ${observed ?? "desconhecido"})`, before: j.expectedValue, after: observed, batchId, batchSize: toSend.length, durationMs });
      result.failed++;
    } else {
      await finish(sql, j, "REQUIRES_RECONCILIATION", "VERIFIED_MISMATCH", { code: "VERIFY_MISMATCH", message: `Valor lido (${observed ?? "desconhecido"}) difere do enviado (${j.targetValue}) e do anterior (${j.expectedValue})`, before: j.expectedValue, after: observed, batchId, batchSize: toSend.length, durationMs });
      result.uncertain++;
      await raiseAlert(sql, `nuvemshop_verify_mismatch:${j.variantId}`, `Nuvemshop: variante ${j.variantId} com ${kind === "PRICE" ? "preço" : "estoque"} divergente após a escrita (aguarda reconciliação)`, { jobId: j.id });
    }
  }
}

async function retryLater(sql: Sql, jobs: WriteJob[], err: unknown, result: WorkerResult, batchId: string) {
  const api = err instanceof NuvemshopApiError ? err : null;
  for (const j of jobs) {
    if (j.attempts >= j.maxAttempts) {
      await finish(sql, j, "FAILED", "FAILED", { code: api?.kind ?? "internal", httpStatus: api?.status ?? null, message: (err as Error).message, batchId });
      result.failed++;
      continue;
    }
    const wait = Math.min(600, Math.max((api?.retryAfterMs ?? 0) / 1000, 15 * 2 ** (j.attempts - 1)));
    await sql.execute(
      `UPDATE nuvemshop_write_jobs SET status = 'PENDING', next_run_at = now() + make_interval(secs => $2::double precision), error_code = $3, error_message = $4, updated_at = now() WHERE id = $1::uuid`,
      [j.id, wait, api?.kind ?? "internal", redactString((err as Error).message).slice(0, 500)],
    );
    await sql.execute(`INSERT INTO nuvemshop_write_attempts (job_id, attempt, batch_id, outcome, http_status, error_code, message) VALUES ($1::uuid, $2, $3::uuid, 'RETRY', $4, $5, $6)`, [j.id, j.attempts, batchId, api?.status ?? null, api?.kind ?? "internal", redactString((err as Error).message).slice(0, 500)]);
  }
  logger.warn("Nuvemshop: lote de escrita adiado", { kind: jobs[0]?.kind, size: jobs.length, err: api?.kind ?? (err as Error).message });
}

/**
 * Resolve escritas incertas por leitura: aplicado (valor = alvo) → SUCCEEDED; não aplicado (valor = anterior)
 * → FAILED, liberando a variante para o próximo ciclo; outro valor → REQUIRES_RECONCILIATION (trava a variante
 * até um administrador decidir). Nada é reenviado aqui.
 */
export async function resolveUncertainJobs(sql: Sql, deps: WorkerDeps = {}): Promise<{ resolved: number; reconciliation: number }> {
  const jobs = await sql.query<WriteJob>(`SELECT ${COLS} FROM nuvemshop_write_jobs WHERE status = 'UNCERTAIN' AND updated_at < now() - interval '20 seconds' ORDER BY updated_at LIMIT 100`);
  if (!jobs.length) return { resolved: 0, reconciliation: 0 };
  const conn = deps.client ?? (await clientForConnectedStore(sql, { fetchImpl: deps.fetchImpl, sleep: deps.sleep, maxRetries: deps.maxRetries }));
  const remote = (await refreshProducts(sql, conn.client, conn.store.storeId, [...new Set(jobs.map((j) => j.nsProductId))])).variants;
  let resolved = 0;
  let reconciliation = 0;
  for (const j of jobs) {
    const observed = remoteValueOf(j, remote.get(j.variantId));
    if (observed === j.targetValue) {
      await finish(sql, j, "SUCCEEDED", "RESOLVED", { message: "Resultado incerto confirmado por leitura: aplicado", after: observed, verified: true });
      resolved++;
    } else if (observed !== null && observed === j.expectedValue) {
      await finish(sql, j, "FAILED", "RESOLVED", { code: "NOT_APPLIED", message: "Resultado incerto confirmado por leitura: não aplicado (recalculado no próximo ciclo)", after: observed });
      resolved++;
    } else {
      await finish(sql, j, "REQUIRES_RECONCILIATION", "UNCERTAIN", { code: "UNRESOLVED", message: `Resultado incerto e valor atual (${observed ?? "desconhecido"}) não corresponde ao anterior nem ao alvo`, after: observed });
      reconciliation++;
      await raiseAlert(sql, `nuvemshop_uncertain:${j.variantId}`, `Nuvemshop: escrita incerta na variante ${j.variantId} exige reconciliação`, { jobId: j.id });
    }
  }
  return { resolved, reconciliation };
}

/** Decisão administrativa sobre um job em reconciliação: libera a variante (o próximo ciclo recalcula a partir do valor lido). */
export async function resolveJobManually(sql: Sql, jobId: string, actor: string, note: string): Promise<void> {
  const [job] = await sql.query<WriteJob>(`SELECT ${COLS} FROM nuvemshop_write_jobs WHERE id = $1::uuid`, [jobId]);
  if (!job) throw new AutomationError("job_not_found", "Job não encontrado", 404);
  if (job.status !== "REQUIRES_RECONCILIATION" && job.status !== "UNCERTAIN") throw new AutomationError("not_reconcilable", "Este job não está aguardando reconciliação");
  await finish(sql, job, "CANCELED", "RESOLVED", { code: "RESOLVED_BY_ADMIN", message: `Reconciliado por ${actor}: ${note}`.slice(0, 500) });
}

export async function listJobs(sql: Sql, opts: { status?: string[]; kind?: AutomationKind; limit?: number } = {}) {
  return sql.query<WriteJob & { errorCode: string | null; errorMessage: string | null; observedAfter: string | null; createdAt: Date; finishedAt: Date | null; verified: boolean; sku: string | null; name: string | null }>(
    `SELECT ${cols("j.")}, j.error_code AS "errorCode", j.error_message AS "errorMessage", j.observed_after AS "observedAfter",
            j.created_at AS "createdAt", j.finished_at AS "finishedAt", j.verified, v.sku, p.name
     FROM nuvemshop_write_jobs j LEFT JOIN nuvemshop_variants v ON v.store_id = j.store_id AND v.variant_id = j.variant_id
     LEFT JOIN nuvemshop_products p ON p.store_id = j.store_id AND p.product_id = j.nuvemshop_product_id
     WHERE ($1::text[] IS NULL OR j.status = ANY($1::text[])) AND ($2::text IS NULL OR j.kind = $2) ORDER BY j.created_at DESC LIMIT $3`,
    [opts.status?.length ? opts.status : null, opts.kind ?? null, Math.min(500, opts.limit ?? 100)],
  );
}
