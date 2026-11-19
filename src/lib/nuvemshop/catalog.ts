import "server-only";
import { sha256Hex } from "../crypto";
import type { Sql } from "../sql";
import { isValidGtin } from "../stock/matching";
import { pickText, type NsCategory, type NsImage, type NsLocation, type NsProduct, type NsVariant } from "./client";

/**
 * Conversão e gravação do catálogo Nuvemshop (somente local). Preserva o payload original em raw_payload,
 * nunca altera produtos da ADS e nunca escreve na Nuvemshop.
 */

export class CatalogItemError extends Error {
  constructor(
    readonly itemId: string,
    message: string,
  ) {
    super(message);
    this.name = "CatalogItemError";
  }
}

const dec = (v: unknown): string | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : null;
};
const int = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};
const date = (v: unknown): string | null => {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** SKU normalizado: maiúsculas, sem espaços nas pontas e espaços internos colapsados. */
export function normalizeSku(sku: unknown): string | null {
  if (typeof sku !== "string") return null;
  const s = sku.trim().replace(/\s+/g, " ").toUpperCase();
  return s.length ? s : null;
}

/** GTIN válido (dígito verificador) a partir do barcode; null quando não é GTIN. */
export function gtinOf(barcode: unknown): string | null {
  if (typeof barcode !== "string" && typeof barcode !== "number") return null;
  const d = String(barcode).replace(/\D/g, "");
  return d && isValidGtin(d) ? d : null;
}

export type StockState = "POSITIVE" | "ZERO" | "UNLIMITED" | "UNKNOWN" | "NEGATIVE";

/**
 * Situação do estoque de uma variante, sem interpretar desconhecido como zero:
 *  - stock_management = false → estoque não controlado (UNLIMITED);
 *  - stock_management = true e stock numérico → POSITIVE/ZERO/NEGATIVE;
 *  - qualquer outra combinação → UNKNOWN.
 */
export function stockStateOf(v: { stockManagement: boolean | null; stock: number | null }): StockState {
  if (v.stockManagement === false) return "UNLIMITED";
  if (v.stockManagement === true && v.stock !== null) return v.stock > 0 ? "POSITIVE" : v.stock === 0 ? "ZERO" : "NEGATIVE";
  return "UNKNOWN";
}

export interface MappedVariant {
  variantId: string;
  productId: string;
  position: number | null;
  sku: string | null;
  skuNorm: string | null;
  barcode: string | null;
  gtin: string | null;
  mpn: string | null;
  values: unknown;
  price: string | null;
  promotionalPrice: string | null;
  stockManagement: boolean | null;
  stock: number | null;
  inventoryLevels: { locationId: string; stock: number | null }[] | null;
  weight: string | null;
  width: string | null;
  height: string | null;
  depth: string | null;
  visible: boolean | null;
  imageId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  raw: NsVariant;
}

export function mapVariant(v: NsVariant, productId: number): MappedVariant {
  if (!v || !Number.isInteger(Number(v.id))) throw new CatalogItemError(String(v?.id ?? "?"), "Variante sem id numérico");
  if (v.product_id !== undefined && Number(v.product_id) !== Number(productId)) throw new CatalogItemError(String(v.id), "Variante de outro produto");
  const sku = typeof v.sku === "string" && v.sku.trim() ? v.sku.trim() : null;
  const levels = Array.isArray(v.inventory_levels)
    ? v.inventory_levels.filter((l) => l && typeof l.location_id === "string" && l.location_id).map((l) => ({ locationId: l.location_id, stock: int(l.stock) }))
    : null;
  const barcode = typeof v.barcode === "string" && v.barcode.trim() ? v.barcode.trim() : null;
  return {
    variantId: String(v.id),
    productId: String(productId),
    position: int(v.position),
    sku,
    skuNorm: normalizeSku(sku),
    barcode,
    gtin: gtinOf(barcode),
    mpn: typeof v.mpn === "string" && v.mpn.trim() ? v.mpn.trim() : null,
    values: v.values ?? null,
    price: dec(v.price),
    promotionalPrice: dec(v.promotional_price),
    stockManagement: typeof v.stock_management === "boolean" ? v.stock_management : null,
    stock: int(v.stock),
    inventoryLevels: levels,
    weight: dec(v.weight),
    width: dec(v.width),
    height: dec(v.height),
    depth: dec(v.depth),
    visible: typeof v.visible === "boolean" ? v.visible : null,
    imageId: v.image_id ? String(v.image_id) : null,
    createdAt: date(v.created_at),
    updatedAt: date(v.updated_at),
    raw: v,
  };
}

export interface MappedProduct {
  productId: string;
  name: string | null;
  names: unknown;
  description: string | null;
  handle: string | null;
  brand: string | null;
  visibility: string | null;
  published: boolean | null;
  isKit: boolean;
  attributes: unknown;
  categoryIds: string[];
  tags: string | null;
  canonicalUrl: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  images: { imageId: string; src: string; position: number | null; alt: string | null }[];
  /** null = o payload não trouxe a lista de variantes (buscar em /products/{id}/variants). */
  variants: NsVariant[] | null;
  hash: string;
  raw: NsProduct;
}

export function mapProduct(p: NsProduct, lang = "pt"): MappedProduct {
  if (!p || !Number.isInteger(Number(p.id))) throw new CatalogItemError(String(p?.id ?? "?"), "Produto sem id numérico");
  const images = (Array.isArray(p.images) ? p.images : [])
    .filter((i): i is NsImage => Boolean(i && i.id && typeof i.src === "string" && /^https?:\/\//.test(i.src)))
    .map((i) => ({ imageId: String(i.id), src: i.src, position: int(i.position), alt: Array.isArray(i.alt) ? pickText(i.alt[0] ?? null, lang) : pickText((i.alt as never) ?? null, lang) }));
  const categoryIds = (Array.isArray(p.categories) ? p.categories : [])
    .map((c) => (typeof c === "object" && c ? c.id : c))
    .filter((c) => Number.isInteger(Number(c)))
    .map(String);
  const { variants: _v, ...withoutVariants } = p;
  return {
    productId: String(p.id),
    name: pickText(p.name ?? null, lang),
    names: p.name ?? null,
    description: pickText(p.description ?? null, lang),
    handle: pickText(p.handle ?? null, lang),
    brand: typeof p.brand === "string" && p.brand.trim() ? p.brand.trim() : null,
    visibility: typeof p.visibility === "string" ? p.visibility : p.published === true ? "visible" : p.published === false ? "hidden" : null,
    published: typeof p.published === "boolean" ? p.published : null,
    isKit: p.is_kit === true,
    attributes: p.attributes ?? null,
    categoryIds,
    tags: typeof p.tags === "string" ? p.tags : null,
    canonicalUrl: typeof p.canonical_url === "string" ? p.canonical_url : null,
    createdAt: date(p.created_at),
    updatedAt: date(p.updated_at),
    images,
    variants: Array.isArray(p.variants) ? p.variants : null,
    hash: sha256Hex(JSON.stringify(p)),
    raw: withoutVariants as NsProduct,
  };
}

export interface UpsertResult {
  created: number;
  updated: number;
  unchanged: number;
  variants: number;
  removedVariants: string[];
}

/**
 * Grava um produto com variantes, imagens e níveis de estoque. Idempotente (UPSERT por store_id + id).
 * Variantes do produto ausentes do payload completo são marcadas REMOVED (nunca apagadas): os vínculos
 * delas vão para revisão pelo motor de vinculação, não são removidos automaticamente.
 */
export async function upsertProduct(tx: Sql, storeId: string, jobId: string | null, p: MappedProduct, variants: MappedVariant[], now: Date): Promise<UpsertResult> {
  const [prev] = await tx.query<{ hash: string; status: string }>(`SELECT payload_hash AS hash, sync_status AS status FROM nuvemshop_products WHERE store_id = $1 AND product_id = $2::bigint`, [storeId, p.productId]);
  const fullHash = sha256Hex(p.hash + JSON.stringify(variants.map((v) => v.raw)));
  await tx.execute(
    `INSERT INTO nuvemshop_products (store_id, product_id, name, names, description, handle, brand, visibility, published, is_kit, attributes, category_ids, tags,
       canonical_url, variant_count, image_count, remote_created_at, remote_updated_at, raw_payload, payload_hash, fetched_at, last_seen_job_id, sync_status, removed_at)
     VALUES ($1, $2::bigint, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::bigint[], $13, $14, $15, $16, $17::timestamptz, $18::timestamptz, $19::jsonb, $20, $21::timestamptz, $22::uuid, 'ACTIVE', NULL)
     ON CONFLICT (store_id, product_id) DO UPDATE SET name = EXCLUDED.name, names = EXCLUDED.names, description = EXCLUDED.description, handle = EXCLUDED.handle,
       brand = EXCLUDED.brand, visibility = EXCLUDED.visibility, published = EXCLUDED.published, is_kit = EXCLUDED.is_kit, attributes = EXCLUDED.attributes,
       category_ids = EXCLUDED.category_ids, tags = EXCLUDED.tags, canonical_url = EXCLUDED.canonical_url, variant_count = EXCLUDED.variant_count,
       image_count = EXCLUDED.image_count, remote_created_at = EXCLUDED.remote_created_at, remote_updated_at = EXCLUDED.remote_updated_at,
       raw_payload = EXCLUDED.raw_payload, payload_hash = EXCLUDED.payload_hash, fetched_at = EXCLUDED.fetched_at, last_seen_job_id = EXCLUDED.last_seen_job_id,
       sync_status = 'ACTIVE', removed_at = NULL,
       updated_at = CASE WHEN nuvemshop_products.payload_hash IS DISTINCT FROM EXCLUDED.payload_hash OR nuvemshop_products.sync_status <> 'ACTIVE' THEN now() ELSE nuvemshop_products.updated_at END`,
    [
      storeId,
      p.productId,
      p.name,
      JSON.stringify(p.names),
      p.description,
      p.handle,
      p.brand,
      p.visibility,
      p.published,
      p.isKit,
      JSON.stringify(p.attributes),
      p.categoryIds,
      p.tags,
      p.canonicalUrl,
      variants.length,
      p.images.length,
      p.createdAt,
      p.updatedAt,
      JSON.stringify(p.raw),
      fullHash,
      now.toISOString(),
      jobId,
    ],
  );

  for (const v of variants) {
    await tx.execute(
      `INSERT INTO nuvemshop_variants (store_id, variant_id, product_id, position, sku, sku_norm, barcode, gtin, mpn, option_values, price, promotional_price,
         stock_management, stock, has_inventory_levels, weight, width, height, depth, visible, image_id, remote_created_at, remote_updated_at, raw_payload, fetched_at,
         last_seen_job_id, sync_status, removed_at)
       VALUES ($1, $2::bigint, $3::bigint, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::numeric, $12::numeric, $13, $14, $15, $16::numeric, $17::numeric, $18::numeric,
         $19::numeric, $20, $21::bigint, $22::timestamptz, $23::timestamptz, $24::jsonb, $25::timestamptz, $26::uuid, 'ACTIVE', NULL)
       ON CONFLICT (store_id, variant_id) DO UPDATE SET product_id = EXCLUDED.product_id, position = EXCLUDED.position, sku = EXCLUDED.sku, sku_norm = EXCLUDED.sku_norm,
         barcode = EXCLUDED.barcode, gtin = EXCLUDED.gtin, mpn = EXCLUDED.mpn, option_values = EXCLUDED.option_values, price = EXCLUDED.price,
         promotional_price = EXCLUDED.promotional_price, stock_management = EXCLUDED.stock_management, stock = EXCLUDED.stock,
         has_inventory_levels = EXCLUDED.has_inventory_levels, weight = EXCLUDED.weight, width = EXCLUDED.width, height = EXCLUDED.height, depth = EXCLUDED.depth,
         visible = EXCLUDED.visible, image_id = EXCLUDED.image_id, remote_created_at = EXCLUDED.remote_created_at, remote_updated_at = EXCLUDED.remote_updated_at,
         raw_payload = EXCLUDED.raw_payload, fetched_at = EXCLUDED.fetched_at, last_seen_job_id = EXCLUDED.last_seen_job_id, sync_status = 'ACTIVE', removed_at = NULL,
         updated_at = now()`,
      [
        storeId,
        v.variantId,
        p.productId,
        v.position,
        v.sku,
        v.skuNorm,
        v.barcode,
        v.gtin,
        v.mpn,
        JSON.stringify(v.values),
        v.price,
        v.promotionalPrice,
        v.stockManagement,
        v.stock,
        v.inventoryLevels !== null,
        v.weight,
        v.width,
        v.height,
        v.depth,
        v.visible,
        v.imageId,
        v.createdAt,
        v.updatedAt,
        JSON.stringify(v.raw),
        now.toISOString(),
        jobId,
      ],
    );
    await tx.execute(`DELETE FROM nuvemshop_inventory_levels WHERE store_id = $1 AND variant_id = $2::bigint`, [storeId, v.variantId]);
    for (const l of v.inventoryLevels ?? []) {
      await tx.execute(
        `INSERT INTO nuvemshop_inventory_levels (store_id, variant_id, location_id, stock, fetched_at) VALUES ($1, $2::bigint, $3, $4, $5::timestamptz)
         ON CONFLICT (store_id, variant_id, location_id) DO UPDATE SET stock = EXCLUDED.stock, fetched_at = EXCLUDED.fetched_at`,
        [storeId, v.variantId, l.locationId, l.stock, now.toISOString()],
      );
    }
  }

  const removed = await tx.query<{ variantId: string }>(
    `UPDATE nuvemshop_variants SET sync_status = 'REMOVED', removed_at = $4::timestamptz, updated_at = now()
     WHERE store_id = $1 AND product_id = $2::bigint AND sync_status = 'ACTIVE' AND NOT (variant_id = ANY($3::bigint[])) RETURNING variant_id::text AS "variantId"`,
    [storeId, p.productId, variants.map((v) => v.variantId), now.toISOString()],
  );

  await tx.execute(`DELETE FROM nuvemshop_product_images WHERE store_id = $1 AND product_id = $2::bigint AND NOT (image_id = ANY($3::bigint[]))`, [storeId, p.productId, p.images.map((i) => i.imageId)]);
  for (const i of p.images) {
    await tx.execute(
      `INSERT INTO nuvemshop_product_images (store_id, image_id, product_id, src, position, alt, fetched_at) VALUES ($1, $2::bigint, $3::bigint, $4, $5, $6, $7::timestamptz)
       ON CONFLICT (store_id, image_id) DO UPDATE SET product_id = EXCLUDED.product_id, src = EXCLUDED.src, position = EXCLUDED.position, alt = EXCLUDED.alt, fetched_at = EXCLUDED.fetched_at`,
      [storeId, i.imageId, p.productId, i.src, i.position, i.alt, now.toISOString()],
    );
  }

  const created = prev ? 0 : 1;
  const updated = prev && (prev.hash !== fullHash || prev.status !== "ACTIVE") ? 1 : 0;
  return { created, updated, unchanged: prev && !updated ? 1 : 0, variants: variants.length, removedVariants: removed.map((r) => r.variantId) };
}

export async function upsertCategories(tx: Sql, storeId: string, categories: NsCategory[], now: Date, lang = "pt"): Promise<number> {
  let n = 0;
  for (const c of categories) {
    if (!c || !Number.isInteger(Number(c.id))) continue;
    await tx.execute(
      `INSERT INTO nuvemshop_categories (store_id, category_id, name, parent_id, raw_payload, fetched_at) VALUES ($1, $2::bigint, $3, $4::bigint, $5::jsonb, $6::timestamptz)
       ON CONFLICT (store_id, category_id) DO UPDATE SET name = EXCLUDED.name, parent_id = EXCLUDED.parent_id, raw_payload = EXCLUDED.raw_payload, fetched_at = EXCLUDED.fetched_at`,
      [storeId, String(c.id), pickText(c.name ?? null, lang), c.parent ? String(c.parent) : null, JSON.stringify(c), now.toISOString()],
    );
    n++;
  }
  return n;
}

/** Grava as localizações lidas; as que sumiram ficam marcadas (o mapeamento delas não é apagado). */
export async function upsertLocations(tx: Sql, storeId: string, locations: NsLocation[], now: Date, lang = "pt"): Promise<number> {
  const ids: string[] = [];
  for (const l of locations) {
    if (!l || typeof l.id !== "string" || !l.id) continue;
    ids.push(l.id);
    await tx.execute(
      `INSERT INTO nuvemshop_locations (store_id, location_id, name, is_default, priority, tags, raw_payload, fetched_at, removed_at)
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7::jsonb, $8::timestamptz, NULL)
       ON CONFLICT (store_id, location_id) DO UPDATE SET name = EXCLUDED.name, is_default = EXCLUDED.is_default, priority = EXCLUDED.priority, tags = EXCLUDED.tags,
         raw_payload = EXCLUDED.raw_payload, fetched_at = EXCLUDED.fetched_at, removed_at = NULL`,
      [storeId, l.id, pickText(l.name ?? null, `${lang}_BR`) ?? pickText(l.name ?? null, lang), l.is_default ?? null, int(l.priority), Array.isArray(l.tags) ? l.tags.map(String) : null, JSON.stringify(l), now.toISOString()],
    );
  }
  await tx.execute(`UPDATE nuvemshop_locations SET removed_at = $3::timestamptz WHERE store_id = $1 AND removed_at IS NULL AND NOT (location_id = ANY($2::text[]))`, [storeId, ids, now.toISOString()]);
  return ids.length;
}
