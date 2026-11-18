import "server-only";
import { randomUUID } from "node:crypto";
import { acquireLease, releaseLease, renewLease } from "../imports/jobs";
import { ConfigError } from "../env";
import { logger, redactString } from "../logger";
import { getSql, isUniqueViolation, type Sql } from "../sql";
import { CatalogItemError, mapProduct, mapVariant, upsertCategories, upsertLocations, upsertProduct, type MappedVariant } from "./catalog";
import { NuvemshopApiError, type NsCategory, type NsLocation, type NsProduct, type NsStore, type NsVariant, type NuvemshopApiClient } from "./client";
import { refreshMappingSuggestions } from "./mapping";
import { clientForConnectedStore, getConnectedStore, NuvemshopNotConnectedError, recordStoreError, updateStoreInfo } from "./store";

/**
 * Importação do catálogo Nuvemshop (somente leitura) em fatias serverless.
 *
 * Fases: store → locations → categories → products (paginado) → finalize (só FULL: marca removidos)
 *        → match (sugestões de vínculo ADS). Cada etapa grava os dados e o cursor na mesma transação:
 *        uma interrupção (timeout, deploy, restart) retoma da última etapa confirmada.
 * Concorrência: lease próprio no banco (um worker por vez) + índice único "uma tarefa ativa por loja".
 * Retentativas com backoff e limite; erros de item não interrompem a página (contados e registrados).
 */
export const NS_LEASE = "nuvemshop-catalog";
export const PRODUCTS_PER_PAGE = 50;
export const CATEGORIES_PER_PAGE = 200;
export const MAX_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 60_000;

export type ImportMode = "FULL" | "INCREMENTAL";
export type Phase = "store" | "locations" | "categories" | "products" | "finalize" | "match" | "done";

export interface ImportCursor {
  phase?: Phase;
  page?: number;
}

export interface ImportJob {
  id: string;
  storeId: string;
  mode: ImportMode;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "PARTIALLY_COMPLETED" | "FAILED" | "CANCELED";
  cursor: ImportCursor;
  updatedSince: Date | null;
  totalProducts: number | null;
  productsSeen: number;
  variantsSeen: number;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  removedCount: number;
  failedCount: number;
  attempts: number;
  nextRunAt: Date;
  lastError: string | null;
  requestedBy: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

export const JOB_COLS = `id::text AS id, store_id AS "storeId", mode, status, cursor, updated_since AS "updatedSince", total_products AS "totalProducts",
  products_seen AS "productsSeen", variants_seen AS "variantsSeen", created_count AS "createdCount", updated_count AS "updatedCount",
  unchanged_count AS "unchangedCount", removed_count AS "removedCount", failed_count AS "failedCount", attempts, next_run_at AS "nextRunAt",
  last_error AS "lastError", requested_by AS "requestedBy", started_at AS "startedAt", finished_at AS "finishedAt", created_at AS "createdAt"`;

export class ImportConflictError extends Error {
  readonly code = "import_in_progress";
  constructor(readonly activeJobId: string | null) {
    super("Já existe uma importação do catálogo Nuvemshop em andamento");
    this.name = "ImportConflictError";
  }
}

/**
 * Cria uma importação. INCREMENTAL busca produtos atualizados desde o início da última importação concluída
 * (com 1 h de margem); sem importação anterior concluída, vira FULL.
 */
export async function createImportJob(sql: Sql, input: { mode: ImportMode; actor: string }): Promise<ImportJob> {
  const store = await getConnectedStore(sql);
  if (!store || store.connectionStatus !== "ACTIVE") throw new NuvemshopNotConnectedError();
  let mode = input.mode;
  let since: string | null = null;
  if (mode === "INCREMENTAL") {
    const [last] = await sql.query<{ startedAt: Date | null }>(
      `SELECT started_at AS "startedAt" FROM nuvemshop_catalog_import_jobs WHERE store_id = $1 AND status = 'COMPLETED' ORDER BY started_at DESC NULLS LAST LIMIT 1`,
      [store.storeId],
    );
    if (last?.startedAt) since = new Date(new Date(last.startedAt).getTime() - 3_600_000).toISOString();
    else mode = "FULL";
  }
  try {
    const [job] = await sql.query<ImportJob>(
      `INSERT INTO nuvemshop_catalog_import_jobs (store_id, mode, updated_since, cursor, requested_by) VALUES ($1, $2, $3::timestamptz, '{"phase":"store"}'::jsonb, $4) RETURNING ${JOB_COLS}`,
      [store.storeId, mode, since, input.actor],
    );
    return job;
  } catch (err) {
    if (isUniqueViolation(err)) {
      const [a] = await sql.query<{ id: string }>(`SELECT id::text AS id FROM nuvemshop_catalog_import_jobs WHERE store_id = $1 AND status IN ('PENDING','RUNNING') LIMIT 1`, [store.storeId]);
      throw new ImportConflictError(a?.id ?? null);
    }
    throw err;
  }
}

export async function listImportJobs(sql: Sql, limit = 20): Promise<ImportJob[]> {
  return sql.query<ImportJob>(`SELECT ${JOB_COLS} FROM nuvemshop_catalog_import_jobs ORDER BY created_at DESC LIMIT $1`, [Math.min(Math.max(limit, 1), 100)]);
}

export async function getImportJob(sql: Sql, id: string): Promise<ImportJob | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [j] = await sql.query<ImportJob>(`SELECT ${JOB_COLS} FROM nuvemshop_catalog_import_jobs WHERE id = $1::uuid`, [id]);
  return j ?? null;
}

export async function importAttempts(sql: Sql, jobId: string, limit = 50) {
  return sql.query<{ id: string; phase: string; page: number | null; attempt: number; outcome: string; httpStatus: number | null; errorCode: string | null; message: string | null; durationMs: number | null; createdAt: Date }>(
    `SELECT id::text AS id, phase, page, attempt, outcome, http_status AS "httpStatus", error_code AS "errorCode", message, duration_ms AS "durationMs", created_at AS "createdAt"
     FROM nuvemshop_catalog_import_attempts WHERE job_id = $1::uuid ORDER BY id DESC LIMIT $2`,
    [jobId, Math.min(Math.max(limit, 1), 500)],
  );
}

export async function cancelImportJob(sql: Sql, id: string): Promise<ImportJob | null> {
  const [j] = await sql.query<ImportJob>(
    `UPDATE nuvemshop_catalog_import_jobs SET status = 'CANCELED', finished_at = now(), updated_at = now(), last_error = COALESCE(last_error, 'Cancelada pelo administrador')
     WHERE id = $1::uuid AND status IN ('PENDING','RUNNING') RETURNING ${JOB_COLS}`,
    [id],
  );
  return j ?? null;
}

/** Há importação pronta e nenhum worker com lease válido? (retomada após interrupção) */
export async function nuvemshopNeedsWorker(sql: Sql): Promise<boolean> {
  const [r] = await sql.query<{ needed: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM nuvemshop_catalog_import_jobs WHERE status IN ('PENDING','RUNNING') AND next_run_at <= now() + interval '1 second')
        AND NOT EXISTS (SELECT 1 FROM worker_leases WHERE name = $1 AND lease_until > now()) AS needed`,
    [NS_LEASE],
  );
  return r?.needed === true;
}

class LeaseLostError extends Error {}
class JobStoppedError extends Error {}

interface StepOutcome {
  next: ImportCursor;
  counts?: Partial<Record<"productsSeen" | "variantsSeen" | "createdCount" | "updatedCount" | "unchangedCount" | "removedCount" | "failedCount", number>>;
  totalProducts?: number | null;
  itemErrors?: { id: string; message: string }[];
  page?: number | null;
  httpStatus?: number | null;
}

/** Grava o resultado de uma etapa e o novo cursor atomicamente (só se o lease e a tarefa continuam válidos). */
async function commit(sql: Sql, job: ImportJob, owner: string, phase: Phase, out: StepOutcome, durationMs: number, write?: (tx: Sql) => Promise<void>) {
  await sql.transaction(async (tx) => {
    const lease = await tx.execute(`UPDATE worker_leases SET lease_until = now() + interval '90 seconds' WHERE name = $1 AND owner = $2`, [NS_LEASE, owner]);
    if (!lease) throw new LeaseLostError();
    const [cur] = await tx.query<{ status: string }>(`SELECT status FROM nuvemshop_catalog_import_jobs WHERE id = $1::uuid FOR UPDATE`, [job.id]);
    if (cur?.status !== "RUNNING") throw new JobStoppedError();
    if (write) await write(tx);
    const c = out.counts ?? {};
    const finished = out.next.phase === "done";
    await tx.execute(
      `UPDATE nuvemshop_catalog_import_jobs SET cursor = $2::jsonb, attempts = 0, last_error = NULL, next_run_at = now(), updated_at = now(),
         products_seen = products_seen + $3, variants_seen = variants_seen + $4, created_count = created_count + $5, updated_count = updated_count + $6,
         unchanged_count = unchanged_count + $7, removed_count = removed_count + $8, failed_count = failed_count + $9,
         total_products = COALESCE($10::int, total_products),
         status = CASE WHEN $11::boolean THEN (CASE WHEN failed_count + $9 > 0 THEN 'PARTIALLY_COMPLETED' ELSE 'COMPLETED' END) ELSE status END,
         finished_at = CASE WHEN $11::boolean THEN now() ELSE finished_at END
       WHERE id = $1::uuid`,
      [job.id, JSON.stringify(out.next), c.productsSeen ?? 0, c.variantsSeen ?? 0, c.createdCount ?? 0, c.updatedCount ?? 0, c.unchangedCount ?? 0, c.removedCount ?? 0, c.failedCount ?? 0, out.totalProducts ?? null, finished],
    );
    await tx.execute(
      `INSERT INTO nuvemshop_catalog_import_attempts (job_id, phase, page, attempt, outcome, http_status, duration_ms) VALUES ($1::uuid, $2, $3, $4, 'OK', $5, $6)`,
      [job.id, phase, out.page ?? null, job.attempts + 1, out.httpStatus ?? 200, durationMs],
    );
    for (const e of (out.itemErrors ?? []).slice(0, 50)) {
      await tx.execute(
        `INSERT INTO nuvemshop_catalog_import_attempts (job_id, phase, page, attempt, outcome, error_code, message) VALUES ($1::uuid, $2, $3, $4, 'ITEM_ERROR', 'ITEM', $5)`,
        [job.id, phase, out.page ?? null, job.attempts + 1, redactString(`${e.id}: ${e.message}`).slice(0, 500)],
      );
    }
  });
}

async function runStep(sql: Sql, job: ImportJob, client: NuvemshopApiClient, owner: string): Promise<void> {
  const phase: Phase = job.cursor.phase ?? "store";
  const started = Date.now();
  const now = new Date();
  const storeId = job.storeId;

  if (phase === "store") {
    const { data } = await client.get<NsStore>("/store");
    if (String(data?.id) !== storeId) throw new NuvemshopApiError("invalid_response", "GET /store devolveu outra loja");
    await commit(sql, job, owner, phase, { next: { phase: "locations" } }, Date.now() - started, async (tx) => {
      const [s] = await tx.query<{ capabilities: Record<string, unknown> }>(`SELECT capabilities FROM nuvemshop_stores WHERE store_id = $1`, [storeId]);
      await updateStoreInfo(tx, storeId, data, { ...(s?.capabilities ?? {}), storeReadable: true, checkedAt: now.toISOString() }, null, now);
    });
    return;
  }

  if (phase === "locations") {
    let locations: NsLocation[] | null = null;
    let forbidden = false;
    try {
      locations = (await client.get<NsLocation[]>("/locations")).data;
      if (!Array.isArray(locations)) throw new NuvemshopApiError("invalid_response", "Lista de localizações esperada");
    } catch (err) {
      // Sem read_locations: segue sem localizações (o estoque fica sem local identificado), registrado na loja.
      if (err instanceof NuvemshopApiError && (err.kind === "forbidden" || err.kind === "not_found")) forbidden = true;
      else throw err;
    }
    await commit(sql, job, owner, phase, { next: { phase: "categories", page: 1 }, httpStatus: forbidden ? 403 : 200 }, Date.now() - started, async (tx) => {
      const n = locations ? await upsertLocations(tx, storeId, locations, now) : null;
      await tx.execute(
        `UPDATE nuvemshop_stores SET location_count = $2::int, multi_location = CASE WHEN $2::int IS NULL THEN multi_location ELSE $2::int > 1 END,
           capabilities = capabilities || $3::jsonb, updated_at = now() WHERE store_id = $1`,
        [storeId, n, JSON.stringify({ locationsReadable: !forbidden })],
      );
    });
    return;
  }

  if (phase === "categories") {
    const page = job.cursor.page ?? 1;
    let res;
    try {
      res = await client.getPage<NsCategory>("/categories", page, CATEGORIES_PER_PAGE);
    } catch (err) {
      if (err instanceof NuvemshopApiError && err.kind === "forbidden") res = { items: [] as NsCategory[], hasNext: false, total: null, page };
      else throw err;
    }
    await commit(sql, job, owner, phase, { next: res.hasNext ? { phase: "categories", page: page + 1 } : { phase: "products", page: 1 }, page }, Date.now() - started, async (tx) => {
      await upsertCategories(tx, storeId, res.items, now);
    });
    return;
  }

  if (phase === "products") {
    const page = job.cursor.page ?? 1;
    const res = await client.getPage<NsProduct>("/products", page, PRODUCTS_PER_PAGE, {
      // Ordem estável entre páginas mesmo se produtos forem editados durante a importação.
      sort_by: "created-at-ascending",
      updated_at_min: job.mode === "INCREMENTAL" && job.updatedSince ? new Date(job.updatedSince).toISOString() : undefined,
    });
    const itemErrors: { id: string; message: string }[] = [];
    const prepared: { p: ReturnType<typeof mapProduct>; variants: MappedVariant[] }[] = [];
    for (const raw of res.items) {
      try {
        const p = mapProduct(raw);
        let rawVariants = p.variants;
        // Variantes não vieram embutidas: consulta o recurso oficial de variantes (paginado).
        if (!rawVariants || !rawVariants.length) {
          rawVariants = [];
          for (let vp = 1; vp <= 10; vp++) {
            const r = await client.getPage<NsVariant>(`/products/${p.productId}/variants`, vp, 200);
            rawVariants.push(...r.items);
            if (!r.hasNext) break;
          }
        }
        const variants = rawVariants.map((v) => mapVariant(v, Number(p.productId)));
        prepared.push({ p, variants });
      } catch (err) {
        if (err instanceof CatalogItemError) itemErrors.push({ id: err.itemId, message: err.message });
        else throw err;
      }
    }
    const counts = { productsSeen: 0, variantsSeen: 0, createdCount: 0, updatedCount: 0, unchangedCount: 0, removedCount: 0, failedCount: itemErrors.length };
    await commit(
      sql,
      job,
      owner,
      phase,
      { next: res.hasNext ? { phase: "products", page: page + 1 } : { phase: job.mode === "FULL" ? "finalize" : "match" }, counts, totalProducts: res.total, itemErrors, page },
      Date.now() - started,
      async (tx) => {
        for (const { p, variants } of prepared) {
          const r = await upsertProduct(tx, storeId, job.id, p, variants, now);
          counts.productsSeen++;
          counts.variantsSeen += r.variants;
          counts.createdCount += r.created;
          counts.updatedCount += r.updated;
          counts.unchangedCount += r.unchanged;
          counts.removedCount += r.removedVariants.length;
        }
      },
    );
    return;
  }

  if (phase === "finalize") {
    // Importação completa: o que não apareceu nesta tarefa foi removido na loja (marcado, nunca apagado).
    const counts = { removedCount: 0 };
    await commit(sql, job, owner, phase, { next: { phase: "match" }, counts }, Date.now() - started, async (tx) => {
      const products = await tx.query<{ productId: string }>(
        `UPDATE nuvemshop_products SET sync_status = 'REMOVED', removed_at = now(), updated_at = now()
         WHERE store_id = $1 AND sync_status = 'ACTIVE' AND last_seen_job_id IS DISTINCT FROM $2::uuid RETURNING product_id::text AS "productId"`,
        [storeId, job.id],
      );
      const variants = await tx.execute(
        `UPDATE nuvemshop_variants SET sync_status = 'REMOVED', removed_at = now(), updated_at = now()
         WHERE store_id = $1 AND sync_status = 'ACTIVE' AND last_seen_job_id IS DISTINCT FROM $2::uuid`,
        [storeId, job.id],
      );
      counts.removedCount = products.length + variants;
    });
    return;
  }

  if (phase === "match") {
    await commit(sql, job, owner, phase, { next: { phase: "done" } }, Date.now() - started, async (tx) => {
      await refreshMappingSuggestions(tx, storeId);
    });
    return;
  }

  // Fase desconhecida (cursor corrompido): encerra sem tocar nos dados.
  await commit(sql, job, owner, phase, { next: { phase: "done" } }, Date.now() - started);
}

function backoff(attempt: number, hint: number | null, base: number): number {
  return Math.min(MAX_BACKOFF_MS, Math.max(hint ?? 0, base * 2 ** (attempt - 1)));
}

async function handleError(sql: Sql, job: ImportJob, err: unknown, retryBaseMs: number): Promise<void> {
  const phase = job.cursor.phase ?? "store";
  const attempt = job.attempts + 1;
  const api = err instanceof NuvemshopApiError ? err : null;
  const message = redactString(err instanceof Error ? err.message : String(err)).slice(0, 500);
  const fatal = err instanceof ConfigError || err instanceof NuvemshopNotConnectedError || (api !== null && !api.retryable);
  if (api?.kind === "unauthorized") await recordStoreError(sql, job.storeId, message, true);
  else if (api && (api.kind === "payment_required" || api.kind === "forbidden")) await recordStoreError(sql, job.storeId, message, false);

  const giveUp = fatal || attempt >= MAX_ATTEMPTS;
  await sql.execute(
    `INSERT INTO nuvemshop_catalog_import_attempts (job_id, phase, page, attempt, outcome, http_status, error_code, message) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)`,
    [job.id, phase, job.cursor.page ?? null, attempt, giveUp ? "FAILED" : "RETRY", api?.status ?? null, api?.kind ?? (err instanceof ConfigError ? "config" : "internal"), message],
  );
  if (giveUp) {
    await sql.execute(
      `UPDATE nuvemshop_catalog_import_jobs SET status = 'FAILED', attempts = $2, last_error = $3, finished_at = now(), updated_at = now() WHERE id = $1::uuid AND status = 'RUNNING'`,
      [job.id, attempt, message],
    );
    logger.warn("Importação Nuvemshop interrompida", { jobId: job.id, phase, kind: api?.kind ?? "internal" });
    return;
  }
  const wait = backoff(attempt, api?.retryAfterMs ?? null, retryBaseMs);
  await sql.execute(
    `UPDATE nuvemshop_catalog_import_jobs SET attempts = $2, last_error = $3, next_run_at = now() + make_interval(secs => $4::double precision), updated_at = now()
     WHERE id = $1::uuid AND status = 'RUNNING'`,
    [job.id, attempt, message, wait / 1000],
  );
}

export interface ProcessOptions {
  budgetMs?: number;
  sql?: Sql;
  client?: NuvemshopApiClient;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  retryBaseMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Processa importações pendentes por até budgetMs. Retorna more=true se ainda há trabalho. */
export async function processNuvemshopJobs(opts: ProcessOptions = {}): Promise<{ busy: boolean; steps: number; more: boolean }> {
  const sql = opts.sql ?? getSql();
  const sleep = opts.sleep ?? defaultSleep;
  const budget = opts.budgetMs ?? 45_000;
  const retryBaseMs = opts.retryBaseMs ?? 2_000;
  const started = Date.now();
  const owner = randomUUID();
  let steps = 0;
  if (!(await acquireLease(sql, owner, NS_LEASE))) return { busy: true, steps, more: false };
  let client = opts.client;
  try {
    while (Date.now() - started < budget) {
      const [job] = await sql.query<ImportJob & { waitMs: number }>(
        `SELECT ${JOB_COLS}, GREATEST(0, EXTRACT(EPOCH FROM (next_run_at - now())) * 1000)::int AS "waitMs"
         FROM nuvemshop_catalog_import_jobs WHERE status IN ('PENDING','RUNNING') ORDER BY created_at LIMIT 1`,
      );
      if (!job) return { busy: false, steps, more: false };
      if (job.status === "PENDING") {
        await sql.execute(`UPDATE nuvemshop_catalog_import_jobs SET status = 'RUNNING', started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1::uuid AND status = 'PENDING'`, [job.id]);
        job.status = "RUNNING";
      }
      if (job.waitMs > 0) {
        const remaining = budget - (Date.now() - started);
        if (job.waitMs >= remaining) return { busy: false, steps, more: true };
        await sleep(job.waitMs);
        if (!(await renewLease(sql, owner, NS_LEASE))) return { busy: false, steps, more: true };
        continue;
      }
      try {
        if (!client || client.storeId !== job.storeId) {
          const c = await clientForConnectedStore(sql, { fetchImpl: opts.fetchImpl, sleep });
          if (c.store.storeId !== job.storeId) throw new NuvemshopNotConnectedError("A loja desta importação não está mais conectada");
          client = c.client;
        }
        await runStep(sql, job, client, owner);
        steps++;
      } catch (err) {
        if (err instanceof LeaseLostError) return { busy: false, steps, more: true };
        if (err instanceof JobStoppedError) continue;
        await handleError(sql, job, err, retryBaseMs);
      }
    }
    return { busy: false, steps, more: true };
  } finally {
    await releaseLease(sql, owner, NS_LEASE).catch(() => undefined);
  }
}
