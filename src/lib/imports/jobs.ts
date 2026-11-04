import "server-only";
import { isUniqueViolation, type Sql } from "../sql";

export const JOB_TYPES = ["PRODUCTS", "PRICE_TABLES", "PRICES", "STOCKS"] as const;
export type JobType = (typeof JOB_TYPES)[number];
export type JobStatus = "PENDING" | "RUNNING" | "COMPLETED" | "PARTIALLY_COMPLETED" | "FAILED" | "CANCELED";

export const ACTIVE_STATUSES: JobStatus[] = ["PENDING", "RUNNING"];

export interface JobParams {
  /** Restringe a importação a produtos específicos (ids da ADS). */
  adsProductIds?: number[];
}

export interface JobCursor {
  phase?: string;
  page?: number;
  chunk?: number;
  /** true quando todas as páginas foram percorridas. */
  done?: boolean;
}

export interface ImportJob {
  id: string;
  type: JobType;
  status: JobStatus;
  params: JobParams;
  cursor: JobCursor;
  total: number | null;
  processed: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  attempts: number;
  nextRunAt: Date;
  lastError: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  errorSummary: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ImportJobErrorRow {
  id: string;
  externalProductId: number | null;
  page: number | null;
  errorCode: string;
  errorMessage: string;
  createdAt: Date;
}

export const JOB_COLUMNS = `id::text AS id, type, status, params, cursor, total, processed, created, updated, unchanged, failed,
  attempts, next_run_at AS "nextRunAt", last_error AS "lastError", started_at AS "startedAt", finished_at AS "finishedAt",
  error_summary AS "errorSummary", created_at AS "createdAt", updated_at AS "updatedAt"`;

export class JobConflictError extends Error {
  constructor(readonly activeJobId: string | null) {
    super("Já existe uma importação deste tipo em andamento");
    this.name = "JobConflictError";
  }
}

async function findActive(sql: Sql, type: JobType): Promise<string | null> {
  const rows = await sql.query<{ id: string }>(
    `SELECT id::text AS id FROM import_jobs WHERE type = $1 AND status IN ('PENDING','RUNNING') LIMIT 1`,
    [type],
  );
  return rows[0]?.id ?? null;
}

/** Cria uma tarefa. Garante (via índice único parcial) no máximo uma ativa por tipo. */
export async function createJob(sql: Sql, type: JobType, params: JobParams = {}): Promise<ImportJob> {
  try {
    const rows = await sql.query<ImportJob>(
      `INSERT INTO import_jobs (type, status, params, cursor) VALUES ($1, 'PENDING', $2::jsonb, '{}'::jsonb)
       ON CONFLICT (type) WHERE status IN ('PENDING','RUNNING') DO NOTHING
       RETURNING ${JOB_COLUMNS}`,
      [type, JSON.stringify(params)],
    );
    if (rows[0]) return rows[0];
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
  throw new JobConflictError(await findActive(sql, type));
}

export async function getJob(sql: Sql, id: string): Promise<ImportJob | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const rows = await sql.query<ImportJob>(`SELECT ${JOB_COLUMNS} FROM import_jobs WHERE id = $1::uuid`, [id]);
  return rows[0] ?? null;
}

export async function listJobs(sql: Sql, opts: { limit?: number; offset?: number; type?: JobType; status?: JobStatus } = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.type) {
    params.push(opts.type);
    where.push(`type = $${params.length}`);
  }
  if (opts.status) {
    params.push(opts.status);
    where.push(`status = $${params.length}`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  params.push(Math.min(Math.max(opts.limit ?? 20, 1), 100), Math.max(opts.offset ?? 0, 0));
  const items = await sql.query<ImportJob>(
    `SELECT ${JOB_COLUMNS} FROM import_jobs ${clause} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const [{ total }] = await sql.query<{ total: number }>(`SELECT count(*)::int AS total FROM import_jobs ${clause}`, params.slice(0, -2));
  return { items, total };
}

export async function listJobErrors(sql: Sql, jobId: string, limit = 200, offset = 0) {
  const items = await sql.query<ImportJobErrorRow>(
    `SELECT id::text AS id, external_product_id AS "externalProductId", page, error_code AS "errorCode",
            error_message AS "errorMessage", created_at AS "createdAt"
     FROM import_job_errors WHERE import_job_id = $1::uuid ORDER BY id LIMIT $2 OFFSET $3`,
    [jobId, Math.min(Math.max(limit, 1), 500), Math.max(offset, 0)],
  );
  const [{ total }] = await sql.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM import_job_errors WHERE import_job_id = $1::uuid`,
    [jobId],
  );
  return { items, total };
}

export async function cancelJob(sql: Sql, id: string): Promise<ImportJob | null> {
  const rows = await sql.query<ImportJob>(
    `UPDATE import_jobs SET status = 'CANCELED', finished_at = now(), updated_at = now(),
       error_summary = COALESCE(error_summary, 'Cancelada pelo administrador')
     WHERE id = $1::uuid AND status IN ('PENDING','RUNNING') RETURNING ${JOB_COLUMNS}`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Reexecuta uma tarefa encerrada. Se ela foi interrompida no meio (cursor não concluído), retoma
 * do ponto salvo; senão cria uma nova tarefa com os mesmos parâmetros. Em ambos os casos é seguro,
 * pois as gravações são UPSERTs idempotentes.
 */
export async function retryJob(sql: Sql, id: string): Promise<{ job: ImportJob; resumed: boolean }> {
  const job = await getJob(sql, id);
  if (!job) throw new Error("not_found");
  if (ACTIVE_STATUSES.includes(job.status)) throw new JobConflictError(job.id);

  if (!job.cursor.done) {
    try {
      const rows = await sql.query<ImportJob>(
        `UPDATE import_jobs SET status = 'PENDING', attempts = 0, next_run_at = now(), finished_at = NULL,
           error_summary = NULL, last_error = NULL, updated_at = now()
         WHERE id = $1::uuid AND status IN ('FAILED','PARTIALLY_COMPLETED','CANCELED')
         RETURNING ${JOB_COLUMNS}`,
        [id],
      );
      if (rows[0]) return { job: rows[0], resumed: true };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      throw new JobConflictError(await findActive(sql, job.type));
    }
  }
  return { job: await createJob(sql, job.type, job.params), resumed: false };
}

/** Há tarefa ativa pronta para rodar e nenhum worker com lease válido? (usado para retomar após interrupções) */
export async function needsWorker(sql: Sql): Promise<boolean> {
  const rows = await sql.query<{ needed: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM import_jobs WHERE status IN ('PENDING','RUNNING') AND next_run_at <= now() + interval '1 second')
        AND NOT EXISTS (SELECT 1 FROM worker_leases WHERE name = $1 AND lease_until > now()) AS needed`,
    [WORKER_LEASE],
  );
  return rows[0]?.needed === true;
}

// ---------------------------------------------------------------------------
// Lease global do worker
// ---------------------------------------------------------------------------

export const WORKER_LEASE = "ads-import";
export const LEASE_SECONDS = 90;

export async function acquireLease(sql: Sql, owner: string): Promise<boolean> {
  const rows = await sql.query<{ owner: string }>(
    `INSERT INTO worker_leases (name, owner, lease_until) VALUES ($1, $2, now() + make_interval(secs => $3::int))
     ON CONFLICT (name) DO UPDATE SET owner = EXCLUDED.owner, lease_until = EXCLUDED.lease_until
     WHERE worker_leases.lease_until < now() OR worker_leases.owner = EXCLUDED.owner
     RETURNING owner`,
    [WORKER_LEASE, owner, LEASE_SECONDS],
  );
  return rows[0]?.owner === owner;
}

/** Renova o lease; retorna false se outro worker assumiu (o chamador deve parar). */
export async function renewLease(sql: Sql, owner: string): Promise<boolean> {
  const n = await sql.execute(
    `UPDATE worker_leases SET lease_until = now() + make_interval(secs => $3::int) WHERE name = $1 AND owner = $2`,
    [WORKER_LEASE, owner, LEASE_SECONDS],
  );
  return n > 0;
}

export async function releaseLease(sql: Sql, owner: string): Promise<void> {
  await sql.execute(`DELETE FROM worker_leases WHERE name = $1 AND owner = $2`, [WORKER_LEASE, owner]);
}
