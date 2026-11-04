import "server-only";
import { randomUUID } from "node:crypto";
import { logger, redactString, sanitize } from "../logger";
import { meliRequest, MeliHttpError } from "../meli/api";
import { getCapabilities } from "../meli/capabilities";
import { MeliAuthError } from "../meli/tokens";
import { acquireLease, releaseLease, renewLease } from "../imports/jobs";
import { getSql, type Sql } from "../sql";
import { getStorage } from "../storage/supabase";
import { recordEvent } from "./events";
import { buildItemPayload, fingerprint, loadContext, sellerSku, type PublishContext } from "./payload";
import { JOB_SELECT, type PublicationJob } from "./service";

/**
 * Worker de publicação (fila persistente, concorrência 1, lease "ml-publish").
 *
 * Sequência por job: conferência prévia por SELLER_SKU → upload de imagens → marca create_sent_at
 * (write-ahead) → POST /items → registra anúncio → POST /items/{id}/description.
 *
 * Resultado incerto (timeout, 5xx, queda de rede depois do envio) → UNKNOWN e conciliação por
 * SELLER_SKU. O POST nunca é reenviado automaticamente nesse caso.
 */
export const PUBLISH_LEASE = "ml-publish";
export const MAX_SEND_ATTEMPTS = 5;
export const MAX_RECONCILE = 6;
const SPACING_MS = 1000;

type Step = "done" | "continue";

async function logAttempt(
  sql: Sql,
  jobId: string,
  a: { operation: string; request?: unknown; response?: unknown; status?: number | null; code?: string | null; message?: string | null; durationMs?: number | null; requestId?: string },
) {
  await sql.execute(
    `INSERT INTO marketplace_publication_attempts (publication_job_id, request_id, operation, sanitized_request, sanitized_response,
       http_status, error_code, error_message, duration_ms)
     VALUES ($1::uuid, $2::text, $3::text, $4::jsonb, $5::jsonb, $6::int, $7::text, $8::text, $9::int)`,
    [
      jobId,
      a.requestId ?? randomUUID(),
      a.operation,
      a.request === undefined ? null : JSON.stringify(sanitize(a.request)),
      a.response === undefined ? null : JSON.stringify(sanitize(a.response)),
      a.status ?? null,
      a.code ?? null,
      a.message ? redactString(a.message).slice(0, 1000) : null,
      a.durationMs ?? null,
    ],
  );
}

function errorInfo(e: unknown) {
  if (e instanceof MeliHttpError) {
    const causes = e.causes.map((c) => `${c.code ?? ""}: ${c.message ?? ""}`.trim()).filter(Boolean);
    return { status: e.status || null, code: e.code ?? e.kind, message: [e.message, ...causes].join(" | ").slice(0, 1000), response: e.body };
  }
  if (e instanceof MeliAuthError) return { status: null, code: e.code, message: e.message, response: undefined };
  return { status: null, code: "internal_error", message: e instanceof Error ? e.message : "Erro desconhecido", response: undefined };
}

interface ItemSnapshot {
  id: string;
  permalink?: string | null;
  status?: string | null;
  sub_status?: string[] | null;
  user_product_id?: string | null;
  family_id?: string | number | null;
  price?: number | null;
  available_quantity?: number | null;
  listing_type_id?: string | null;
  category_id?: string | null;
}

/** Procura no ML um anúncio da conta com o SELLER_SKU do produto (conciliação). */
export async function findExistingItem(accountId: string, sku: string): Promise<ItemSnapshot | null> {
  if (!/^\d{1,20}$/.test(accountId)) return null;
  const { data } = await meliRequest<{ results?: unknown[] }>(`/users/${accountId}/items/search`, { auth: true, query: { seller_sku: sku } });
  const ids = (data?.results ?? []).filter((r): r is string => typeof r === "string" && /^MLB\d+$/.test(r)).slice(0, 10);
  // Anúncios encerrados ou excluídos (de uma publicação anterior do mesmo produto) não contam:
  // só um anúncio vigente com o SKU indica que o produto já está publicado.
  for (const id of ids) {
    const item = await meliRequest<ItemSnapshot>(`/items/${id}`, { auth: true });
    if (!isEndedItem(item.data)) return item.data;
  }
  return null;
}

export function isEndedItem(item: Pick<ItemSnapshot, "status" | "sub_status">): boolean {
  return item.status === "closed" || (item.sub_status ?? []).includes("deleted");
}

async function finalizeSuccess(sql: Sql, job: PublicationJob, ctx: PublishContext, item: ItemSnapshot, how: "created" | "reconciled" | "already_existed") {
  const listingId = await sql.transaction(async (tx) => {
    const [row] = await tx.query<{ id: number }>(
      `INSERT INTO marketplace_listings (product_id, ads_product_id, listing_draft_id, marketplace_account_id, marketplace_item_id,
         user_product_id, family_id, category_id, listing_type, price, quantity, status, permalink, published_at, last_synced_at)
       VALUES ($1::int, $2::int, $3::int, $4::text, $5::text, $6::text, $7::text, $8::text, $9::text, $10::numeric, $11::int, $12::text, $13::text, now(), now())
       ON CONFLICT (marketplace_item_id) DO UPDATE SET updated_at = now()
       RETURNING id`,
      [
        ctx.draft.productId,
        ctx.draft.adsProductId,
        ctx.draft.id,
        job.accountId,
        item.id,
        item.user_product_id ?? null,
        item.family_id === null || item.family_id === undefined ? null : String(item.family_id),
        item.category_id ?? ctx.draft.marketplaceCategoryId,
        item.listing_type_id ?? ctx.draft.listingTypeId,
        String(item.price ?? ctx.draft.listingPrice),
        item.available_quantity ?? ctx.draft.listingQuantity ?? 0,
        item.status ?? "unknown",
        item.permalink ?? null,
      ],
    );
    await tx.execute(
      `UPDATE marketplace_publication_jobs SET status = 'SUCCEEDED', marketplace_item_id = $2::text, completed_at = now(),
         error_code = NULL, error_message = NULL, updated_at = now() WHERE id = $1::uuid`,
      [job.id, item.id],
    );
    await tx.execute(`UPDATE listing_drafts SET status = 'PUBLISHED', last_error = NULL, updated_at = now() WHERE id = $1::int`, [ctx.draft.id]);
    await recordEvent(tx, { draftId: ctx.draft.id, listingId: row.id, jobId: job.id, type: `published_${how}`, from: job.status === "UNKNOWN" ? "UNKNOWN" : "PUBLISHING", to: "PUBLISHED", details: { itemId: item.id, permalink: item.permalink ?? null } });
    return row.id;
  });
  return listingId;
}

async function finalizeFailure(sql: Sql, job: PublicationJob, code: string, message: string) {
  await sql.transaction(async (tx) => {
    await tx.execute(
      `UPDATE marketplace_publication_jobs SET status = 'FAILED', error_code = $2::text, error_message = $3::text, completed_at = now(), updated_at = now()
       WHERE id = $1::uuid`,
      [job.id, code, message],
    );
    await tx.execute(`UPDATE listing_drafts SET status = 'FAILED', last_error = $2::text, updated_at = now() WHERE id = $1::int`, [job.listingDraftId, message]);
    await recordEvent(tx, { draftId: job.listingDraftId, jobId: job.id, type: "publication_failed", from: "PUBLISHING", to: "FAILED", details: { code, message } });
  });
}

async function markUnknown(sql: Sql, job: PublicationJob, code: string, message: string) {
  await sql.transaction(async (tx) => {
    await tx.execute(
      `UPDATE marketplace_publication_jobs SET status = 'UNKNOWN', error_code = $2::text, error_message = $3::text,
         next_run_at = now() + interval '20 seconds', updated_at = now() WHERE id = $1::uuid`,
      [job.id, code, message],
    );
    await tx.execute(`UPDATE listing_drafts SET status = 'UNKNOWN', last_error = $2::text, updated_at = now() WHERE id = $1::int`, [job.listingDraftId, message]);
    await recordEvent(tx, { draftId: job.listingDraftId, jobId: job.id, type: "publication_unknown", from: "PUBLISHING", to: "UNKNOWN", details: { code, message } });
  });
}

/** Busca os bytes da imagem somente no armazenamento do próprio integrador (proteção contra SSRF). */
async function fetchOwnImage(publicUrl: string): Promise<Blob> {
  const allowed = new URL(getStorage().publicUrl("probe")).origin;
  const url = new URL(publicUrl);
  if (url.origin !== allowed) throw new MeliHttpError("bad_request", 0, "Imagem fora do armazenamento do integrador");
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: "error" });
  if (!res.ok) throw new MeliHttpError("server", res.status, `Não foi possível ler a imagem (HTTP ${res.status})`);
  return res.blob();
}

/** Envia imagens ainda sem ID no ML (POST /pictures/items/upload) e guarda o ID retornado (sem reenvio). */
async function uploadPictures(sql: Sql, job: PublicationJob, ctx: PublishContext): Promise<void> {
  for (const img of ctx.images) {
    if (img.mlPictureId) continue;
    const blob = await fetchOwnImage(img.publicUrl);
    const form = new FormData();
    form.append("file", blob, img.storagePath.split("/").pop() ?? "imagem");
    const requestId = randomUUID();
    try {
      const res = await meliRequest<{ id?: string }>("/pictures/items/upload", { method: "POST", auth: true, form, timeoutMs: 60_000 });
      const pictureId = res.data?.id;
      await logAttempt(sql, job.id, { operation: "upload_picture", requestId, request: { imageId: img.id }, response: { id: pictureId }, status: res.status, durationMs: res.durationMs });
      if (!pictureId) throw new MeliHttpError("server", res.status, "Upload de imagem sem ID na resposta");
      await sql.execute(`UPDATE product_images SET ml_picture_id = $2::text, ml_picture_at = now() WHERE id = $1::int`, [img.id, pictureId]);
      img.mlPictureId = pictureId;
    } catch (e) {
      const info = errorInfo(e);
      await logAttempt(sql, job.id, { operation: "upload_picture", requestId, request: { imageId: img.id }, response: info.response, status: info.status, code: info.code, message: info.message });
      throw e;
    }
  }
}

async function sendDescription(sql: Sql, job: PublicationJob, ctx: PublishContext, itemId: string, listingId: number) {
  const text = ctx.draft.description?.trim();
  if (!text) {
    await sql.execute(`UPDATE marketplace_listings SET description_status = 'none' WHERE id = $1::int`, [listingId]);
    return;
  }
  try {
    const res = await meliRequest(`/items/${itemId}/description`, { method: "POST", auth: true, body: { plain_text: text } });
    await logAttempt(sql, job.id, { operation: "description", request: { length: text.length }, status: res.status, durationMs: res.durationMs });
    await sql.execute(`UPDATE marketplace_listings SET description_status = 'sent' WHERE id = $1::int`, [listingId]);
  } catch (e) {
    const info = errorInfo(e);
    await logAttempt(sql, job.id, { operation: "description", request: { length: text.length }, response: info.response, status: info.status, code: info.code, message: info.message });
    await sql.execute(`UPDATE marketplace_listings SET description_status = 'failed' WHERE id = $1::int`, [listingId]);
    await recordEvent(sql, { draftId: ctx.draft.id, listingId, jobId: job.id, type: "description_failed", details: { message: info.message } });
  }
}

async function processQueued(sql: Sql, job: PublicationJob): Promise<void> {
  await sql.execute(
    `UPDATE marketplace_publication_jobs SET status = 'RUNNING', attempt_count = attempt_count + 1,
       started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1::uuid`,
    [job.id],
  );
  const caps = await getCapabilities(sql);
  const ctx = await loadContext(sql, job.listingDraftId, caps.publicationModel ?? "CLASSIC");
  if (!ctx) return finalizeFailure(sql, job, "draft_missing", "Rascunho não encontrado.");
  if (ctx.draft.version !== job.draftVersion || fingerprint(ctx) !== job.fingerprint) {
    return finalizeFailure(sql, job, "content_changed", "O conteúdo mudou depois da confirmação. Valide e confirme novamente.");
  }
  if (caps.meliUserId && caps.meliUserId !== job.accountId) {
    return finalizeFailure(sql, job, "account_changed", "A conta Mercado Livre conectada mudou depois da confirmação.");
  }
  const sku = sellerSku(ctx.draft.adsProductId);

  try {
    // 1. Já existe anúncio com este SELLER_SKU? (evita duplicar, inclusive após perda de estado)
    const existing = await findExistingItem(job.accountId, sku);
    await logAttempt(sql, job.id, { operation: "precheck_seller_sku", request: { seller_sku: sku }, response: { found: existing?.id ?? null } });
    if (existing) {
      await finalizeSuccess(sql, job, ctx, existing, "already_existed");
      return;
    }
    // 2. Imagens
    await uploadPictures(sql, job, ctx);
  } catch (e) {
    // Nada foi criado ainda: pode tentar de novo com segurança, até o limite.
    const info = errorInfo(e);
    const transient = e instanceof MeliHttpError && !e.definitelyNotProcessed ? true : e instanceof MeliHttpError && e.kind === "rate_limited";
    if (transient && job.attemptCount + 1 < MAX_SEND_ATTEMPTS) {
      const wait = Math.min(60, 5 * 2 ** job.attemptCount);
      await sql.execute(
        `UPDATE marketplace_publication_jobs SET status = 'QUEUED', error_code = $2::text, error_message = $3::text,
           next_run_at = now() + make_interval(secs => $4::int), updated_at = now() WHERE id = $1::uuid`,
        [job.id, info.code, info.message, wait],
      );
      return;
    }
    return finalizeFailure(sql, job, info.code ?? "prepare_failed", info.message);
  }

  // 3. Write-ahead: a partir daqui um erro sem resposta torna o resultado incerto.
  const payload = buildItemPayload(ctx, { pictures: "ids" });
  const requestId = randomUUID();
  await sql.execute(`UPDATE marketplace_publication_jobs SET create_sent_at = now(), updated_at = now() WHERE id = $1::uuid`, [job.id]);
  try {
    const res = await meliRequest<ItemSnapshot>("/items", { method: "POST", auth: true, body: payload, timeoutMs: 30_000 });
    await logAttempt(sql, job.id, { operation: "create_item", requestId, request: payload, response: res.data, status: res.status, durationMs: res.durationMs });
    if (!res.data?.id) {
      return markUnknown(sql, job, "no_item_id", "Resposta do Mercado Livre sem ID do anúncio; conciliando.");
    }
    const listingId = await finalizeSuccess(sql, job, ctx, res.data, "created");
    await sendDescription(sql, job, ctx, res.data.id, listingId);
  } catch (e) {
    const info = errorInfo(e);
    await logAttempt(sql, job.id, { operation: "create_item", requestId, request: payload, response: info.response, status: info.status, code: info.code, message: info.message });
    if (e instanceof MeliHttpError && e.kind === "rate_limited" && job.attemptCount + 1 < MAX_SEND_ATTEMPTS) {
      // 429: o ML recusou antes de processar — reenfileira sem risco.
      await sql.execute(
        `UPDATE marketplace_publication_jobs SET status = 'QUEUED', create_sent_at = NULL, error_code = $2::text, error_message = $3::text,
           next_run_at = now() + make_interval(secs => $4::int), updated_at = now() WHERE id = $1::uuid`,
        [job.id, info.code, info.message, Math.max(10, Math.ceil((e.retryAfterMs ?? 0) / 1000))],
      );
      return;
    }
    if ((e instanceof MeliHttpError && e.definitelyNotProcessed) || e instanceof MeliAuthError) {
      return finalizeFailure(sql, job, info.code ?? "rejected", info.message);
    }
    // 5xx, timeout, rede: o anúncio pode ter sido criado. Não reenviar; conciliar.
    return markUnknown(sql, job, info.code ?? "uncertain", `Resultado incerto (${info.message}). Conferindo no Mercado Livre pelo SELLER_SKU ${sku}.`);
  }
}

/** Conciliação de job UNKNOWN: procura o anúncio pelo SELLER_SKU. Nunca reenvia o POST. */
export async function reconcileJob(sql: Sql, job: PublicationJob): Promise<"found" | "not_found" | "error"> {
  const caps = await getCapabilities(sql);
  const ctx = await loadContext(sql, job.listingDraftId, caps.publicationModel ?? "CLASSIC");
  if (!ctx) return "error";
  const sku = sellerSku(ctx.draft.adsProductId);
  await sql.execute(`UPDATE marketplace_publication_jobs SET reconcile_count = reconcile_count + 1, updated_at = now() WHERE id = $1::uuid`, [job.id]);
  try {
    const item = await findExistingItem(job.accountId, sku);
    await logAttempt(sql, job.id, { operation: "reconcile", request: { seller_sku: sku }, response: { found: item?.id ?? null } });
    if (item) {
      const listingId = await finalizeSuccess(sql, job, ctx, item, "reconciled");
      await sendDescription(sql, job, ctx, item.id, listingId);
      return "found";
    }
    const exhausted = job.reconcileCount + 1 >= MAX_RECONCILE;
    await sql.execute(
      `UPDATE marketplace_publication_jobs SET next_run_at = CASE WHEN $2::boolean THEN 'infinity'::timestamptz ELSE now() + make_interval(secs => $3::int) END,
         error_message = $4::text, updated_at = now() WHERE id = $1::uuid`,
      [
        job.id,
        exhausted,
        30 * (job.reconcileCount + 1),
        exhausted
          ? `Anúncio não localizado pelo SELLER_SKU ${sku} após ${job.reconcileCount + 1} consultas. Confira no Mercado Livre antes de decidir.`
          : `Ainda não localizado pelo SELLER_SKU ${sku}; nova consulta em breve.`,
      ],
    );
    return "not_found";
  } catch (e) {
    const info = errorInfo(e);
    await logAttempt(sql, job.id, { operation: "reconcile", request: { seller_sku: sku }, status: info.status, code: info.code, message: info.message });
    await sql.execute(`UPDATE marketplace_publication_jobs SET next_run_at = now() + interval '60 seconds', updated_at = now() WHERE id = $1::uuid`, [job.id]);
    return "error";
  }
}

/**
 * Decisão explícita do administrador para um job UNKNOWN sem anúncio localizado:
 * "not_created" encerra como FAILED (o rascunho volta a poder ser validado e publicado).
 */
export async function resolveUnknown(sql: Sql, jobId: string, resolution: "recheck" | "not_created"): Promise<PublicationJob | null> {
  const [job] = await sql.query<PublicationJob>(`${JOB_SELECT} WHERE j.id = $1::uuid`, [jobId]);
  if (!job || job.status !== "UNKNOWN") return null;
  const found = await reconcileJob(sql, job);
  if (found === "found" || resolution === "recheck") return (await sql.query<PublicationJob>(`${JOB_SELECT} WHERE j.id = $1::uuid`, [jobId]))[0];
  if (found === "error") return (await sql.query<PublicationJob>(`${JOB_SELECT} WHERE j.id = $1::uuid`, [jobId]))[0];
  await finalizeFailure(sql, { ...job, status: "UNKNOWN" }, "confirmed_not_created", "Administrador confirmou que o anúncio não foi criado (não localizado pelo SELLER_SKU).");
  return (await sql.query<PublicationJob>(`${JOB_SELECT} WHERE j.id = $1::uuid`, [jobId]))[0];
}

export interface PublishProcessResult {
  busy: boolean;
  steps: number;
  more: boolean;
}

/** Processa a fila de publicação em fatias (mesmo padrão do worker de importação). */
export async function processPublicationJobs(opts: { budgetMs?: number; sql?: Sql; sleep?: (ms: number) => Promise<void> } = {}): Promise<PublishProcessResult> {
  const sql = opts.sql ?? getSql();
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const budget = opts.budgetMs ?? 45_000;
  const started = Date.now();
  const owner = randomUUID();
  let steps = 0;
  if (!(await acquireLease(sql, owner, PUBLISH_LEASE))) return { busy: true, steps, more: false };
  try {
    // Recuperação: job RUNNING de um worker que morreu (o lease global já expirou).
    await sql.execute(
      `UPDATE marketplace_publication_jobs SET status = CASE WHEN create_sent_at IS NULL THEN 'QUEUED' ELSE 'UNKNOWN' END,
         error_message = CASE WHEN create_sent_at IS NULL THEN error_message ELSE 'Processamento interrompido após o envio; conciliando.' END,
         next_run_at = now(), updated_at = now()
       WHERE status = 'RUNNING'`,
    );
    await sql.execute(
      `UPDATE listing_drafts d SET status = 'UNKNOWN', updated_at = now() FROM marketplace_publication_jobs j
       WHERE j.listing_draft_id = d.id AND j.status = 'UNKNOWN' AND d.status = 'PUBLISHING'`,
    );
    while (Date.now() - started < budget) {
      const [job] = await sql.query<PublicationJob & { waitMs: number }>(
        `${JOB_SELECT.replace("FROM marketplace_publication_jobs j", `, GREATEST(0, EXTRACT(EPOCH FROM (j.next_run_at - now())) * 1000)::int AS "waitMs" FROM marketplace_publication_jobs j`)}
         WHERE j.status = 'QUEUED' OR (j.status = 'UNKNOWN' AND j.next_run_at < 'infinity'::timestamptz)
         ORDER BY j.next_run_at, j.created_at LIMIT 1`,
      );
      if (!job) return { busy: false, steps, more: false };
      if (job.waitMs > 0) {
        if (job.waitMs >= budget - (Date.now() - started)) return { busy: false, steps, more: true };
        await sleep(job.waitMs);
        if (!(await renewLease(sql, owner, PUBLISH_LEASE))) return { busy: false, steps, more: true };
        continue;
      }
      try {
        if (job.status === "UNKNOWN") await reconcileJob(sql, job);
        else await processQueued(sql, job);
      } catch (e) {
        logger.error("Erro no worker de publicação", { jobId: job.id, err: e });
        await sql.execute(`UPDATE marketplace_publication_jobs SET next_run_at = now() + interval '60 seconds', updated_at = now() WHERE id = $1::uuid`, [job.id]);
      }
      steps++;
      if (!(await renewLease(sql, owner, PUBLISH_LEASE))) return { busy: false, steps, more: true };
      await sleep(SPACING_MS);
    }
    return { busy: false, steps, more: true };
  } finally {
    await releaseLease(sql, owner, PUBLISH_LEASE).catch(() => undefined);
  }
}

export async function needsPublishWorker(sql: Sql): Promise<boolean> {
  const [row] = await sql.query<{ needed: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM marketplace_publication_jobs WHERE (status = 'QUEUED' OR status = 'UNKNOWN' OR status = 'RUNNING')
                    AND next_run_at <= now() + interval '1 second')
        AND NOT EXISTS (SELECT 1 FROM worker_leases WHERE name = $1 AND lease_until > now()) AS needed`,
    [PUBLISH_LEASE],
  );
  return row?.needed === true;
}
