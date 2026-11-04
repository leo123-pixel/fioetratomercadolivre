import "server-only";
import { meliRequest } from "../meli/api";
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

/** Atualiza status/permalink lendo GET /items/{id} (somente leitura; não altera preço nem estoque no ML). */
export async function syncListing(sql: Sql, id: number): Promise<MarketplaceListing | null> {
  const listing = await getListing(sql, id);
  if (!listing) return null;
  const { data } = await meliRequest<{ status?: string; permalink?: string; price?: number; available_quantity?: number; user_product_id?: string; family_id?: string | number }>(
    `/items/${listing.marketplaceItemId}`,
    { auth: true },
  );
  await sql.execute(
    `UPDATE marketplace_listings SET status = COALESCE($2::text, status), permalink = COALESCE($3::text, permalink),
       user_product_id = COALESCE($4::text, user_product_id), family_id = COALESCE($5::text, family_id),
       last_synced_at = now(), updated_at = now() WHERE id = $1::int`,
    [id, data.status ?? null, data.permalink ?? null, data.user_product_id ?? null, data.family_id == null ? null : String(data.family_id)],
  );
  return getListing(sql, id);
}
