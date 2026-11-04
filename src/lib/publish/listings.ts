import "server-only";
import { MeliHttpError, meliRequest } from "../meli/api";
import { recordEvent } from "./events";
import type { Sql } from "../sql";

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
}

const SELECT = `SELECT l.id, l.product_id AS "productId", l.ads_product_id AS "adsProductId",
  COALESCE(p.name_custom, p.name_original) AS "productName", l.listing_draft_id AS "listingDraftId",
  l.marketplace_account_id AS "marketplaceAccountId", l.marketplace_item_id AS "marketplaceItemId",
  l.user_product_id AS "userProductId", l.family_id AS "familyId", l.category_id AS "categoryId",
  l.listing_type AS "listingType", l.price::text AS price, l.quantity, l.status, l.permalink,
  l.description_status AS "descriptionStatus", l.published_at AS "publishedAt", l.last_synced_at AS "lastSyncedAt",
  (SELECT public_url FROM product_images i WHERE i.product_id = l.product_id ORDER BY is_primary DESC, position LIMIT 1) AS "primaryImageUrl"
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

interface MeliItemSnapshot {
  id?: string;
  status?: string;
  sub_status?: string[];
  permalink?: string;
  user_product_id?: string;
  family_id?: string | number;
}

export const ITEM_ID_RE = /^MLB\d{1,15}$/;

/**
 * Status guardado localmente. Segue o do ML (active, paused, closed, under_review, inactive...),
 * com "deleted" quando o anúncio foi excluído (closed + sub_status deleted, ou 404).
 */
export function localStatus(item: MeliItemSnapshot | null): string | null {
  if (!item) return "deleted";
  if (item.sub_status?.includes("deleted")) return "deleted";
  return typeof item.status === "string" ? item.status.slice(0, 40) : null;
}

async function applySnapshot(sql: Sql, itemId: string, item: MeliItemSnapshot | null): Promise<string | null> {
  const status = localStatus(item);
  const previous = await sql.query<{ id: number; status: string; listingDraftId: number }>(
    `SELECT id, status, listing_draft_id AS "listingDraftId" FROM marketplace_listings WHERE marketplace_item_id = $1::text`,
    [itemId],
  );
  if (!previous.length) return null;
  await sql.execute(
    `UPDATE marketplace_listings SET status = COALESCE($2::text, status), permalink = COALESCE($3::text, permalink),
       user_product_id = COALESCE($4::text, user_product_id), family_id = COALESCE($5::text, family_id),
       last_synced_at = now(), updated_at = now() WHERE marketplace_item_id = $1::text`,
    [itemId, status, item?.permalink ?? null, item?.user_product_id ?? null, item?.family_id == null ? null : String(item.family_id)],
  );
  for (const row of previous) {
    if (status && row.status !== status) {
      await recordEvent(sql, { draftId: row.listingDraftId, listingId: row.id, type: "listing_status_changed", from: row.status, to: status, details: { itemId } });
    }
  }
  return status;
}

/** Relê um anúncio pelo ID do ML (somente leitura; não altera preço nem estoque no ML). */
export async function syncItem(sql: Sql, itemId: string): Promise<string | null> {
  if (!ITEM_ID_RE.test(itemId)) return null;
  try {
    const { data } = await meliRequest<MeliItemSnapshot>(`/items/${itemId}`, { auth: true });
    return applySnapshot(sql, itemId, data);
  } catch (e) {
    if (e instanceof MeliHttpError && e.kind === "not_found") return applySnapshot(sql, itemId, null);
    throw e;
  }
}

/** Atualiza status/permalink lendo GET /items/{id} (somente leitura; não altera preço nem estoque no ML). */
export async function syncListing(sql: Sql, id: number): Promise<MarketplaceListing | null> {
  const listing = await getListing(sql, id);
  if (!listing) return null;
  await syncItem(sql, listing.marketplaceItemId);
  return getListing(sql, id);
}

/** Relê todos os anúncios em lotes de 20 (GET /items?ids=, multiget oficial). Somente leitura. */
export async function syncAllListings(sql: Sql): Promise<{ checked: number; changed: number }> {
  const rows = await sql.query<{ itemId: string; status: string }>(
    `SELECT marketplace_item_id AS "itemId", status FROM marketplace_listings ORDER BY id`,
  );
  const before = new Map(rows.map((r) => [r.itemId, r.status]));
  const ids = [...before.keys()].filter((id) => ITEM_ID_RE.test(id));
  let changed = 0;
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    const { data } = await meliRequest<{ code: number; body: MeliItemSnapshot }[]>("/items", {
      auth: true,
      query: { ids: chunk.join(","), attributes: "id,status,sub_status,permalink,user_product_id,family_id" },
    });
    for (const entry of Array.isArray(data) ? data : []) {
      const itemId = entry.body?.id;
      if (entry.code === 200 && itemId) {
        const s = await applySnapshot(sql, itemId, entry.body);
        if (s && s !== before.get(itemId)) changed++;
      }
    }
    // Itens que o multiget não devolveu com 200 (ex.: 404 excluído) são relidos um a um.
    const ok = new Set((Array.isArray(data) ? data : []).filter((e) => e.code === 200 && e.body?.id).map((e) => e.body.id!));
    for (const id of chunk.filter((id) => !ok.has(id))) {
      const s = await syncItem(sql, id);
      if (s && s !== before.get(id)) changed++;
    }
  }
  return { checked: ids.length, changed };
}
