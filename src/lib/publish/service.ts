import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { getStore } from "../store";
import { isUniqueViolation, type Sql } from "../sql";
import { getCapabilities } from "../meli/capabilities";
import { recordEvent } from "./events";
import { fingerprint, loadContext } from "./payload";
import { syncItem } from "./listings";

/**
 * Comando de publicação confirmado pelo administrador.
 *
 * Proteções contra anúncio duplicado (sem garantia absoluta, pois POST /items não é idempotente no ML):
 * - só publica rascunho VALIDATED cuja versão e impressão digital batem com a confirmação;
 * - chave de idempotência (rascunho + versão + conteúdo): repetir o mesmo comando devolve o mesmo job;
 * - índice único parcial: no máximo um job ativo/incerto por rascunho;
 * - unicidade de anúncio por produto e conta (marketplace_listings);
 * - SELLER_SKU "ADS-<id>" permite conferir no ML se o anúncio já existe antes de enviar e após falhas.
 */
export const PUBLICATION_JOB_STATUSES = ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "UNKNOWN", "CANCELED"] as const;
export type PublicationJobStatus = (typeof PUBLICATION_JOB_STATUSES)[number];

export interface PublicationJob {
  id: string;
  listingDraftId: number;
  productId: number;
  accountId: string;
  batchId: string | null;
  status: PublicationJobStatus;
  requestedBy: string;
  draftVersion: number;
  fingerprint: string;
  idempotencyKey: string;
  attemptCount: number;
  reconcileCount: number;
  createSentAt: Date | null;
  nextRunAt: Date;
  marketplaceItemId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const JOB_SELECT = `SELECT j.id::text AS id, j.listing_draft_id AS "listingDraftId", j.product_id AS "productId",
  j.account_id AS "accountId", j.batch_id::text AS "batchId", j.status, j.requested_by AS "requestedBy",
  j.draft_version AS "draftVersion", j.fingerprint, j.idempotency_key AS "idempotencyKey", j.attempt_count AS "attemptCount",
  j.reconcile_count AS "reconcileCount", j.create_sent_at AS "createSentAt", j.next_run_at AS "nextRunAt",
  j.marketplace_item_id AS "marketplaceItemId", j.error_code AS "errorCode", j.error_message AS "errorMessage",
  j.started_at AS "startedAt", j.completed_at AS "completedAt", j.created_at AS "createdAt", j.updated_at AS "updatedAt"
  FROM marketplace_publication_jobs j`;

export class PublishRejectedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

export interface PublishRequest {
  draftId: number;
  draftVersion: number;
  fingerprint: string;
  requestedBy: string;
  batchId?: string | null;
}

export function idempotencyKey(draftId: number, version: number, fp: string): string {
  return createHash("sha256").update(`publish:${draftId}:${version}:${fp}`).digest("hex");
}

/**
 * Registra a intenção de publicação (job QUEUED) de forma atômica. Não chama o Mercado Livre:
 * o envio acontece no worker. Retorna o job existente quando o mesmo comando é repetido.
 */
export async function requestPublication(sql: Sql, req: PublishRequest): Promise<{ job: PublicationJob; replayed: boolean }> {
  const caps = await getCapabilities(sql);
  if (!caps.connected || !caps.meliUserId) throw new PublishRejectedError("account_not_connected", "Conta Mercado Livre não conectada.");
  if (!caps.canWrite) throw new PublishRejectedError("account_no_write_scope", "A autorização da conta não inclui permissão de escrita.");
  const model = caps.publicationModel ?? "CLASSIC";
  const key = idempotencyKey(req.draftId, req.draftVersion, req.fingerprint);

  try {
    return await sql.transaction(async (tx) => {
      const [existing] = await tx.query<PublicationJob>(`${JOB_SELECT} WHERE j.idempotency_key = $1`, [key]);
      if (existing && !["CANCELED", "FAILED"].includes(existing.status)) return { job: existing, replayed: true };
      if (existing) {
        // Pedido anterior encerrado sem criar anúncio: libera a chave para um novo pedido, preservando o histórico.
        await tx.execute(`UPDATE marketplace_publication_jobs SET idempotency_key = idempotency_key || ':encerrado:' || id::text WHERE id = $1::uuid`, [existing.id]);
      }

      const [lock] = await tx.query<{ status: string; version: number; validatedVersion: number | null; validatedFingerprint: string | null }>(
        `SELECT status, version, validated_version AS "validatedVersion", validated_fingerprint AS "validatedFingerprint"
         FROM listing_drafts WHERE id = $1::int FOR UPDATE`,
        [req.draftId],
      );
      if (!lock) throw new PublishRejectedError("not_found", "Rascunho não encontrado.", 404);
      if (lock.status === "PUBLISHED") throw new PublishRejectedError("already_published", "Este rascunho já foi publicado.");
      if (lock.status === "PUBLISHING" || lock.status === "UNKNOWN") throw new PublishRejectedError("publication_in_progress", "Já existe uma publicação em andamento ou com resultado pendente para este rascunho.");
      if (lock.status !== "VALIDATED") throw new PublishRejectedError("not_validated", "Valide o anúncio antes de publicar.");
      if (lock.version !== req.draftVersion || lock.validatedVersion !== lock.version) {
        throw new PublishRejectedError("version_mismatch", "O rascunho mudou depois da validação/revisão. Valide novamente.");
      }
      if (lock.validatedFingerprint !== req.fingerprint) {
        throw new PublishRejectedError("fingerprint_mismatch", "O conteúdo confirmado não corresponde ao conteúdo validado. Revise novamente.");
      }
      // Recalcula agora (imagens podem ter mudado sem alterar a versão do rascunho).
      const ctx = (await loadContext(tx, req.draftId, model))!;
      if (fingerprint(ctx) !== req.fingerprint) {
        throw new PublishRejectedError("content_changed", "Imagens ou dados mudaram depois da validação. Valide novamente.");
      }
      const [listed] = await tx.query<{ itemId: string }>(
        `SELECT marketplace_item_id AS "itemId" FROM marketplace_listings
         WHERE product_id = $1::int AND marketplace_account_id = $2::text AND status NOT IN ('closed', 'deleted')`,
        [ctx.draft.productId, caps.meliUserId],
      );
      if (listed) throw new PublishRejectedError("already_published", `Produto já publicado nesta conta (${listed.itemId}).`);

      const [job] = await tx.query<PublicationJob>(
        `WITH ins AS (
           INSERT INTO marketplace_publication_jobs (listing_draft_id, product_id, account_id, batch_id, status, requested_by,
             draft_version, fingerprint, idempotency_key)
           VALUES ($1::int, $2::int, $3::text, $4::uuid, 'QUEUED', $5::text, $6::int, $7::text, $8::text)
           RETURNING *)
         ${JOB_SELECT.replace("FROM marketplace_publication_jobs j", "FROM ins j")}`,
        [req.draftId, ctx.draft.productId, caps.meliUserId, req.batchId ?? null, req.requestedBy, req.draftVersion, req.fingerprint, key],
      );
      await tx.execute(`UPDATE listing_drafts SET status = 'PUBLISHING', last_error = NULL, updated_at = now() WHERE id = $1::int`, [req.draftId]);
      await recordEvent(tx, {
        draftId: req.draftId,
        jobId: job.id,
        type: "publication_requested",
        from: "VALIDATED",
        to: "PUBLISHING",
        details: { version: req.draftVersion, requestedBy: req.requestedBy, batchId: req.batchId ?? null, account: caps.meliUserId },
      });
      return { job, replayed: false };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new PublishRejectedError("publication_in_progress", "Já existe uma publicação ativa para este rascunho.");
    throw err;
  }
}

export interface BatchItem {
  draftId: number;
  draftVersion: number;
  fingerprint: string;
}

export async function requestBatch(sql: Sql, items: BatchItem[], requestedBy: string) {
  const batchId = randomUUID();
  const results: { draftId: number; ok: boolean; jobId?: string; code?: string; message?: string }[] = [];
  for (const item of items) {
    try {
      const { job } = await requestPublication(sql, { ...item, requestedBy, batchId });
      results.push({ draftId: item.draftId, ok: true, jobId: job.id });
    } catch (err) {
      results.push({
        draftId: item.draftId,
        ok: false,
        code: err instanceof PublishRejectedError ? err.code : "internal_error",
        message: err instanceof PublishRejectedError ? err.message : "Erro interno",
      });
    }
  }
  return { batchId, results };
}

export async function getPublicationJob(sql: Sql, id: string): Promise<PublicationJob | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [job] = await sql.query<PublicationJob>(`${JOB_SELECT} WHERE j.id = $1::uuid`, [id]);
  return job ?? null;
}

export async function listPublicationJobs(sql: Sql, opts: { status?: string; draftId?: number; batchId?: string; limit?: number; offset?: number } = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.status) {
    params.push(opts.status);
    where.push(`j.status = $${params.length}::text`);
  }
  if (opts.draftId) {
    params.push(opts.draftId);
    where.push(`j.listing_draft_id = $${params.length}::int`);
  }
  if (opts.batchId) {
    params.push(opts.batchId);
    where.push(`j.batch_id = $${params.length}::uuid`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [{ total }] = await sql.query<{ total: number }>(`SELECT count(*)::int AS total FROM marketplace_publication_jobs j ${clause}`, params);
  params.push(Math.min(Math.max(opts.limit ?? 50, 1), 200), Math.max(opts.offset ?? 0, 0));
  const items = await sql.query<PublicationJob & { productName: string; adsProductId: number }>(
    `${JOB_SELECT.replace("FROM marketplace_publication_jobs j", `, COALESCE(p.name_custom, p.name_original) AS "productName", p.ads_product_id AS "adsProductId"
       FROM marketplace_publication_jobs j JOIN products p ON p.id = j.product_id`)}
     ${clause} ORDER BY j.created_at DESC LIMIT $${params.length - 1}::int OFFSET $${params.length}::int`,
    params,
  );
  return { items, total };
}

export async function listAttempts(sql: Sql, jobId: string) {
  return sql.query<{ id: string; requestId: string; operation: string; httpStatus: number | null; errorCode: string | null; errorMessage: string | null; durationMs: number | null; sanitizedRequest: unknown; sanitizedResponse: unknown; createdAt: Date }>(
    `SELECT id::text AS id, request_id AS "requestId", operation, http_status AS "httpStatus", error_code AS "errorCode",
            error_message AS "errorMessage", duration_ms AS "durationMs", sanitized_request AS "sanitizedRequest",
            sanitized_response AS "sanitizedResponse", created_at AS "createdAt"
     FROM marketplace_publication_attempts WHERE publication_job_id = $1::uuid ORDER BY id`,
    [jobId],
  );
}

/** Cancela apenas jobs que ainda não começaram (nenhuma chamada de criação foi feita). */
export async function cancelPublicationJob(sql: Sql, id: string): Promise<PublicationJob | null> {
  return sql.transaction(async (tx) => {
    const [job] = await tx.query<PublicationJob>(
      `UPDATE marketplace_publication_jobs SET status = 'CANCELED', completed_at = now(), updated_at = now(),
         error_message = 'Cancelado pelo administrador antes do envio'
       WHERE id = $1::uuid AND status = 'QUEUED' AND create_sent_at IS NULL
       RETURNING id::text AS id, listing_draft_id AS "listingDraftId"`,
      [id],
    );
    if (!job) return null;
    await tx.execute(`UPDATE listing_drafts SET status = 'VALIDATED', updated_at = now() WHERE id = $1::int AND status = 'PUBLISHING'`, [job.listingDraftId]);
    await recordEvent(tx, { draftId: job.listingDraftId, jobId: id, type: "publication_canceled", from: "PUBLISHING", to: "VALIDATED" });
    return getPublicationJob(tx, id);
  });
}

export async function cancelBatch(sql: Sql, batchId: string): Promise<number> {
  const queued = await sql.query<{ id: string }>(
    `SELECT id::text AS id FROM marketplace_publication_jobs WHERE batch_id = $1::uuid AND status = 'QUEUED' AND create_sent_at IS NULL`,
    [batchId],
  );
  let n = 0;
  for (const j of queued) if (await cancelPublicationJob(sql, j.id)) n++;
  return n;
}

/** Quem está logado (sessão de administrador única): identificador curto e não sensível. */
export function requesterFromSession(sid: string | undefined | null): string {
  return `admin:${(sid ?? "desconhecido").slice(0, 8)}`;
}

export async function currentAccountId(): Promise<string | null> {
  const conn = await getStore().getCurrentConnection();
  return conn?.meliUserId ?? null;
}

/**
 * Libera uma nova publicação de um produto cujo anúncio foi encerrado ou excluído no Mercado Livre.
 *
 * Antes de liberar, relê o anúncio no ML (somente leitura) para não confiar em status desatualizado.
 * O rascunho volta a DRAFT com nova versão (exige nova validação e nova confirmação); o anúncio
 * antigo fica guardado como histórico. Nada é enviado ao ML aqui.
 */
export async function reopenForRepublish(sql: Sql, draftId: number, requestedBy: string): Promise<{ previousItemId: string; previousStatus: string }> {
  const [current] = await sql.query<{ status: string; itemId: string | null }>(
    `SELECT d.status, ml.marketplace_item_id AS "itemId"
     FROM listing_drafts d
     LEFT JOIN LATERAL (
       SELECT marketplace_item_id FROM marketplace_listings x WHERE x.listing_draft_id = d.id
       ORDER BY (x.status NOT IN ('closed', 'deleted')) DESC, x.id DESC LIMIT 1
     ) ml ON true
     WHERE d.id = $1::int`,
    [draftId],
  );
  if (!current) throw new PublishRejectedError("not_found", "Rascunho não encontrado.", 404);
  if (current.status !== "PUBLISHED" || !current.itemId) {
    throw new PublishRejectedError("not_published", "Só é possível republicar um rascunho cujo anúncio foi publicado e depois encerrado ou excluído.");
  }
  const status = await syncItem(sql, current.itemId);
  if (status !== "closed" && status !== "deleted") {
    throw new PublishRejectedError(
      "listing_still_active",
      `O anúncio ${current.itemId} ainda não está encerrado nem excluído no Mercado Livre (status: ${status ?? "desconhecido"}). Encerre ou exclua no ML antes de republicar.`,
    );
  }
  const changed = await sql.execute(
    `UPDATE listing_drafts SET status = 'DRAFT', version = version + 1, validated_version = NULL, validated_fingerprint = NULL,
       validated_at = NULL, validation_result = NULL, last_error = NULL, updated_at = now()
     WHERE id = $1::int AND status = 'PUBLISHED'`,
    [draftId],
  );
  if (!changed) throw new PublishRejectedError("conflict", "O rascunho mudou durante a operação. Recarregue a página.");
  await recordEvent(sql, {
    draftId,
    type: "reopened_for_republish",
    from: "PUBLISHED",
    to: "DRAFT",
    details: { previousItemId: current.itemId, previousStatus: status, requestedBy },
  });
  return { previousItemId: current.itemId, previousStatus: status };
}
