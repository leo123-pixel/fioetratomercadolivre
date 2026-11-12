import "server-only";
import { multigetItems } from "../meli/items";
import type { Sql } from "../sql";
import { adsStatusOf, mappingStatusOf } from "./order-status";

/**
 * Correspondência entre itens vendidos no Mercado Livre e produtos ADS. Nunca por semelhança de título.
 * Prioridade:
 *   1. LISTING      — anúncio publicado por este integrador (vínculo interno marketplace_listings).
 *   2. ITEM_LINK    — anúncio do ML vinculado pelo administrador (reutilizado em todos os pedidos).
 *   3. USER_PRODUCT — user_product_id de um anúncio publicado pelo integrador.
 *   4. SELLER_SKU   — SKU "ADS-<produtoId>" gravado na publicação (referência persistida), se o produto existe.
 *   5. SKU_LINK     — SELLER_SKU previamente vinculado e validado pelo administrador.
 *   6. MANUAL       — associação feita só para uma linha de um pedido (não é reutilizada).
 * Sem correspondência confiável → UNMAPPED.
 */
export type MappingMethod = "LISTING" | "ITEM_LINK" | "USER_PRODUCT" | "SELLER_SKU" | "SKU_LINK" | "MANUAL";

export interface Resolved {
  listingId: number | null;
  productId: number | null;
  adsProductId: number | null;
  mappingId: string | null;
  mappingStatus: "MAPPED" | "UNMAPPED";
  mappingMethod: MappingMethod | null;
}

const UNMAPPED: Resolved = { listingId: null, productId: null, adsProductId: null, mappingId: null, mappingStatus: "UNMAPPED", mappingMethod: null };

export async function resolveProduct(
  sql: Sql,
  line: { itemId: string | null; variationId: string | null; userProductId: string | null; sellerSku: string | null },
): Promise<Resolved> {
  type L = { listingId: number; productId: number; adsProductId: number };
  if (line.itemId) {
    const [byListing] = await sql.query<L>(
      `SELECT id AS "listingId", product_id AS "productId", ads_product_id AS "adsProductId" FROM marketplace_listings
       WHERE marketplace_item_id = $1::text ORDER BY id DESC LIMIT 1`,
      [line.itemId],
    );
    if (byListing) return { ...byListing, mappingId: null, mappingStatus: "MAPPED", mappingMethod: "LISTING" };
    // Vínculo do anúncio: a variação exata tem prioridade sobre o vínculo do anúncio inteiro.
    const [byItem] = await sql.query<{ id: string; productId: number; adsProductId: number }>(
      `SELECT id::text AS id, product_id AS "productId", ads_product_id AS "adsProductId" FROM marketplace_product_mappings
       WHERE active AND mapping_type = 'ITEM' AND marketplace_item_id = $1::text AND variation_id IN ($2::text, '')
       ORDER BY (variation_id = $2::text) DESC LIMIT 1`,
      [line.itemId, line.variationId ?? ""],
    );
    if (byItem) return { listingId: null, productId: byItem.productId, adsProductId: byItem.adsProductId, mappingId: byItem.id, mappingStatus: "MAPPED", mappingMethod: "ITEM_LINK" };
  }
  if (line.userProductId) {
    const [byUp] = await sql.query<L>(
      `SELECT id AS "listingId", product_id AS "productId", ads_product_id AS "adsProductId" FROM marketplace_listings
       WHERE user_product_id = $1::text ORDER BY id DESC LIMIT 1`,
      [line.userProductId],
    );
    if (byUp) return { ...byUp, mappingId: null, mappingStatus: "MAPPED", mappingMethod: "USER_PRODUCT" };
  }
  if (line.sellerSku) {
    const adsId = /^ADS-(\d{1,10})$/.exec(line.sellerSku)?.[1];
    if (adsId) {
      const [p] = await sql.query<{ productId: number; adsProductId: number }>(
        `SELECT id AS "productId", ads_product_id AS "adsProductId" FROM products WHERE ads_product_id = $1::int`,
        [Number(adsId)],
      );
      if (p) return { listingId: null, ...p, mappingId: null, mappingStatus: "MAPPED", mappingMethod: "SELLER_SKU" };
    }
    const [bySku] = await sql.query<{ id: string; productId: number; adsProductId: number }>(
      `SELECT id::text AS id, product_id AS "productId", ads_product_id AS "adsProductId" FROM marketplace_product_mappings
       WHERE active AND mapping_type = 'SKU' AND seller_sku = $1::text LIMIT 1`,
      [line.sellerSku],
    );
    if (bySku) return { listingId: null, productId: bySku.productId, adsProductId: bySku.adsProductId, mappingId: bySku.id, mappingStatus: "MAPPED", mappingMethod: "SKU_LINK" };
  }
  return UNMAPPED;
}

/** Recalcula mapeamento e status de preparação do pedido a partir dos itens gravados. */
export async function recomputeOrderMapping(sql: Sql, orderInboxId: string): Promise<{ mappingStatus: string; adsImportStatus: string } | null> {
  const [o] = await sql.query<{ orderStatus: string | null; paymentStatus: string | null; total: number; unmapped: number; ads: string }>(
    `SELECT o.order_status AS "orderStatus", o.payment_status AS "paymentStatus", o.ads_import_status AS ads,
            (SELECT count(*)::int FROM marketplace_order_items i WHERE i.order_id = o.id) AS total,
            (SELECT count(*)::int FROM marketplace_order_items i WHERE i.order_id = o.id AND i.mapping_status = 'UNMAPPED') AS unmapped
     FROM marketplace_order_inbox o WHERE o.id = $1::bigint`,
    [orderInboxId],
  );
  if (!o) return null;
  const mapping = mappingStatusOf(o.total, o.unmapped);
  const ads = adsStatusOf({ orderStatus: o.orderStatus, paymentStatus: o.paymentStatus, mapping, unmapped: o.unmapped });
  // ERROR só é sobrescrito por uma nova leitura do pedido, não por um remapeamento.
  const next = o.ads === "ERROR" ? "ERROR" : ads.status;
  await sql.execute(
    `UPDATE marketplace_order_inbox SET mapping_status = $2::text, ads_import_status = $3::text,
       ads_status_reason = CASE WHEN $3::text = 'ERROR' THEN ads_status_reason ELSE $4::text END, updated_at = now()
     WHERE id = $1::bigint`,
    [orderInboxId, mapping, next, ads.reason],
  );
  return { mappingStatus: mapping, adsImportStatus: next };
}

/** Reaplica a correspondência nas linhas sem vínculo (ou não manuais) dos pedidos indicados (ou de todos). */
export async function remapOrders(sql: Sql, orderInboxIds?: string[]): Promise<{ lines: number; mapped: number; orders: number }> {
  const lines = await sql.query<{ id: string; orderId: string; itemId: string; variationId: string | null; userProductId: string | null; sellerSku: string | null }>(
    `SELECT i.id::text AS id, i.order_id::text AS "orderId", i.marketplace_item_id AS "itemId", i.variation_id AS "variationId",
            i.user_product_id AS "userProductId", i.seller_sku AS "sellerSku"
     FROM marketplace_order_items i
     WHERE i.mapping_status = 'UNMAPPED' AND ($1::bigint[] IS NULL OR i.order_id = ANY($1::bigint[]))`,
    [orderInboxIds ?? null],
  );
  let mapped = 0;
  const touched = new Set<string>();
  for (const l of lines) {
    const r = await resolveProduct(sql, l);
    if (r.mappingStatus !== "MAPPED") continue;
    mapped++;
    touched.add(l.orderId);
    await sql.execute(
      `UPDATE marketplace_order_items SET listing_id = $2::int, product_id = $3::int, ads_product_id = $4::int, mapping_status = 'MAPPED',
         mapping_method = $5::text, mapping_id = $6::bigint WHERE id = $1::bigint AND mapping_status = 'UNMAPPED'`,
      [l.id, r.listingId, r.productId, r.adsProductId, r.mappingMethod, r.mappingId],
    );
  }
  for (const id of touched) await recomputeOrderMapping(sql, id);
  return { lines: lines.length, mapped, orders: touched.size };
}

export class MappingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MappingError";
  }
}

export interface MappingInput {
  scope: "ITEM" | "SKU" | "ORDER_LINE";
  productId: number;
  createdBy: string;
  itemId?: string | null;
  variationId?: string | null;
  sellerSku?: string | null;
  orderInboxId?: string | null;
  lineKey?: string | null;
  notes?: string | null;
  /** Substitui um vínculo ativo existente para a mesma chave. */
  replace?: boolean;
  /** false = não reaplica nos pedidos agora (usado no lote, que reaplica uma vez no fim). */
  remap?: boolean;
  /** Critério que originou o vínculo ITEM (padrão MANUAL). */
  source?: "MANUAL" | "SKU_MATCH" | "GTIN_MATCH" | "MANUFACTURER_MATCH";
  /** Composição do kit/pacote (vínculo ITEM). Vazio = 1 unidade do produto por venda. */
  components?: { productId: number; quantity: number }[];
  /** Limite de quantidade anunciada para este anúncio (vínculo ITEM). */
  maxQuantity?: number | null;
}

/**
 * Registra a correspondência indicada pelo administrador e a aplica aos pedidos pendentes.
 * ITEM e SKU são reutilizados em pedidos futuros; ORDER_LINE vale só para aquela linha.
 */
export async function saveMapping(sql: Sql, m: MappingInput): Promise<{ mappingId: string | null; remapped: { lines: number; mapped: number; orders: number } }> {
  const [product] = await sql.query<{ id: number; adsProductId: number; inactive: boolean }>(
    `SELECT id, ads_product_id AS "adsProductId", inactive FROM products WHERE id = $1::int`,
    [m.productId],
  );
  if (!product) throw new MappingError("product_not_found", "Produto ADS não encontrado no catálogo importado");
  if (product.inactive) throw new MappingError("product_inactive", "Produto ADS inativo: escolha um produto ativo");

  if (m.scope === "ORDER_LINE") {
    if (!m.orderInboxId || !m.lineKey) throw new MappingError("invalid_line", "Pedido e linha são obrigatórios");
    const n = await sql.execute(
      `UPDATE marketplace_order_items SET listing_id = NULL, product_id = $3::int, ads_product_id = $4::int, mapping_status = 'MAPPED',
         mapping_method = 'MANUAL', mapping_id = NULL WHERE order_id = $1::bigint AND line_key = $2::text`,
      [m.orderInboxId, m.lineKey, product.id, product.adsProductId],
    );
    if (!n) throw new MappingError("line_not_found", "Linha do pedido não encontrada");
    await recomputeOrderMapping(sql, m.orderInboxId);
    return { mappingId: null, remapped: { lines: 1, mapped: 1, orders: 1 } };
  }

  return sql.transaction(async (tx) => {
    if (m.scope === "ITEM") {
      if (!m.itemId || !/^MLB\d{1,15}$/.test(m.itemId)) throw new MappingError("invalid_item", "ID de anúncio do Mercado Livre inválido");
      const variation = m.variationId ?? "";
      const [current] = await tx.query<{ id: string; productId: number }>(
        `SELECT id::text AS id, product_id AS "productId" FROM marketplace_product_mappings
         WHERE active AND mapping_type = 'ITEM' AND marketplace_item_id = $1::text AND variation_id = $2::text`,
        [m.itemId, variation],
      );
      if (current && current.productId !== product.id && !m.replace) throw new MappingError("mapping_exists", "Este anúncio já está vinculado a outro produto ADS");
      if (current) await tx.execute(`UPDATE marketplace_product_mappings SET active = false, deactivated_at = now(), deactivated_by = $2::text WHERE id = $1::bigint`, [current.id, m.createdBy]);
      const [row] = await tx.query<{ id: string }>(
        `INSERT INTO marketplace_product_mappings (mapping_type, marketplace_item_id, variation_id, product_id, ads_product_id, created_by, notes, source, max_quantity)
         VALUES ('ITEM', $1::text, $2::text, $3::int, $4::int, $5::text, $6::text, $7::text, $8::int) RETURNING id::text AS id`,
        [m.itemId, variation, product.id, product.adsProductId, m.createdBy, m.notes ?? null, m.source ?? "MANUAL", m.maxQuantity ?? null],
      );
      if (m.components?.length) {
        const comps = await tx.query<{ id: number; adsProductId: number; inactive: boolean }>(
          `SELECT id, ads_product_id AS "adsProductId", inactive FROM products WHERE id = ANY($1::int[])`,
          [m.components.map((c) => c.productId)],
        );
        for (const c of m.components) {
          const p = comps.find((x) => x.id === c.productId);
          if (!p) throw new MappingError("component_not_found", `Componente ${c.productId} não encontrado no catálogo`);
          if (p.inactive) throw new MappingError("component_inactive", `Componente ADS ${p.adsProductId} está inativo`);
          await tx.execute(
            `INSERT INTO marketplace_mapping_components (mapping_id, product_id, ads_product_id, quantity) VALUES ($1::bigint, $2::int, $3::int, $4::int)`,
            [row.id, p.id, p.adsProductId, c.quantity],
          );
        }
      }
      return { mappingId: row.id, remapped: m.remap === false ? { lines: 0, mapped: 0, orders: 0 } : await remapOrders(tx) };
    }
    const sku = m.sellerSku?.trim();
    if (!sku || sku.length > 120) throw new MappingError("invalid_sku", "SKU inválido");
    const [current] = await tx.query<{ id: string; productId: number }>(
      `SELECT id::text AS id, product_id AS "productId" FROM marketplace_product_mappings WHERE active AND mapping_type = 'SKU' AND seller_sku = $1::text`,
      [sku],
    );
    if (current && current.productId !== product.id && !m.replace) throw new MappingError("mapping_exists", "Este SKU já está vinculado a outro produto ADS");
    if (current) await tx.execute(`UPDATE marketplace_product_mappings SET active = false, deactivated_at = now(), deactivated_by = $2::text WHERE id = $1::bigint`, [current.id, m.createdBy]);
    const [row] = await tx.query<{ id: string }>(
      `INSERT INTO marketplace_product_mappings (mapping_type, seller_sku, product_id, ads_product_id, created_by, notes)
       VALUES ('SKU', $1::text, $2::int, $3::int, $4::text, $5::text) RETURNING id::text AS id`,
      [sku, product.id, product.adsProductId, m.createdBy, m.notes ?? null],
    );
    return { mappingId: row.id, remapped: await remapOrders(tx) };
  });
}

/** Desativa um vínculo (não altera pedidos já mapeados; afeta pedidos futuros). */
export async function deactivateMapping(sql: Sql, id: string, by: string | null = null): Promise<boolean> {
  return (await sql.execute(`UPDATE marketplace_product_mappings SET active = false, deactivated_at = now(), deactivated_by = $2::text WHERE id = $1::bigint AND active`, [id, by])) > 0;
}

export async function listMappings(sql: Sql) {
  return sql.query(
    `SELECT m.id::text AS id, m.mapping_type AS "mappingType", m.marketplace_item_id AS "itemId", m.variation_id AS "variationId",
            m.seller_sku AS "sellerSku", m.product_id AS "productId", m.ads_product_id AS "adsProductId",
            COALESCE(p.name_custom, p.name_original) AS "productName", m.created_by AS "createdBy", m.notes, m.created_at AS "createdAt",
            (SELECT count(*)::int FROM marketplace_order_items i WHERE i.mapping_id = m.id) AS "usedBy"
     FROM marketplace_product_mappings m JOIN products p ON p.id = m.product_id
     WHERE m.active ORDER BY m.created_at DESC LIMIT 500`,
  );
}

/** Itens sem vínculo agrupados por anúncio/variação/SKU, com quantos pedidos dependem de cada um. */
export async function listUnmappedGroups(sql: Sql) {
  return sql.query(
    `SELECT i.marketplace_item_id AS "itemId", COALESCE(i.variation_id, '') AS "variationId", i.seller_sku AS "sellerSku",
            max(i.title) AS title, count(DISTINCT i.order_id)::int AS orders, sum(i.quantity)::text AS units,
            min(o.id)::text AS "sampleOrderId", min(i.line_key) AS "sampleLineKey"
     FROM marketplace_order_items i JOIN marketplace_order_inbox o ON o.id = i.order_id
     WHERE i.mapping_status = 'UNMAPPED'
     GROUP BY 1, 2, 3 ORDER BY orders DESC, "itemId" LIMIT 300`,
  );
}

export interface BarcodeSuggestion {
  itemId: string;
  variationId: string;
  sellerSku: string | null;
  title: string | null;
  orders: number;
  gtins: string[];
  candidates: { productId: number; adsProductId: number; name: string; ean: string | null }[];
}

const gtinDigits = (v: unknown): string[] =>
  String(v ?? "")
    .split(/[,;\s]+/)
    .map((x) => x.replace(/\D/g, ""))
    .filter((x) => x.length >= 8 && x.length <= 14);

type MlAttr = { id?: string; value_name?: string | null; values?: { name?: string | null }[] };
function gtinsOf(attrs: MlAttr[] | undefined): string[] {
  const out: string[] = [];
  for (const a of attrs ?? []) {
    if (a?.id !== "GTIN") continue;
    out.push(...gtinDigits(a.value_name));
    for (const v of a.values ?? []) out.push(...gtinDigits(v?.name));
  }
  return out;
}

/**
 * Sugestões por código de barras: lê o GTIN dos anúncios vendidos (GET /items, somente leitura) e
 * procura o produto ADS ativo com o mesmo EAN/DUN-14. É só sugestão: o administrador confirma.
 */
export async function suggestByBarcode(sql: Sql): Promise<BarcodeSuggestion[]> {
  const groups = (await listUnmappedGroups(sql)) as unknown as Omit<BarcodeSuggestion, "gtins" | "candidates">[];
  const ids = [...new Set(groups.map((g) => g.itemId).filter((id) => /^MLB\d{1,15}$/.test(id)))];
  const items = new Map<string, { attributes?: MlAttr[]; variations?: { id?: number | string; attributes?: MlAttr[]; attribute_combinations?: MlAttr[] }[] }>();
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    const { data } = await multigetItems<{ code: number; body: { id?: string; attributes?: MlAttr[]; variations?: [] } }>(chunk, "id,attributes,variations").then((data) => ({ data }));
    for (const e of Array.isArray(data) ? data : []) if (e.code === 200 && e.body?.id) items.set(e.body.id, e.body);
  }
  const out: BarcodeSuggestion[] = [];
  for (const g of groups) {
    const it = items.get(g.itemId);
    let gtins: string[] = [];
    if (it) {
      const variation = g.variationId ? it.variations?.find((v) => String(v.id) === g.variationId) : undefined;
      gtins = variation ? [...gtinsOf(variation.attributes), ...gtinsOf(variation.attribute_combinations)] : [];
      if (!gtins.length) gtins = gtinsOf(it.attributes);
    }
    gtins = [...new Set(gtins.map((x) => x.replace(/^0+/, "")))];
    const candidates = gtins.length
      ? await sql.query<{ productId: number; adsProductId: number; name: string; ean: string | null }>(
          `SELECT id AS "productId", ads_product_id AS "adsProductId", COALESCE(name_custom, name_original) AS name, ean
           FROM products WHERE NOT inactive AND (ltrim(ean, '0') = ANY($1::text[]) OR ltrim(dun14, '0') = ANY($1::text[]))
           ORDER BY ads_product_id LIMIT 5`,
          [gtins],
        )
      : [];
    out.push({ itemId: g.itemId, variationId: g.variationId, sellerSku: g.sellerSku, title: g.title, orders: Number(g.orders), gtins, candidates });
  }
  return out;
}
