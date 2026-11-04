import "server-only";
import { randomUUID } from "node:crypto";
import { AdsApiError, getAdsClient, type AdsClient, type PagedResource } from "../ads/client";
import {
  mapDivisions,
  mapPrices,
  mapPriceTables,
  mapProducts,
  mapStocks,
  mapSuppliers,
  type ItemError,
} from "../ads/schemas";
import { ConfigError } from "../env";
import { logger, redactString } from "../logger";
import { getSql, type Sql } from "../sql";
import { acquireLease, JOB_COLUMNS, releaseLease, renewLease, WORKER_LEASE, type ImportJob, type JobCursor, type JobType } from "./jobs";
import {
  splitByKnownProducts,
  upsertDivisions,
  upsertPrices,
  upsertPriceTables,
  upsertProducts,
  upsertStocks,
  upsertSuppliers,
  type UpsertCounts,
} from "./upserts";

/** Tentativas por página antes de interromper a tarefa (retomável depois). */
export const MAX_ATTEMPTS = 5;
/** Teto do backoff exponencial. */
const MAX_BACKOFF_MS = 30_000;
/** Ids por requisição quando a importação é filtrada por produtos. */
export const IDS_PER_REQUEST = 50;
/** Erros detalhados guardados por tarefa (o contador `failed` continua somando todos). */
export const MAX_STORED_ERRORS = 500;
/** Códigos gravados quando a tarefa é interrompida (rede, ADS, configuração) — não são erros de dados. */
const INTERRUPTION_CODE = /^(ADS_[A-Z_]+|INTERNAL_ERROR|CONFIG_ERROR)$/;

const PHASES: Record<JobType, string[]> = {
  PRODUCTS: ["reference", "items"],
  PRICE_TABLES: ["tables"],
  PRICES: ["tables", "items"],
  STOCKS: ["items"],
};

const RESOURCE: Partial<Record<JobType, PagedResource>> = {
  PRODUCTS: "produtos",
  PRICES: "tabela-precos-itens",
  STOCKS: "estoques",
};

interface StepResult {
  counts: UpsertCounts & { processed: number; failed: number };
  errors: (ItemError & { page: number | null })[];
  /** null = tarefa concluída */
  next: JobCursor | null;
  total?: number;
}

class LeaseLostError extends Error {}
class JobNoLongerRunningError extends Error {}

type Persist = (tx: Sql) => Promise<UpsertCounts & { failed: number; errors: ItemError[] }>;

interface Fetched {
  processed: number;
  next: JobCursor | null;
  total?: number;
  page: number | null;
  persist: Persist;
}

function nextPhase(type: JobType, phase: string): JobCursor | null {
  const phases = PHASES[type];
  const idx = phases.indexOf(phase);
  return idx >= 0 && idx < phases.length - 1 ? { phase: phases[idx + 1], page: 1, chunk: 0 } : null;
}

function orphanErrors(rows: { ads_product_id: number }[], what: string): ItemError[] {
  return rows.map((r) => ({
    externalProductId: r.ads_product_id,
    code: "PRODUCT_NOT_IMPORTED",
    message: `${what} recebido para produto ${r.ads_product_id} que ainda não está no catálogo local. Importe os produtos e repita.`,
  }));
}

/** Busca na ADS (fora de transação) o próximo pedaço da tarefa e devolve como persisti-lo. */
async function fetchStep(job: ImportJob, client: AdsClient, sql: Sql): Promise<Fetched> {
  const phases = PHASES[job.type];
  const phase = job.cursor.phase && phases.includes(job.cursor.phase) ? job.cursor.phase : phases[0];

  if (phase === "reference") {
    // Fornecedores e divisões: listas pequenas que dão nome aos filtros. Falha não-transitória não bloqueia o catálogo.
    const lists: { suppliers: unknown[] | null; divisions: unknown[] | null; errors: ItemError[] } = { suppliers: null, divisions: null, errors: [] };
    for (const [key, resource] of [["suppliers", "fornecedores"], ["divisions", "divisoes"]] as const) {
      try {
        lists[key] = await client.getList(resource);
      } catch (err) {
        if (err instanceof AdsApiError && !err.transient && err.kind !== "auth") {
          lists.errors.push({ externalProductId: null, code: "REFERENCE_UNAVAILABLE", message: err.message });
        } else throw err;
      }
    }
    return {
      processed: 0,
      page: null,
      next: nextPhase(job.type, phase),
      persist: async (tx) => {
        const s = mapSuppliers(lists.suppliers ?? []);
        const d = mapDivisions(lists.divisions ?? []);
        await upsertSuppliers(tx, s.rows);
        await upsertDivisions(tx, d.rows);
        // Contadores da tarefa referem-se a produtos; aqui só registramos falhas de leitura.
        const errors = [...lists.errors, ...s.errors, ...d.errors];
        return { created: 0, updated: 0, unchanged: 0, failed: 0, errors };
      },
    };
  }

  if (phase === "tables") {
    const items = await client.getList("tabelas");
    const mapped = mapPriceTables(items);
    const countsTowardJob = job.type === "PRICE_TABLES";
    return {
      processed: countsTowardJob ? items.length : 0,
      total: countsTowardJob ? items.length : undefined,
      page: null,
      next: nextPhase(job.type, phase),
      persist: async (tx) => {
        const c = await upsertPriceTables(tx, mapped.rows);
        return countsTowardJob
          ? { ...c, failed: mapped.errors.length, errors: mapped.errors }
          : { created: 0, updated: 0, unchanged: 0, failed: 0, errors: mapped.errors };
      },
    };
  }

  // phase === "items": páginas de produtos, preços ou estoques
  const resource = RESOURCE[job.type]!;
  const ids = job.params.adsProductIds;
  const chunk = job.cursor.chunk ?? 0;
  const pageNo = job.cursor.page ?? 1;
  const empty = (): Fetched => ({ processed: 0, page: null, next: null, persist: async () => ({ created: 0, updated: 0, unchanged: 0, failed: 0, errors: [] }) });

  // Estoque completo: /estoques exige `ids` (OpenAPI da ADS; sem filtro a listagem volta vazia),
  // então percorremos o catálogo local em lotes de produtos. Produto sem saldo retornado continua "desconhecido".
  const catalogMode = job.type === "STOCKS" && !ids?.length;
  let chunkIds: number[] | undefined;
  let moreChunks = false;
  let catalogTotal: number | undefined;
  if (catalogMode) {
    const rows = await sql.query<{ id: number }>(
      `SELECT ads_product_id AS id FROM products ORDER BY ads_product_id LIMIT $1::int OFFSET $2::int`,
      [IDS_PER_REQUEST + 1, chunk * IDS_PER_REQUEST],
    );
    chunkIds = rows.slice(0, IDS_PER_REQUEST).map((r) => Number(r.id));
    moreChunks = rows.length > IDS_PER_REQUEST;
    if (chunk === 0 && pageNo === 1) {
      const [{ n }] = await sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM products`);
      catalogTotal = n;
    }
    if (!chunkIds.length) return empty();
  } else if (ids?.length) {
    chunkIds = ids.slice(chunk * IDS_PER_REQUEST, (chunk + 1) * IDS_PER_REQUEST);
    moreChunks = (chunk + 1) * IDS_PER_REQUEST < ids.length;
    if (!chunkIds.length) return empty();
  }

  const res = await client.getPage(resource, { page: pageNo, ids: chunkIds });
  const pageSize = res.pageSize > 0 ? res.pageSize : client.pageSize;
  const maxPages = Math.ceil(res.total / pageSize) + 2;
  const guardTripped = pageNo > maxPages;

  let next: JobCursor | null;
  if (res.hasNext && res.items.length > 0 && !guardTripped) next = { phase, page: pageNo + 1, chunk };
  else if (moreChunks) next = { phase, page: 1, chunk: chunk + 1 };
  else next = null;

  // Total: no modo completo vem da ADS; no estoque por catálogo é o nº de produtos consultados;
  // no modo filtrado (seleção) não há total prévio.
  const total = catalogMode ? catalogTotal : ids?.length ? undefined : res.total;
  // No estoque por catálogo o progresso conta produtos consultados (não linhas por filial).
  const processed = catalogMode ? (pageNo === 1 ? chunkIds!.length : 0) : res.items.length;

  const persist: Persist = async (tx) => {
    const extra: ItemError[] = guardTripped
      ? [{ externalProductId: null, code: "PAGINATION_GUARD", message: `Paginação interrompida na página ${pageNo}: a ADS indicou mais páginas além do total informado (${res.total}).` }]
      : [];
    if (job.type === "PRODUCTS") {
      const m = mapProducts(res.items);
      const c = await upsertProducts(tx, m.rows);
      return { ...c, failed: m.errors.length, errors: [...m.errors, ...extra] };
    }
    if (job.type === "PRICES") {
      const m = mapPrices(res.items);
      const { known, orphans } = await splitByKnownProducts(tx, m.rows);
      const c = await upsertPrices(tx, known);
      const errors = [...m.errors, ...orphanErrors(orphans, "Preço"), ...extra];
      return { ...c, failed: m.errors.length + orphans.length, errors };
    }
    const m = mapStocks(res.items);
    const { known, orphans } = await splitByKnownProducts(tx, m.rows);
    const c = await upsertStocks(tx, known);
    return { ...c, failed: m.errors.length + orphans.length, errors: [...m.errors, ...orphanErrors(orphans, "Estoque"), ...extra] };
  };

  return { processed, next, total, page: pageNo, persist };
}

function summarize(failedTotal: number, byCode: { code: string; n: number }[]): string | null {
  if (!failedTotal && !byCode.length) return null;
  const parts = byCode.map((r) => `${r.code}: ${r.n}`);
  return `${failedTotal} registro(s) com falha${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

/** Grava o resultado de uma etapa de forma atômica e protegida pelo lease (fencing). */
async function commitStep(sql: Sql, job: ImportJob, owner: string, fetched: Fetched): Promise<void> {
  await sql.transaction(async (tx) => {
    const lease = await tx.execute(`UPDATE worker_leases SET lease_until = now() + interval '90 seconds' WHERE name = $1 AND owner = $2`, [
      WORKER_LEASE,
      owner,
    ]);
    if (!lease) throw new LeaseLostError();

    const result = await fetched.persist(tx);

    if (result.errors.length) {
      const [{ stored }] = await tx.query<{ stored: number }>(`SELECT count(*)::int AS stored FROM import_job_errors WHERE import_job_id = $1::uuid`, [job.id]);
      const room = Math.max(0, MAX_STORED_ERRORS - stored);
      const toStore = result.errors.slice(0, room).map((e) => ({
        external_product_id: e.externalProductId,
        page: fetched.page,
        error_code: e.code,
        error_message: redactString(e.message).slice(0, 1000),
      }));
      if (toStore.length) {
        await tx.execute(
          `INSERT INTO import_job_errors (import_job_id, external_product_id, page, error_code, error_message)
           SELECT $1::uuid, r.external_product_id, r.page, r.error_code, r.error_message
           FROM jsonb_to_recordset($2::jsonb) AS r(external_product_id int, page int, error_code text, error_message text)`,
          [job.id, JSON.stringify(toStore)],
        );
      }
    }

    const done = fetched.next === null;
    const updated = await tx.query<{ id: string }>(
      `UPDATE import_jobs SET
         processed = processed + $2, created = created + $3, updated = updated + $4, unchanged = unchanged + $5,
         failed = failed + $6, total = COALESCE($7::int, total), cursor = $8::jsonb, attempts = 0,
         last_error = NULL, next_run_at = now(), updated_at = now()
       WHERE id = $1::uuid AND status = 'RUNNING' RETURNING id::text AS id`,
      [
        job.id,
        fetched.processed,
        result.created,
        result.updated,
        result.unchanged,
        result.failed,
        fetched.total ?? null,
        JSON.stringify(done ? { ...job.cursor, done: true } : fetched.next),
      ],
    );
    if (!updated.length) throw new JobNoLongerRunningError();

    if (done) {
      const byCode = await tx.query<{ code: string; n: number }>(
        `SELECT error_code AS code, count(*)::int AS n FROM import_job_errors WHERE import_job_id = $1::uuid GROUP BY error_code ORDER BY n DESC`,
        [job.id],
      );
      const [{ failed }] = await tx.query<{ failed: number }>(`SELECT failed FROM import_jobs WHERE id = $1::uuid`, [job.id]);
      // Interrupções já superadas (tarefa retomada até o fim) ficam no histórico, mas não tornam o resultado parcial.
      const dataErrors = byCode.filter((r) => !INTERRUPTION_CODE.test(r.code));
      const interrupted = byCode.length > dataErrors.length;
      let summary = summarize(failed, dataErrors);
      if (interrupted) summary = `${summary ? `${summary}. ` : ""}Concluída após retomada de interrupção.`;
      await tx.execute(
        `UPDATE import_jobs SET status = $2, finished_at = now(), error_summary = $3, updated_at = now() WHERE id = $1::uuid`,
        [job.id, failed > 0 || dataErrors.length > 0 ? "PARTIALLY_COMPLETED" : "COMPLETED", summary],
      );
    }
  });
}

async function finishWithFailure(sql: Sql, job: ImportJob, code: string, message: string) {
  const safe = redactString(message).slice(0, 1000);
  await sql.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO import_job_errors (import_job_id, page, error_code, error_message) VALUES ($1::uuid, $2, $3, $4)`,
      [job.id, job.cursor.page ?? null, code, safe],
    );
    await tx.execute(
      `UPDATE import_jobs SET status = CASE WHEN processed > 0 THEN 'PARTIALLY_COMPLETED' ELSE 'FAILED' END,
         finished_at = now(), last_error = $2, error_summary = $3, updated_at = now()
       WHERE id = $1::uuid AND status = 'RUNNING'`,
      [job.id, safe, `Interrompida: ${safe}. Os registros já gravados foram preservados; use "Retomar" para continuar do ponto salvo.`],
    );
  });
}

function backoffMs(attempt: number, retryBaseMs: number, retryAfter?: number): number {
  const exp = Math.min(MAX_BACKOFF_MS, retryBaseMs * 2 ** (attempt - 1));
  const jitter = Math.floor(Math.random() * Math.min(1000, exp / 4));
  return Math.min(MAX_BACKOFF_MS, Math.max(exp + jitter, retryAfter ?? 0));
}

async function handleStepError(sql: Sql, job: ImportJob, err: unknown, retryBaseMs: number) {
  const ads = err instanceof AdsApiError ? err : null;
  const fatal = err instanceof ConfigError || (ads !== null && !ads.transient);
  const message = err instanceof Error ? err.message : "Erro desconhecido";
  const code = ads ? `ADS_${ads.kind.toUpperCase()}` : err instanceof ConfigError ? "CONFIG_ERROR" : "INTERNAL_ERROR";

  logger.warn("Falha em etapa de importação", { jobId: job.id, type: job.type, code, attempt: job.attempts + 1, err });

  if (fatal) return finishWithFailure(sql, job, code, message);

  const attempt = job.attempts + 1;
  if (attempt >= MAX_ATTEMPTS) {
    return finishWithFailure(sql, job, code, `${message} (após ${attempt} tentativas${job.cursor.page ? `, página ${job.cursor.page}` : ""})`);
  }
  const wait = backoffMs(attempt, retryBaseMs, ads?.retryAfterMs);
  await sql.execute(
    `UPDATE import_jobs SET attempts = $2, last_error = $3, next_run_at = now() + make_interval(secs => $4::double precision), updated_at = now()
     WHERE id = $1::uuid AND status = 'RUNNING'`,
    [job.id, attempt, redactString(message).slice(0, 500), wait / 1000],
  );
}

export interface ProcessOptions {
  budgetMs?: number;
  sql?: Sql;
  client?: AdsClient;
  sleep?: (ms: number) => Promise<void>;
}

export interface ProcessResult {
  /** Outro worker já está processando. */
  busy: boolean;
  steps: number;
  /** Ainda há trabalho pendente (o chamador deve agendar nova fatia). */
  more: boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Processa tarefas pendentes em fatias limitadas por tempo (compatível com funções serverless).
 * Um único worker por vez (lease global no banco); cada página é gravada atomicamente junto com o
 * cursor, então uma interrupção (timeout, restart) retoma da última página confirmada.
 */
export async function processJobs(opts: ProcessOptions = {}): Promise<ProcessResult> {
  const sql = opts.sql ?? getSql();
  const sleep = opts.sleep ?? defaultSleep;
  const budget = opts.budgetMs ?? 45_000;
  const started = Date.now();
  const owner = randomUUID();
  let steps = 0;

  if (!(await acquireLease(sql, owner))) return { busy: true, steps, more: false };

  let client: AdsClient | undefined = opts.client;
  let retryBaseMs = 2_000;

  try {
    while (Date.now() - started < budget) {
      const [job] = await sql.query<ImportJob & { waitMs: number }>(
        `SELECT ${JOB_COLUMNS}, GREATEST(0, EXTRACT(EPOCH FROM (next_run_at - now())) * 1000)::int AS "waitMs"
         FROM import_jobs WHERE status IN ('PENDING','RUNNING') ORDER BY created_at LIMIT 1`,
      );
      if (!job) return { busy: false, steps, more: false };

      if (job.status === "PENDING") {
        await sql.execute(
          `UPDATE import_jobs SET status = 'RUNNING', started_at = COALESCE(started_at, now()), updated_at = now()
           WHERE id = $1::uuid AND status = 'PENDING'`,
          [job.id],
        );
        job.status = "RUNNING";
      }

      if (job.waitMs > 0) {
        const remaining = budget - (Date.now() - started);
        if (job.waitMs >= remaining) return { busy: false, steps, more: true };
        await sleep(job.waitMs);
        if (!(await renewLease(sql, owner))) return { busy: false, steps, more: true };
        continue;
      }

      try {
        client ??= getAdsClient(); // ConfigError aqui encerra a tarefa como FAILED (sem retentativa)
        retryBaseMs = client.retryBaseMs;
        const fetched = await fetchStep(job, client, sql);
        await commitStep(sql, job, owner, fetched);
        steps += 1;
      } catch (err) {
        if (err instanceof LeaseLostError) return { busy: false, steps, more: true };
        if (err instanceof JobNoLongerRunningError) continue; // cancelada durante a etapa
        await handleStepError(sql, job, err, retryBaseMs);
      }
    }
    return { busy: false, steps, more: true };
  } finally {
    await releaseLease(sql, owner).catch(() => undefined);
  }
}
