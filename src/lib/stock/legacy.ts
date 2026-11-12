import "server-only";
import { multigetItems } from "../meli/items";
import { listSellerItemIds, ITEM_ID_RE } from "../publish/listings";
import type { Sql } from "../sql";
import { getStore } from "../store";
import { extractGtins, refreshSuggestions } from "./matching";
import { StockSyncError } from "./settings";

/**
 * Descoberta dos anúncios existentes na conta (inclusive os criados antes do integrador).
 * Somente LEITURA no Mercado Livre: GET /users/{id}/items/search (offset até 1000, depois scan)
 * e multiget GET /items?ids= (20 por chamada). Grava o inventário em legacy_listings, uma linha por
 * anúncio ou por variação. Nada é vinculado automaticamente.
 */
export const LEGACY_ITEM_FIELDS =
  "id,title,status,sub_status,seller_custom_field,attributes,variations,available_quantity,user_product_id,family_id,inventory_id,shipping,thumbnail,secure_thumbnail,permalink,price,last_updated,catalog_listing,seller_id";

type Attr = { id?: string; name?: string; value_name?: string | null; values?: { name?: string | null }[] };

export interface MlVariation {
  id?: number | string;
  available_quantity?: number | null;
  attribute_combinations?: Attr[];
  attributes?: Attr[];
  seller_custom_field?: string | null;
  inventory_id?: string | null;
  user_product_id?: string | null;
}

export interface MlItem {
  id?: string;
  title?: string | null;
  status?: string | null;
  sub_status?: string[] | null;
  seller_custom_field?: string | null;
  attributes?: Attr[];
  variations?: MlVariation[];
  available_quantity?: number | null;
  user_product_id?: string | null;
  family_id?: string | number | null;
  inventory_id?: string | null;
  shipping?: { logistic_type?: string | null } | null;
  thumbnail?: string | null;
  secure_thumbnail?: string | null;
  permalink?: string | null;
  price?: number | null;
  last_updated?: string | null;
  catalog_listing?: boolean | null;
  seller_id?: number | string | null;
}

export interface LegacyRowInput {
  marketplace_account_id: string;
  marketplace_item_id: string;
  variation_id: string;
  variation_label: string | null;
  item_has_variations: boolean;
  user_product_id: string | null;
  family_id: string | null;
  inventory_id: string | null;
  title: string | null;
  status: string | null;
  sub_status: string[];
  seller_sku: string | null;
  gtins: string[];
  brand: string | null;
  manufacturer_code: string | null;
  available_quantity: number | null;
  logistic_type: string | null;
  catalog_listing: boolean | null;
  thumbnail: string | null;
  permalink: string | null;
  price: string | null;
  remote_last_updated: string | null;
}

const str = (v: unknown, max = 300): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

function attrValue(attrs: Attr[] | undefined, id: string): string | null {
  const a = attrs?.find((x) => x?.id === id);
  return str(a?.value_name ?? a?.values?.[0]?.name ?? null, 255);
}

function gtinValues(attrs: Attr[] | undefined): unknown[] {
  const out: unknown[] = [];
  for (const a of attrs ?? []) {
    if (a?.id !== "GTIN") continue;
    out.push(a.value_name);
    for (const v of a.values ?? []) out.push(v?.name);
  }
  return out;
}

const qty = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

/** Converte um item do ML em linhas do inventário (uma por variação, ou uma só sem variações). */
export function itemToRows(item: MlItem, accountId: string): LegacyRowInput[] {
  if (!item.id || !ITEM_ID_RE.test(item.id)) return [];
  const brand = attrValue(item.attributes, "BRAND");
  const mfr = attrValue(item.attributes, "MPN") ?? attrValue(item.attributes, "PART_NUMBER") ?? attrValue(item.attributes, "MODEL");
  const base = {
    marketplace_account_id: accountId,
    marketplace_item_id: item.id,
    family_id: item.family_id == null ? null : String(item.family_id),
    title: str(item.title),
    status: str(item.status, 40),
    sub_status: Array.isArray(item.sub_status) ? item.sub_status.map(String).slice(0, 20) : [],
    brand,
    logistic_type: str(item.shipping?.logistic_type, 40),
    catalog_listing: typeof item.catalog_listing === "boolean" ? item.catalog_listing : null,
    thumbnail: str(item.secure_thumbnail ?? item.thumbnail, 500),
    permalink: str(item.permalink, 500),
    price: typeof item.price === "number" && Number.isFinite(item.price) ? item.price.toFixed(2) : null,
    remote_last_updated: str(item.last_updated, 40),
  };
  const itemSku = attrValue(item.attributes, "SELLER_SKU") ?? str(item.seller_custom_field, 120);
  const variations = Array.isArray(item.variations) ? item.variations.filter((v) => v?.id !== undefined && v?.id !== null) : [];
  if (!variations.length) {
    return [
      {
        ...base,
        variation_id: "",
        variation_label: null,
        item_has_variations: false,
        user_product_id: str(item.user_product_id, 40),
        inventory_id: str(item.inventory_id, 40),
        seller_sku: itemSku,
        gtins: extractGtins(gtinValues(item.attributes)),
        manufacturer_code: mfr,
        available_quantity: qty(item.available_quantity),
      },
    ];
  }
  return variations.map((v) => {
    const label = (v.attribute_combinations ?? [])
      .map((c) => [c?.name, c?.value_name].filter(Boolean).join(": "))
      .filter(Boolean)
      .join(" · ");
    const vGtins = extractGtins([...gtinValues(v.attributes), ...gtinValues(v.attribute_combinations)]);
    return {
      ...base,
      variation_id: String(v.id).slice(0, 30),
      variation_label: str(label, 200),
      item_has_variations: true,
      user_product_id: str(v.user_product_id ?? item.user_product_id, 40),
      inventory_id: str(v.inventory_id ?? item.inventory_id, 40),
      // SKU/GTIN da variação têm prioridade; sem eles, o SKU do anúncio NÃO é herdado (seria ambíguo).
      seller_sku: attrValue(v.attributes, "SELLER_SKU") ?? str(v.seller_custom_field, 120),
      gtins: vGtins,
      manufacturer_code: attrValue(v.attributes, "MPN") ?? attrValue(v.attributes, "PART_NUMBER") ?? null,
      available_quantity: qty(v.available_quantity),
    };
  });
}

/** Grava as linhas de um lote de itens e marca como removidas as variações que deixaram de existir. */
export async function upsertLegacyRows(sql: Sql, rows: LegacyRowInput[]): Promise<string[]> {
  if (!rows.length) return [];
  const saved = await sql.query<{ id: string }>(
    `WITH input AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(
         marketplace_account_id text, marketplace_item_id text, variation_id text, variation_label text, item_has_variations boolean,
         user_product_id text, family_id text, inventory_id text, title text, status text, sub_status jsonb, seller_sku text, gtins text[],
         brand text, manufacturer_code text, available_quantity int, logistic_type text, catalog_listing boolean, thumbnail text,
         permalink text, price numeric, remote_last_updated timestamptz)
     )
     INSERT INTO legacy_listings (marketplace_account_id, marketplace_item_id, variation_id, variation_label, item_has_variations, user_product_id,
       family_id, inventory_id, title, status, sub_status, seller_sku, gtins, brand, manufacturer_code, available_quantity, logistic_type,
       catalog_listing, thumbnail, permalink, price, remote_last_updated, origin, last_seen_at, removed_at)
     SELECT i.marketplace_account_id, i.marketplace_item_id, i.variation_id, i.variation_label, i.item_has_variations, i.user_product_id,
       i.family_id, i.inventory_id, i.title, i.status, COALESCE(i.sub_status, '[]'::jsonb), i.seller_sku, COALESCE(i.gtins, '{}'), i.brand,
       i.manufacturer_code, i.available_quantity, i.logistic_type, i.catalog_listing, i.thumbnail, i.permalink, i.price, i.remote_last_updated,
       CASE WHEN EXISTS (SELECT 1 FROM marketplace_listings l WHERE l.marketplace_item_id = i.marketplace_item_id) THEN 'INTEGRATOR' ELSE 'EXTERNAL' END,
       now(), NULL
     FROM input i
     ON CONFLICT (marketplace_item_id, variation_id) DO UPDATE SET
       marketplace_account_id = EXCLUDED.marketplace_account_id, variation_label = EXCLUDED.variation_label,
       item_has_variations = EXCLUDED.item_has_variations, user_product_id = EXCLUDED.user_product_id, family_id = EXCLUDED.family_id,
       inventory_id = EXCLUDED.inventory_id, title = EXCLUDED.title, status = EXCLUDED.status, sub_status = EXCLUDED.sub_status,
       seller_sku = EXCLUDED.seller_sku, gtins = EXCLUDED.gtins, brand = EXCLUDED.brand, manufacturer_code = EXCLUDED.manufacturer_code,
       available_quantity = EXCLUDED.available_quantity, logistic_type = EXCLUDED.logistic_type, catalog_listing = EXCLUDED.catalog_listing,
       thumbnail = EXCLUDED.thumbnail, permalink = EXCLUDED.permalink, price = EXCLUDED.price, remote_last_updated = EXCLUDED.remote_last_updated,
       origin = EXCLUDED.origin, last_seen_at = now(), removed_at = NULL
     -- Leitura mais antiga que a gravada não sobrescreve.
     WHERE legacy_listings.remote_last_updated IS NULL OR EXCLUDED.remote_last_updated IS NULL
        OR legacy_listings.remote_last_updated <= EXCLUDED.remote_last_updated
     RETURNING id::text AS id`,
    [JSON.stringify(rows)],
  );
  // Variações que sumiram de um item relido (ou a linha "sem variação" de um item que passou a ter variações).
  const byItem = new Map<string, string[]>();
  for (const r of rows) byItem.set(r.marketplace_item_id, [...(byItem.get(r.marketplace_item_id) ?? []), r.variation_id]);
  await sql.execute(
    `UPDATE legacy_listings l SET removed_at = now()
     FROM jsonb_to_recordset($1::jsonb) AS k(item text, variations text[])
     WHERE l.marketplace_item_id = k.item AND NOT (l.variation_id = ANY(k.variations)) AND l.removed_at IS NULL`,
    [JSON.stringify([...byItem].map(([item, variations]) => ({ item, variations })))],
  );
  return saved.map((r) => r.id);
}

/** Lê itens pelo multiget (20 por chamada, somente leitura). */
export async function fetchItems(ids: string[]): Promise<{ items: MlItem[]; notFound: string[] }> {
  const items: MlItem[] = [];
  const notFound: string[] = [];
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    const { data } = await multigetItems<{ code: number; body: MlItem }>(chunk, LEGACY_ITEM_FIELDS).then((data) => ({ data }));
    const seen = new Set<string>();
    for (const e of Array.isArray(data) ? data : []) {
      if (e?.code === 200 && e.body?.id && chunk.includes(e.body.id)) {
        items.push(e.body);
        seen.add(e.body.id);
      }
    }
    notFound.push(...chunk.filter((id) => !seen.has(id)));
  }
  return { items, notFound };
}

export interface DiscoveryResult {
  listed: number;
  fetched: number;
  saved: number;
  skippedRecent: number;
  removed: number;
  /** Lista da conta e detalhes couberam no prazo (senão, chamar de novo continua de onde parou). */
  complete: boolean;
  suggestions: { evaluated: number; suggested: number; ambiguous: number };
}

const timeLeft = (deadline?: number) => (deadline === undefined ? Infinity : deadline - Date.now());

/**
 * Varre a conta e atualiza o inventário. Itens relidos há menos de `refreshMinutes` são pulados, o que
 * permite continuar uma varredura interrompida pelo prazo. Somente leitura no Mercado Livre.
 */
export async function discoverLegacyListings(sql: Sql, opts: { deadline?: number; refreshMinutes?: number; maxItems?: number } = {}): Promise<DiscoveryResult> {
  const conn = await getStore().getCurrentConnection();
  if (!conn?.meliUserId || conn.status !== "ACTIVE") throw new StockSyncError("meli_not_connected", "Conecte a conta do Mercado Livre antes de buscar os anúncios");
  const accountId = conn.meliUserId;
  const listed = await listSellerItemIds(accountId, opts.maxItems ?? 20_000, opts.deadline);
  const recent = new Set(
    (
      await sql.query<{ id: string }>(
        `SELECT DISTINCT marketplace_item_id AS id FROM legacy_listings
         WHERE marketplace_item_id = ANY($1::text[]) AND last_seen_at > now() - make_interval(mins => $2::int)`,
        [listed.ids, opts.refreshMinutes ?? 15],
      )
    ).map((r) => r.id),
  );
  const toFetch = listed.ids.filter((id) => !recent.has(id));
  let complete = listed.complete;
  let fetched = 0;
  const savedIds: string[] = [];
  for (let i = 0; i < toFetch.length; i += 20) {
    if (timeLeft(opts.deadline) < 4_000) {
      complete = false;
      break;
    }
    const { items } = await fetchItems(toFetch.slice(i, i + 20));
    fetched += items.length;
    const rows = items.filter((it) => it.seller_id == null || String(it.seller_id) === accountId).flatMap((it) => itemToRows(it, accountId));
    savedIds.push(...(await upsertLegacyRows(sql, rows)));
  }
  let removed = 0;
  if (complete) {
    // Lista completa: o que não aparece mais na conta deixa de ser considerado (não é apagado).
    removed = await sql.execute(
      `UPDATE legacy_listings SET removed_at = now() WHERE removed_at IS NULL AND marketplace_account_id = $1::text AND NOT (marketplace_item_id = ANY($2::text[]))`,
      [accountId, listed.ids],
    );
  }
  const suggestions = await refreshSuggestions(sql, savedIds);
  await sql.execute(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('legacy_discovery_last', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify({ listed: listed.ids.length, fetched, complete, at: new Date().toISOString() })],
  );
  return { listed: listed.ids.length, fetched, saved: savedIds.length, skippedRecent: recent.size, removed, complete, suggestions };
}

// ---------------------------------------------------------------------------
// Consulta do inventário para o painel de vinculação.
// ---------------------------------------------------------------------------

export type LinkStatus = "LINKED" | "CONFIRMED" | "PENDING" | "AMBIGUOUS" | "UNLINKED";

export const LEGACY_FILTERS = ["all", "unmapped", "pending", "ambiguous", "linked", "divergent", "price_divergent", "ads_zero", "ads_unknown", "multi", "unmanageable", "awaiting"] as const;
export type LegacyFilter = (typeof LEGACY_FILTERS)[number];

/** Chave do estoque controlado no ML: anúncios do mesmo User Product compartilham o estoque. */
export const POOL_KEY_SQL = (a: string) =>
  `CASE WHEN ${a}.user_product_id IS NOT NULL THEN 'up:' || ${a}.user_product_id
        WHEN ${a}.variation_id <> '' THEN 'item:' || ${a}.marketplace_item_id || ':' || ${a}.variation_id
        ELSE 'item:' || ${a}.marketplace_item_id END`;

/** Inventário + vínculo vigente + saldo ADS em cache + última proposta/job. */
export const LEGACY_BASE_SQL = `
WITH base AS (
  SELECT ll.*, ${POOL_KEY_SQL("ll")} AS pool_key,
         il.product_id AS listing_product_id, il.id AS listing_id,
         m.id AS mapping_id, m.product_id AS mapping_product_id, m.source AS mapping_source, m.created_by AS mapping_by,
         m.created_at AS mapping_at, m.max_quantity AS mapping_max_quantity,
         COALESCE(il.product_id, m.product_id) AS link_product_id,
         CASE WHEN il.id IS NOT NULL THEN 'LINKED' WHEN m.id IS NOT NULL THEN 'CONFIRMED'
              WHEN ll.candidate_count > 1 THEN 'AMBIGUOUS' WHEN ll.candidate_count = 1 THEN 'PENDING' ELSE 'UNLINKED' END AS link_status,
         (ll.status IN ('active', 'paused') AND ll.logistic_type IS DISTINCT FROM 'fulfillment' AND ll.removed_at IS NULL) AS manageable
  FROM legacy_listings ll
  LEFT JOIN LATERAL (SELECT l.id, l.product_id FROM marketplace_listings l
                     WHERE l.marketplace_item_id = ll.marketplace_item_id AND l.status <> 'deleted' ORDER BY l.id DESC LIMIT 1) il ON true
  LEFT JOIN marketplace_product_mappings m ON il.id IS NULL AND m.active AND m.mapping_type = 'ITEM'
       AND m.marketplace_item_id = ll.marketplace_item_id AND m.variation_id = ll.variation_id
  WHERE ll.removed_at IS NULL
), pools_per_product AS (
  SELECT link_product_id, count(DISTINCT pool_key)::int AS n FROM base WHERE manageable AND link_product_id IS NOT NULL GROUP BY 1
), enriched AS (
  SELECT b.*,
         COALESCE(pl.name_custom, pl.name_original) AS link_product_name, pl.ads_product_id AS link_ads_product_id,
         COALESCE(ps.name_custom, ps.name_original) AS suggested_product_name, ps.ads_product_id AS suggested_ads_product_id,
         stk.total AS ads_total, stk.branches AS ads_branches, stk.fetched_at AS ads_fetched_at,
         (SELECT count(*) FROM marketplace_mapping_components c WHERE c.mapping_id = b.mapping_id)::int AS component_count,
         COALESCE(ppp.n, 0) AS product_pools,
         lp.status AS last_proposal_status, lp.proposed_quantity AS last_proposed_quantity, lp.created_at AS last_proposal_at,
         lj.status AS last_job_status, lj.completed_at AS last_job_at,
         pr.price AS ads_price, pr.price_table_code AS ads_price_table, pr.fetched_at AS ads_price_fetched_at,
         lpp.status AS last_price_status, lpp.reason AS last_price_reason, lpp.created_at AS last_price_at
  FROM base b
  CROSS JOIN LATERAL (SELECT COALESCE(NULLIF(trim(value->>'priceTableCode'), ''), 'M') AS code, NULLIF(trim(value->>'branchId'), '') AS branch
                      FROM (SELECT (SELECT value FROM app_settings WHERE key = 'price_sync_settings') AS value) s) pcfg
  LEFT JOIN LATERAL (SELECT pp.price, pp.price_table_code, pp.fetched_at FROM product_prices pp
                     WHERE pp.product_id = b.link_product_id AND pp.price_table_code = pcfg.code AND NOT pp.inactive AND pp.price IS NOT NULL
                       AND (pcfg.branch IS NULL OR pp.branch_id = pcfg.branch)
                     ORDER BY pp.branch_id LIMIT 1) pr ON true
  LEFT JOIN LATERAL (SELECT status, reason, created_at FROM price_sync_proposals p
                     WHERE p.marketplace_item_id = b.marketplace_item_id ORDER BY created_at DESC, id DESC LIMIT 1) lpp ON true
  LEFT JOIN products pl ON pl.id = b.link_product_id
  LEFT JOIN pools_per_product ppp ON ppp.link_product_id = b.link_product_id
  LEFT JOIN products ps ON ps.id = b.suggested_product_id
  LEFT JOIN LATERAL (SELECT sum(quantity) AS total, count(*)::int AS branches, min(fetched_at) AS fetched_at
                     FROM product_stocks s WHERE s.product_id = b.link_product_id AND ($1::text[] IS NULL OR s.branch_id = ANY($1::text[]))) stk ON true
  LEFT JOIN LATERAL (SELECT status, proposed_quantity, created_at FROM stock_sync_proposals p WHERE p.pool_key = b.pool_key ORDER BY created_at DESC LIMIT 1) lp ON true
  LEFT JOIN LATERAL (SELECT status, completed_at FROM stock_sync_jobs j WHERE j.pool_key = b.pool_key ORDER BY created_at DESC LIMIT 1) lj ON true
)`;

const FILTER_SQL: Record<LegacyFilter, string> = {
  all: "true",
  unmapped: "link_status IN ('UNLINKED', 'PENDING', 'AMBIGUOUS')",
  pending: "link_status = 'PENDING'",
  ambiguous: "link_status = 'AMBIGUOUS'",
  linked: "link_status IN ('LINKED', 'CONFIRMED')",
  divergent: "link_status IN ('LINKED', 'CONFIRMED') AND ads_branches > 0 AND available_quantity IS NOT NULL AND GREATEST(floor(ads_total), 0) <> available_quantity",
  price_divergent: "link_status IN ('LINKED', 'CONFIRMED') AND ads_price IS NOT NULL AND price IS NOT NULL AND ads_price <> price",
  ads_zero: "link_status IN ('LINKED', 'CONFIRMED') AND ads_branches > 0 AND ads_total <= 0",
  ads_unknown: "link_status IN ('LINKED', 'CONFIRMED') AND COALESCE(ads_branches, 0) = 0",
  multi: "link_status IN ('LINKED', 'CONFIRMED') AND product_pools > 1",
  unmanageable: "NOT manageable",
  awaiting: "(last_proposal_status IN ('PROPOSED', 'APPROVED') OR last_job_status IN ('QUEUED', 'RUNNING'))",
};

export interface LegacyListingRow {
  id: string;
  marketplaceItemId: string;
  variationId: string;
  variationLabel: string | null;
  userProductId: string | null;
  familyId: string | null;
  title: string | null;
  status: string | null;
  subStatus: string[];
  sellerSku: string | null;
  gtins: string[];
  brand: string | null;
  availableQuantity: number | null;
  logisticType: string | null;
  thumbnail: string | null;
  permalink: string | null;
  origin: "INTEGRATOR" | "EXTERNAL";
  poolKey: string;
  linkStatus: LinkStatus;
  linkProductId: number | null;
  linkProductName: string | null;
  linkAdsProductId: number | null;
  mappingId: string | null;
  mappingSource: string | null;
  mappingBy: string | null;
  mappingAt: Date | null;
  mappingMaxQuantity: number | null;
  componentCount: number;
  suggestedProductId: number | null;
  suggestedProductName: string | null;
  suggestedAdsProductId: number | null;
  suggestionSource: string | null;
  suggestionConfidence: string | null;
  candidateCount: number;
  suggestionDetails: unknown;
  adsTotal: string | null;
  adsBranches: number | null;
  adsFetchedAt: Date | null;
  manageable: boolean;
  productPools: number;
  lastProposalStatus: string | null;
  lastProposedQuantity: number | null;
  lastProposalAt: Date | null;
  lastJobStatus: string | null;
  lastJobAt: Date | null;
  lastSeenAt: Date;
  /** Preço no ML na última leitura da conta. */
  price: string | null;
  /** Preço ADS em cache na tabela configurada para o ML (atualizado na simulação de preço). */
  adsPrice: string | null;
  adsPriceTable: string | null;
  adsPriceFetchedAt: Date | null;
  lastPriceStatus: string | null;
  lastPriceReason: string | null;
  lastPriceAt: Date | null;
}

const SELECT_COLUMNS = `id::text AS id, marketplace_item_id AS "marketplaceItemId", variation_id AS "variationId", variation_label AS "variationLabel",
  user_product_id AS "userProductId", family_id AS "familyId", title, status, sub_status AS "subStatus", seller_sku AS "sellerSku", gtins, brand,
  available_quantity AS "availableQuantity", logistic_type AS "logisticType", thumbnail, permalink, origin, pool_key AS "poolKey",
  link_status AS "linkStatus", link_product_id AS "linkProductId", link_product_name AS "linkProductName", link_ads_product_id AS "linkAdsProductId",
  mapping_id::text AS "mappingId", mapping_source AS "mappingSource", mapping_by AS "mappingBy", mapping_at AS "mappingAt",
  mapping_max_quantity AS "mappingMaxQuantity", component_count AS "componentCount",
  suggested_product_id AS "suggestedProductId", suggested_product_name AS "suggestedProductName", suggested_ads_product_id AS "suggestedAdsProductId",
  suggestion_source AS "suggestionSource", suggestion_confidence AS "suggestionConfidence", candidate_count AS "candidateCount",
  suggestion_details AS "suggestionDetails", ads_total::text AS "adsTotal", ads_branches AS "adsBranches", ads_fetched_at AS "adsFetchedAt",
  manageable, product_pools AS "productPools", last_proposal_status AS "lastProposalStatus", last_proposed_quantity AS "lastProposedQuantity",
  last_proposal_at AS "lastProposalAt", last_job_status AS "lastJobStatus", last_job_at AS "lastJobAt", last_seen_at AS "lastSeenAt",
  price::text AS price, ads_price::text AS "adsPrice", ads_price_table AS "adsPriceTable", ads_price_fetched_at AS "adsPriceFetchedAt",
  last_price_status AS "lastPriceStatus", last_price_reason AS "lastPriceReason", last_price_at AS "lastPriceAt"`;

export async function listLegacyListings(
  sql: Sql,
  opts: { filter?: LegacyFilter; q?: string; page?: number; pageSize?: number; branchIds?: string[] | null } = {},
): Promise<{ items: LegacyListingRow[]; total: number; page: number; pageSize: number; counts: Record<LegacyFilter, number> }> {
  const filter = opts.filter ?? "all";
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 200);
  const page = Math.max(opts.page ?? 1, 1);
  const q = opts.q?.trim().slice(0, 100) || null;
  const search = `($2::text IS NULL OR marketplace_item_id = upper($2::text) OR seller_sku ILIKE '%' || $2::text || '%' OR title ILIKE '%' || $2::text || '%'
                   OR link_ads_product_id::text = $2::text OR user_product_id = upper($2::text))`;
  const branches = opts.branchIds && opts.branchIds.length ? opts.branchIds : null;
  const items = await sql.query<LegacyListingRow>(
    `${LEGACY_BASE_SQL} SELECT ${SELECT_COLUMNS} FROM enriched WHERE ${FILTER_SQL[filter]} AND ${search}
     ORDER BY (link_status IN ('LINKED', 'CONFIRMED')), title NULLS LAST, marketplace_item_id, variation_id
     LIMIT $3::int OFFSET $4::int`,
    [branches, q, pageSize, (page - 1) * pageSize],
  );
  const countCols = LEGACY_FILTERS.map((f) => `count(*) FILTER (WHERE ${FILTER_SQL[f]})::int AS "${f}"`).join(", ");
  const [counts] = await sql.query<Record<LegacyFilter, number>>(`${LEGACY_BASE_SQL} SELECT ${countCols} FROM enriched WHERE ${search}`, [branches, q]);
  return { items, total: counts?.[filter] ?? 0, page, pageSize, counts: counts ?? (Object.fromEntries(LEGACY_FILTERS.map((f) => [f, 0])) as Record<LegacyFilter, number>) };
}

export async function getLegacyListing(sql: Sql, id: string, branchIds: string[] | null = null): Promise<LegacyListingRow | null> {
  if (!/^\d{1,18}$/.test(id)) return null;
  const [row] = await sql.query<LegacyListingRow>(`${LEGACY_BASE_SQL} SELECT ${SELECT_COLUMNS} FROM enriched WHERE id = $2::bigint`, [branchIds, id]);
  return row ?? null;
}
