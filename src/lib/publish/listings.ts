import "server-only";
import { MeliHttpError, meliRequest } from "../meli/api";
import { classifyError, withReadRetry } from "../marketplace/errors";
import { MeliAuthError } from "../meli/tokens";
import { getStore } from "../store";
import { isUniqueViolation, type Sql } from "../sql";
import { recordEvent } from "./events";
import { sellerSku } from "./payload";

export interface MarketplaceListing {
  id: number;
  productId: number;
  adsProductId: number;
  productName: string;
  listingDraftId: number;
  marketplaceAccountId: string;
  marketplaceItemId: string;
  userProductId: string | null;
  familyId: string | null;
  categoryId: string;
  listingType: string | null;
  price: string;
  quantity: number;
  status: string;
  permalink: string | null;
  descriptionStatus: string | null;
  publishedAt: Date;
  lastSyncedAt: Date | null;
  primaryImageUrl: string | null;
  remoteStatus: string | null;
  remoteSubStatus: string[] | null;
  remotePrice: string | null;
  remoteQuantity: number | null;
  remoteTitle: string | null;
  remoteLastUpdated: Date | null;
  syncErrorCode: string | null;
  syncErrorMessage: string | null;
  syncErrorAt: Date | null;
  openIssues: string[];
}

const SELECT = `SELECT l.id, l.product_id AS "productId", l.ads_product_id AS "adsProductId",
  COALESCE(p.name_custom, p.name_original) AS "productName", l.listing_draft_id AS "listingDraftId",
  l.marketplace_account_id AS "marketplaceAccountId", l.marketplace_item_id AS "marketplaceItemId",
  l.user_product_id AS "userProductId", l.family_id AS "familyId", l.category_id AS "categoryId",
  l.listing_type AS "listingType", l.price::text AS price, l.quantity, l.status, l.permalink,
  l.description_status AS "descriptionStatus", l.published_at AS "publishedAt", l.last_synced_at AS "lastSyncedAt",
  (SELECT public_url FROM product_images i WHERE i.product_id = l.product_id ORDER BY is_primary DESC, position LIMIT 1) AS "primaryImageUrl",
  l.remote_status AS "remoteStatus", l.remote_sub_status AS "remoteSubStatus", l.remote_price::text AS "remotePrice",
  l.remote_quantity AS "remoteQuantity", l.remote_title AS "remoteTitle", l.remote_last_updated AS "remoteLastUpdated",
  l.sync_error_code AS "syncErrorCode", l.sync_error_message AS "syncErrorMessage", l.sync_error_at AS "syncErrorAt",
  COALESCE((SELECT array_agg(issue_type ORDER BY issue_type) FROM marketplace_reconciliation_issues r
            WHERE r.listing_id = l.id AND r.resolved_at IS NULL), '{}') AS "openIssues"
  FROM marketplace_listings l JOIN products p ON p.id = l.product_id`;

export async function listListings(sql: Sql, opts: { page?: number; pageSize?: number } = {}) {
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 100);
  const page = Math.max(opts.page ?? 1, 1);
  const [{ total }] = await sql.query<{ total: number }>(`SELECT count(*)::int AS total FROM marketplace_listings`);
  const items = await sql.query<MarketplaceListing>(`${SELECT} ORDER BY l.published_at DESC LIMIT $1::int OFFSET $2::int`, [pageSize, (page - 1) * pageSize]);
  return { items, total, page, pageSize };
}

export async function getListing(sql: Sql, id: number): Promise<MarketplaceListing | null> {
  const [row] = await sql.query<MarketplaceListing>(`${SELECT} WHERE l.id = $1::int`, [id]);
  return row ?? null;
}

export interface MeliItemSnapshot {
  id?: string;
  status?: string;
  sub_status?: string[];
  permalink?: string;
  user_product_id?: string;
  family_id?: string | number;
  price?: number | null;
  available_quantity?: number | null;
  title?: string | null;
  category_id?: string | null;
  last_updated?: string | null;
  seller_id?: number | string | null;
  attributes?: { id?: string; value_name?: string | null }[];
}

/** Campos pedidos ao multiget (GET /items?ids=...&attributes=...). */
export const ITEM_FIELDS = "id,status,sub_status,permalink,user_product_id,family_id,price,available_quantity,title,category_id,last_updated,seller_id,attributes";

export const ITEM_ID_RE = /^MLB\d{1,15}$/;

/**
 * Status guardado localmente. Segue o do ML (active, paused, closed, under_review, inactive...),
 * com "deleted" quando o anúncio foi excluído (closed + sub_status deleted, ou 404).
 * O status original da API fica em remote_status / remote_sub_status.
 */
export function localStatus(item: MeliItemSnapshot | null): string | null {
  if (!item) return "deleted";
  if (item.sub_status?.includes("deleted")) return "deleted";
  return typeof item.status === "string" ? item.status.slice(0, 40) : null;
}

export type SyncSource = "sync" | "webhook" | "manual" | "publish";
export interface SyncContext {
  source?: SyncSource;
  eventId?: string | null;
  jobId?: string | null;
}

export interface ApplyResult {
  /** Status local depois da leitura (null se o anúncio não existe no banco). */
  status: string | null;
  /** O status mudou? */
  changed: boolean;
  /** Algum dado remoto (status, preço, quantidade) mudou desde a última leitura? */
  remoteChanged: boolean;
  /** Leitura mais antiga que a já gravada (fora de ordem): descartada. */
  stale: boolean;
  /** Divergências abertas para o item depois desta leitura. */
  issues: string[];
}

interface LocalRow {
  id: number;
  status: string;
  listingDraftId: number;
  adsProductId: number;
  price: string;
  quantity: number;
  remoteStatus: string | null;
  remoteSubStatus: string[] | null;
  remotePrice: string | null;
  remoteQuantity: number | null;
  remoteLastUpdated: Date | null;
}

const ISSUE_TYPES_EVALUATED = ["STATUS_DIVERGENCE", "CLOSED_REMOTE", "REMOVED_REMOTE", "PRICE_DIVERGENCE", "QUANTITY_DIVERGENCE", "FETCH_ERROR"];

function money(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : null;
}

function parseDate(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function skuOf(item: MeliItemSnapshot): string | null | undefined {
  if (!Array.isArray(item.attributes)) return undefined; // atributos não vieram: não avalia o vínculo
  const v = item.attributes.find((a) => a?.id === "SELLER_SKU")?.value_name;
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : null;
}

/** Divergências entre o que o integrador publicou e o que o ML devolveu. */
export function detectIssues(local: Pick<LocalRow, "price" | "quantity" | "adsProductId">, item: MeliItemSnapshot | null) {
  const issues: { type: string; local: string | null; remote: string | null; details?: unknown }[] = [];
  const status = localStatus(item);
  if (status === "deleted") {
    issues.push({ type: "REMOVED_REMOTE", local: "publicado", remote: item ? "deleted" : "not_found" });
    return { issues, evaluated: [...ISSUE_TYPES_EVALUATED, "INCOMPLETE_LINK"] };
  }
  if (status === "closed") {
    issues.push({ type: "CLOSED_REMOTE", local: "publicado", remote: "closed", details: { subStatus: item?.sub_status ?? [] } });
    return { issues, evaluated: [...ISSUE_TYPES_EVALUATED, "INCOMPLETE_LINK"] };
  }
  if (status && status !== "active") issues.push({ type: "STATUS_DIVERGENCE", local: "active", remote: status, details: { subStatus: item?.sub_status ?? [] } });
  const remotePrice = money(item?.price);
  if (remotePrice !== null && remotePrice !== money(local.price)) issues.push({ type: "PRICE_DIVERGENCE", local: money(local.price), remote: remotePrice });
  const q = item?.available_quantity;
  if (typeof q === "number" && q !== local.quantity) {
    issues.push({ type: "QUANTITY_DIVERGENCE", local: String(local.quantity), remote: String(q), details: { note: "Pode refletir vendas ou alteração manual no ML." } });
  }
  const evaluated = [...ISSUE_TYPES_EVALUATED];
  const sku = item ? skuOf(item) : undefined;
  if (sku !== undefined) {
    evaluated.push("INCOMPLETE_LINK");
    const expected = sellerSku(local.adsProductId);
    if (sku !== expected) issues.push({ type: "INCOMPLETE_LINK", local: expected, remote: sku ?? "(sem SELLER_SKU)" });
  }
  return { issues, evaluated };
}

/** Abre/atualiza as divergências encontradas e resolve as que deixaram de existir. */
export async function saveIssues(
  sql: Sql,
  itemId: string,
  listingId: number | null,
  found: { type: string; local: string | null; remote: string | null; details?: unknown }[],
  evaluated: string[],
): Promise<void> {
  for (const i of found) {
    await sql.execute(
      `INSERT INTO marketplace_reconciliation_issues (marketplace_item_id, listing_id, issue_type, local_value, remote_value, details)
       VALUES ($1::text, $2::int, $3::text, $4::text, $5::text, $6::jsonb)
       ON CONFLICT (marketplace_item_id, issue_type) WHERE resolved_at IS NULL
       DO UPDATE SET local_value = EXCLUDED.local_value, remote_value = EXCLUDED.remote_value, details = EXCLUDED.details,
                     listing_id = COALESCE(EXCLUDED.listing_id, marketplace_reconciliation_issues.listing_id), last_detected_at = now()`,
      [itemId, listingId, i.type, i.local, i.remote, i.details === undefined ? null : JSON.stringify(i.details)],
    );
  }
  const keep = found.map((i) => i.type);
  const resolve = evaluated.filter((t) => !keep.includes(t));
  if (resolve.length) {
    await sql.execute(
      `UPDATE marketplace_reconciliation_issues SET resolved_at = now(), resolution = 'auto'
       WHERE marketplace_item_id = $1::text AND resolved_at IS NULL AND issue_type = ANY($2::text[])`,
      [itemId, resolve],
    );
  }
}

/**
 * Grava a fotografia remota do anúncio. Não altera preço/quantidade publicados, rascunhos nem nada no ML.
 * Leituras fora de ordem (last_updated mais antigo que o já gravado) são descartadas.
 */
async function applySnapshot(sql: Sql, itemId: string, item: MeliItemSnapshot | null, ctx: SyncContext = {}): Promise<ApplyResult> {
  const rows = await sql.query<LocalRow>(
    `SELECT id, status, listing_draft_id AS "listingDraftId", ads_product_id AS "adsProductId", price::text AS price, quantity,
            remote_status AS "remoteStatus", remote_sub_status AS "remoteSubStatus", remote_price::text AS "remotePrice",
            remote_quantity AS "remoteQuantity", remote_last_updated AS "remoteLastUpdated"
     FROM marketplace_listings WHERE marketplace_item_id = $1::text`,
    [itemId],
  );
  if (!rows.length) return { status: null, changed: false, remoteChanged: false, stale: false, issues: [] };
  const lastUpdated = parseDate(item?.last_updated);
  const status = localStatus(item);
  let result: ApplyResult = { status: rows[0].status, changed: false, remoteChanged: false, stale: false, issues: [] };

  for (const row of rows) {
    if (item && lastUpdated && row.remoteLastUpdated && lastUpdated.getTime() < new Date(row.remoteLastUpdated).getTime()) {
      result = { ...result, stale: true };
      continue;
    }
    const remoteStatus = item ? (item.status ?? null) : "not_found";
    const remoteSub = item ? (item.sub_status ?? []) : [];
    const remotePrice = money(item?.price);
    const remoteQty = typeof item?.available_quantity === "number" ? item.available_quantity : null;
    const remoteChanged =
      row.remoteStatus !== remoteStatus ||
      JSON.stringify(row.remoteSubStatus ?? []) !== JSON.stringify(remoteSub) ||
      (item !== null && (money(row.remotePrice) !== remotePrice || row.remoteQuantity !== remoteQty));
    const params = [
      row.id,
      item?.permalink ?? null,
      item?.user_product_id ?? null,
      item?.family_id == null ? null : String(item.family_id),
      remoteStatus,
      JSON.stringify(remoteSub),
      remotePrice,
      remoteQty,
      item?.title ? String(item.title).slice(0, 300) : null,
      item?.category_id ?? null,
      item ? (skuOf(item) ?? null) : null,
      lastUpdated,
    ];
    const setRemote = `permalink = COALESCE($2::text, permalink), user_product_id = COALESCE($3::text, user_product_id),
       family_id = COALESCE($4::text, family_id), remote_status = $5::text, remote_sub_status = $6::jsonb,
       remote_price = COALESCE($7::numeric, remote_price), remote_quantity = COALESCE($8::int, remote_quantity),
       remote_title = COALESCE($9::text, remote_title), remote_category_id = COALESCE($10::text, remote_category_id),
       remote_seller_sku = COALESCE($11::text, remote_seller_sku), remote_last_updated = COALESCE($12::timestamptz, remote_last_updated),
       last_synced_at = now(), updated_at = now(), sync_error_code = NULL, sync_error_message = NULL, sync_error_at = NULL`;
    const guard = `AND (remote_last_updated IS NULL OR $12::timestamptz IS NULL OR remote_last_updated <= $12::timestamptz)`;
    let applied: number;
    let newStatus = status ?? row.status;
    try {
      applied = await sql.execute(`UPDATE marketplace_listings SET status = COALESCE($13::text, status), ${setRemote} WHERE id = $1::int ${guard}`, [...params, status]);
    } catch (err) {
      // Reativação de um anúncio antigo quando já existe outro vigente: guarda a fotografia sem trocar o status.
      if (!isUniqueViolation(err)) throw err;
      applied = await sql.execute(`UPDATE marketplace_listings SET ${setRemote} WHERE id = $1::int ${guard}`, params);
      newStatus = row.status;
    }
    if (!applied) {
      result = { ...result, stale: true };
      continue;
    }
    const changed = newStatus !== row.status;
    if (changed) {
      await recordEvent(sql, {
        draftId: row.listingDraftId,
        listingId: row.id,
        type: "listing_status_changed",
        from: row.status,
        to: newStatus,
        details: { itemId, source: ctx.source ?? "sync", remoteStatus, subStatus: remoteSub, eventId: ctx.eventId ?? null },
      });
    }
    if (remoteChanged) {
      await sql.execute(
        `INSERT INTO marketplace_listing_snapshots (listing_id, marketplace_item_id, marketplace_status, marketplace_substatus, marketplace_price,
           marketplace_quantity, marketplace_last_updated, source, event_id, sync_job_id)
         VALUES ($1::int, $2::text, $3::text, $4::jsonb, $5::numeric, $6::int, $7::timestamptz, $8::text, $9::bigint, $10::uuid)`,
        [row.id, itemId, remoteStatus, JSON.stringify(remoteSub), remotePrice, remoteQty, lastUpdated, ctx.source ?? "sync", ctx.eventId ?? null, ctx.jobId ?? null],
      );
    }
    const { issues, evaluated } = detectIssues(row, item);
    await saveIssues(sql, itemId, row.id, issues, evaluated);
    result = { status: newStatus, changed: result.changed || changed, remoteChanged: result.remoteChanged || remoteChanged, stale: result.stale, issues: issues.map((i) => i.type) };
  }
  return result;
}

/** Registra falha de consulta no anúncio (sem alterar o status conhecido). */
async function recordFetchError(sql: Sql, itemId: string, err: unknown): Promise<void> {
  const c = classifyError(err);
  const rows = await sql.query<{ id: number }>(
    `UPDATE marketplace_listings SET sync_error_code = $2::text, sync_error_message = $3::text, sync_error_at = now()
     WHERE marketplace_item_id = $1::text RETURNING id`,
    [itemId, c.code, c.message],
  );
  if (rows.length) await saveIssues(sql, itemId, rows[0].id, [{ type: "FETCH_ERROR", local: null, remote: c.code, details: { message: c.message } }], []);
}

/** Relê um anúncio e devolve o resultado completo. Somente leitura no ML. */
export async function syncItemDetailed(sql: Sql, itemId: string, ctx: SyncContext = {}): Promise<ApplyResult> {
  if (!ITEM_ID_RE.test(itemId)) return { status: null, changed: false, remoteChanged: false, stale: false, issues: [] };
  try {
    const { data } = await withReadRetry(() => meliRequest<MeliItemSnapshot>(`/items/${itemId}`, { auth: true }));
    return await applySnapshot(sql, itemId, data, ctx);
  } catch (e) {
    if (e instanceof MeliHttpError && e.kind === "not_found") return applySnapshot(sql, itemId, null, ctx);
    await recordFetchError(sql, itemId, e).catch(() => undefined);
    throw e;
  }
}

/** Relê um anúncio pelo ID do ML (somente leitura; não altera preço nem estoque no ML). */
export async function syncItem(sql: Sql, itemId: string, ctx: SyncContext = {}): Promise<string | null> {
  return (await syncItemDetailed(sql, itemId, ctx)).status;
}

/** Atualiza status/permalink lendo GET /items/{id} (somente leitura; não altera preço nem estoque no ML). */
export async function syncListing(sql: Sql, id: number): Promise<MarketplaceListing | null> {
  const listing = await getListing(sql, id);
  if (!listing) return null;
  await syncItem(sql, listing.marketplaceItemId, { source: "manual" });
  return getListing(sql, id);
}

export interface ReconcileResult {
  checked: number;
  changed: number;
  failed: number;
  stale: number;
  unlinked: number;
  divergent: number;
}

/**
 * Reconciliação de leitura: relê os anúncios conhecidos em lotes de 20 (multiget oficial GET /items?ids=)
 * e procura anúncios da conta sem correspondência local (GET /users/{id}/items/search, paginado).
 * Anúncios excluídos (terminais) não são relidos. Nada é escrito no Mercado Livre.
 */
export async function syncAllListings(sql: Sql, ctx: SyncContext = {}): Promise<ReconcileResult> {
  const rows = await sql.query<{ itemId: string; status: string }>(
    `SELECT marketplace_item_id AS "itemId", status FROM marketplace_listings WHERE status <> 'deleted' ORDER BY id`,
  );
  const ids = rows.map((r) => r.itemId).filter((id) => ITEM_ID_RE.test(id));
  const res: ReconcileResult = { checked: 0, changed: 0, failed: 0, stale: 0, unlinked: 0, divergent: 0 };
  const tally = (r: ApplyResult) => {
    res.checked++;
    if (r.changed) res.changed++;
    if (r.stale) res.stale++;
    if (r.issues.some((i) => i !== "CLOSED_REMOTE" && i !== "REMOVED_REMOTE")) res.divergent++;
  };
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    let data: { code: number; body: MeliItemSnapshot }[] = [];
    try {
      const r = await withReadRetry(() => meliRequest<{ code: number; body: MeliItemSnapshot }[]>("/items", { auth: true, query: { ids: chunk.join(","), attributes: ITEM_FIELDS } }));
      data = Array.isArray(r.data) ? r.data : [];
    } catch (err) {
      if (err instanceof MeliAuthError || (err instanceof MeliHttpError && (err.kind === "auth" || err.kind === "forbidden"))) throw err;
      // Falha do lote: cai para a leitura individual abaixo.
    }
    const ok = new Set<string>();
    for (const entry of data) {
      const itemId = entry.body?.id;
      if (entry.code === 200 && itemId && chunk.includes(itemId)) {
        ok.add(itemId);
        tally(await applySnapshot(sql, itemId, entry.body, ctx));
      }
    }
    // Itens que o multiget não devolveu com 200 (ex.: 404 excluído) são relidos um a um.
    for (const id of chunk.filter((id) => !ok.has(id))) {
      try {
        tally(await syncItemDetailed(sql, id, ctx));
      } catch (err) {
        if (err instanceof MeliAuthError || (err instanceof MeliHttpError && err.kind === "auth")) throw err;
        res.failed++;
      }
    }
  }
  // Anúncios encerrados/excluídos já substituídos por uma nova publicação deixam de ser pendência.
  await sql.execute(
    `UPDATE marketplace_reconciliation_issues r SET resolved_at = now(), resolution = 'superseded'
     FROM marketplace_listings l
     WHERE r.listing_id = l.id AND r.resolved_at IS NULL AND r.issue_type IN ('CLOSED_REMOTE', 'REMOVED_REMOTE')
       AND EXISTS (SELECT 1 FROM marketplace_listings n WHERE n.listing_draft_id = l.listing_draft_id AND n.id > l.id)`,
  );
  res.unlinked = await discoverUnlinkedItems(sql);
  return res;
}

/** IDs de anúncios da conta (todas as páginas). Usa search_type=scan acima de 1000 resultados. */
export async function listSellerItemIds(sellerId: string, maxItems = 5000): Promise<string[]> {
  if (!/^\d{1,20}$/.test(sellerId)) return [];
  const ids: string[] = [];
  const first = await withReadRetry(() =>
    meliRequest<{ results?: unknown[]; paging?: { total?: number } }>(`/users/${sellerId}/items/search`, { auth: true, query: { offset: 0, limit: 100 } }),
  );
  const total = Math.min(first.data?.paging?.total ?? 0, maxItems);
  const push = (list: unknown[] | undefined) => {
    for (const r of list ?? []) if (typeof r === "string" && ITEM_ID_RE.test(r) && !ids.includes(r)) ids.push(r);
  };
  push(first.data?.results);
  if (total <= 1000) {
    for (let offset = 100; offset < total; offset += 100) {
      const page = await withReadRetry(() => meliRequest<{ results?: unknown[] }>(`/users/${sellerId}/items/search`, { auth: true, query: { offset, limit: 100 } }));
      push(page.data?.results);
    }
  } else {
    let scrollId: string | undefined;
    ids.length = 0;
    for (let guard = 0; guard < 100 && ids.length < maxItems; guard++) {
      const page = await withReadRetry(() =>
        meliRequest<{ results?: unknown[]; scroll_id?: string }>(`/users/${sellerId}/items/search`, { auth: true, query: { search_type: "scan", limit: 100, scroll_id: scrollId } }),
      );
      const before = ids.length;
      push(page.data?.results);
      scrollId = page.data?.scroll_id;
      if (!scrollId || ids.length === before) break;
    }
  }
  return ids;
}

/** Registra como NOT_LINKED os anúncios da conta que o integrador não conhece. Não vincula nada sozinho. */
async function discoverUnlinkedItems(sql: Sql): Promise<number> {
  const conn = await getStore().getCurrentConnection();
  if (!conn?.meliUserId) return 0;
  const remoteIds = await listSellerItemIds(conn.meliUserId);
  const known = new Set(
    (await sql.query<{ id: string }>(`SELECT marketplace_item_id AS id FROM marketplace_listings WHERE marketplace_item_id = ANY($1::text[])`, [remoteIds])).map((r) => r.id),
  );
  const unknown = remoteIds.filter((id) => !known.has(id));
  for (let i = 0; i < unknown.length; i += 20) {
    const chunk = unknown.slice(i, i + 20);
    const { data } = await withReadRetry(() => meliRequest<{ code: number; body: MeliItemSnapshot }[]>("/items", { auth: true, query: { ids: chunk.join(","), attributes: ITEM_FIELDS } }));
    for (const entry of Array.isArray(data) ? data : []) {
      const item = entry.body;
      if (entry.code !== 200 || !item?.id || !chunk.includes(item.id)) continue;
      const sku = skuOf(item) ?? null;
      const adsId = sku && /^ADS-(\d{1,10})$/.exec(sku)?.[1];
      const [product] = adsId ? await sql.query<{ id: number }>(`SELECT id FROM products WHERE ads_product_id = $1::int`, [Number(adsId)]) : [];
      await saveIssues(
        sql,
        item.id,
        null,
        [
          {
            type: "NOT_LINKED",
            local: null,
            remote: localStatus(item),
            details: { title: item.title ?? null, price: money(item.price), quantity: item.available_quantity ?? null, sellerSku: sku, candidateProductId: product?.id ?? null },
          },
        ],
        [],
      );
    }
  }
  // Itens que passaram a ter anúncio local deixam de ser "sem correspondência".
  await sql.execute(
    `UPDATE marketplace_reconciliation_issues r SET resolved_at = now(), resolution = 'linked'
     WHERE r.issue_type = 'NOT_LINKED' AND r.resolved_at IS NULL
       AND EXISTS (SELECT 1 FROM marketplace_listings l WHERE l.marketplace_item_id = r.marketplace_item_id)`,
  );
  return unknown.length;
}
