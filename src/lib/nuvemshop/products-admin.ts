import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isUniqueViolation, type Sql } from "../sql";
import { AutomationError, getAutomation, WRITE_MODES } from "./automation";
import { normalizeSku } from "./catalog";
import { NuvemshopApiError, type NsProduct, type NuvemshopApiClient } from "./client";
import { confirmMapping } from "./mapping";
import { refreshProducts } from "./remote-state";
import { clientForConnectedStore, type StoreRow } from "./store";
import { issueWritePermit } from "./write-gate";
import type { WorkerDeps } from "./write-jobs";

/**
 * Gestão de produtos, variantes e imagens na Nuvemshop (operações MANUAIS do administrador).
 *
 * - Toda escrita passa pelo portão (categoria CATALOG) e é registrada em nuvemshop_product_operations.
 * - Depois de cada escrita o produto é relido na API e gravado no catálogo local; a operação só é marcada como
 *   verificada quando a leitura confirma o que foi pedido.
 * - Não recria produto: recusa se o produto ADS já tem variante vinculada, se o SKU já existe na loja, ou se há uma
 *   criação anterior em andamento/incerta (índice único no banco). Criação incerta (timeout) é reconciliada por busca
 *   do SKU na loja antes de qualquer nova tentativa.
 * - Produto novo nasce OCULTO (visibility hidden) e com estoque 0 controlado: publicar é uma ação manual separada,
 *   e o estoque vem só da sincronização (cotas do Inventory Core).
 * - Nunca usa PUT /products/{id}/variants (coleção): ele apaga variantes omitidas e trocaria IDs. Variantes são
 *   criadas e editadas uma a uma; o estoque nunca é editado por aqui.
 * - Remover imagem exige confirmação explícita com o ID da imagem.
 */
export type CatalogOperation = "CREATE_PRODUCT" | "UPDATE_PRODUCT" | "SET_VISIBILITY" | "CREATE_VARIANT" | "UPDATE_VARIANT" | "ADD_IMAGE" | "SET_MAIN_IMAGE" | "REMOVE_IMAGE";

type Conn = { store: StoreRow; client: NuvemshopApiClient };

async function connOf(sql: Sql, deps: WorkerDeps = {}): Promise<Conn> {
  return deps.client ?? clientForConnectedStore(sql, { fetchImpl: deps.fetchImpl, sleep: deps.sleep, maxRetries: deps.maxRetries });
}

async function startOp(sql: Sql, input: { storeId: string; operation: CatalogOperation; nsProductId?: string | null; variantId?: string | null; imageId?: string | null; productId?: number | null; request: unknown; actor: string }): Promise<string> {
  try {
    const [row] = await sql.query<{ id: string }>(
      `INSERT INTO nuvemshop_product_operations (store_id, operation, nuvemshop_product_id, variant_id, image_id, product_id, idempotency_key, request, actor)
       VALUES ($1, $2, $3::bigint, $4::bigint, $5::bigint, $6, $7, $8::jsonb, $9) RETURNING id::text AS id`,
      [input.storeId, input.operation, input.nsProductId ?? null, input.variantId ?? null, input.imageId ?? null, input.productId ?? null, `${input.operation}:${randomUUID()}`, JSON.stringify(input.request), input.actor],
    );
    return row.id;
  } catch (err) {
    if (isUniqueViolation(err)) throw new AutomationError("create_in_progress", "Já existe uma criação deste produto em andamento ou com resultado incerto: reconcilie antes de tentar de novo");
    throw err;
  }
}

async function endOp(sql: Sql, id: string, status: "SUCCEEDED" | "FAILED" | "UNCERTAIN" | "RESOLVED", extra: { result?: unknown; verified?: boolean; error?: string | null; nsProductId?: string | null; variantId?: string | null; imageId?: string | null } = {}) {
  await sql.execute(
    `UPDATE nuvemshop_product_operations SET status = $2, result = $3::jsonb, verified = $4, error_message = $5, finished_at = now(),
       nuvemshop_product_id = COALESCE($6::bigint, nuvemshop_product_id), variant_id = COALESCE($7::bigint, variant_id), image_id = COALESCE($8::bigint, image_id) WHERE id = $1::uuid`,
    [id, status, extra.result === undefined ? null : JSON.stringify(extra.result), extra.verified ?? false, extra.error?.slice(0, 500) ?? null, extra.nsProductId ?? null, extra.variantId ?? null, extra.imageId ?? null],
  );
}

/** Executa a escrita e classifica o erro (incerto × falha definitiva). */
async function write<T>(sql: Sql, opId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const api = err instanceof NuvemshopApiError ? err : null;
    await endOp(sql, opId, api?.uncertain ? "UNCERTAIN" : "FAILED", { error: (err as Error).message });
    throw err;
  }
}

const textSchema = (max: number) => z.string().trim().min(1).max(max);
const priceSchema = z.number().positive().max(1_000_000);
const httpsUrl = z.string().trim().url().max(2000).refine((u) => u.startsWith("https://"), "A imagem deve ter URL https pública");

export const createProductSchema = z
  .object({
    productId: z.number().int().positive(),
    name: textSchema(250).optional(),
    description: z.string().max(50_000).nullable().optional(),
    price: priceSchema,
    sku: textSchema(80).optional(),
    barcode: z.string().trim().max(40).nullable().optional(),
    brand: z.string().trim().max(120).nullable().optional(),
    categoryIds: z.array(z.number().int().positive()).max(20).optional(),
    imageUrls: z.array(httpsUrl).max(9).optional(),
  })
  .strict();

/** Busca na loja um produto com a variante deste SKU (reconciliação de criação incerta). */
async function findRemoteBySku(client: NuvemshopApiClient, sku: string): Promise<NsProduct | null> {
  const norm = normalizeSku(sku);
  const { data } = await client.get<NsProduct[]>("/products", { q: sku, per_page: 50 });
  for (const p of Array.isArray(data) ? data : []) if ((p.variants ?? []).some((v) => normalizeSku(v.sku) === norm)) return p;
  return null;
}

export interface CreateProductResult {
  nsProductId: string;
  variantId: string;
  verified: boolean;
  reconciled: boolean;
}

export async function createProductFromAds(sql: Sql, input: z.infer<typeof createProductSchema>, actor: string, deps: WorkerDeps = {}): Promise<CreateProductResult> {
  const conn = await connOf(sql, deps);
  const storeId = conn.store.storeId;
  const [p] = await sql.query<{ id: number; adsProductId: number; name: string; ean: string | null; inactive: boolean; kit: boolean; weight: string | null }>(
    `SELECT id, ads_product_id AS "adsProductId", COALESCE(name_custom, name_original) AS name, ean, inactive, COALESCE(raw_payload->>'kit', 'false') = 'true' AS kit,
            trim_scale(gross_weight)::text AS weight FROM products WHERE id = $1`,
    [input.productId],
  );
  if (!p) throw new AutomationError("product_not_found", "Produto ADS não encontrado", 404);
  if (p.inactive) throw new AutomationError("product_inactive", "Produto ADS inativo");
  if (p.kit) throw new AutomationError("kit_not_supported", "Kits da ADS não são criados automaticamente: crie na Nuvemshop e vincule com a composição");
  const sku = input.sku ?? `ADS-${p.adsProductId}`;
  const [linked] = await sql.query<{ variantId: string }>(
    `SELECT variant_id::text AS "variantId" FROM nuvemshop_variant_mappings WHERE store_id = $1 AND product_id = $2 AND status IN ('CONFIRMED', 'NEEDS_REVIEW') LIMIT 1`,
    [storeId, p.id],
  );
  if (linked) throw new AutomationError("already_linked", `O produto ADS já está vinculado à variante ${linked.variantId} na Nuvemshop: não é criado de novo`);
  const [dupe] = await sql.query<{ variantId: string }>(`SELECT variant_id::text AS "variantId" FROM nuvemshop_variants WHERE store_id = $1 AND sku_norm = $2 AND sync_status = 'ACTIVE' LIMIT 1`, [storeId, normalizeSku(sku)]);
  if (dupe) throw new AutomationError("sku_exists", `Já existe a variante ${dupe.variantId} com o SKU ${sku} na loja: vincule-a em vez de criar outro produto`);
  const permit = await issueWritePermit(sql, conn.store, "CATALOG", "POST /products");
  const body: Record<string, unknown> = {
    name: { pt: input.name ?? p.name },
    ...(input.description ? { description: { pt: input.description } } : {}),
    ...(input.brand ? { brand: input.brand } : {}),
    ...(input.categoryIds?.length ? { categories: input.categoryIds } : {}),
    visibility: "hidden",
    variants: [
      {
        price: input.price.toFixed(2),
        sku,
        ...(input.barcode ?? p.ean ? { barcode: input.barcode ?? p.ean } : {}),
        ...(p.weight ? { weight: p.weight } : {}),
        stock_management: true,
        stock: 0,
      },
    ],
    ...(input.imageUrls?.length ? { images: input.imageUrls.map((src) => ({ src })) } : {}),
  };
  const opId = await startOp(sql, { storeId, operation: "CREATE_PRODUCT", productId: p.id, request: { ...body, sku }, actor });
  let created: NsProduct | null = null;
  let reconciled = false;
  try {
    created = (await conn.client.send<NsProduct>(permit, "POST", "/products", body, { idempotent: false })).data;
  } catch (err) {
    const api = err instanceof NuvemshopApiError ? err : null;
    if (!api?.uncertain) {
      await endOp(sql, opId, "FAILED", { error: (err as Error).message });
      throw err;
    }
    // Resultado incerto: procura pelo SKU antes de qualquer nova tentativa (nunca cria duplicado).
    created = await findRemoteBySku(conn.client, sku).catch(() => null);
    if (!created) {
      await endOp(sql, opId, "UNCERTAIN", { error: `${api.message} — produto não encontrado pelo SKU; reconcilie antes de tentar de novo` });
      throw err;
    }
    reconciled = true;
  }
  const nsProductId = String(created?.id ?? "");
  if (!/^\d+$/.test(nsProductId)) {
    await endOp(sql, opId, "UNCERTAIN", { error: "Resposta sem id do produto criado" });
    throw new AutomationError("uncertain_create", "A Nuvemshop não devolveu o id do produto criado: reconcilie antes de tentar de novo", 502);
  }
  const remote = await refreshProducts(sql, conn.client, storeId, [nsProductId]);
  const variant = [...remote.variants.values()].find((v) => !v.removed && normalizeSku(v.sku) === normalizeSku(sku));
  if (!variant) {
    await endOp(sql, opId, "UNCERTAIN", { nsProductId, error: "Produto criado, mas a variante com o SKU não apareceu na releitura" });
    throw new AutomationError("verify_failed", "Produto criado, mas a variante não foi confirmada na releitura: confira na Nuvemshop", 502);
  }
  await confirmMapping(sql, { storeId, variantId: variant.variantId, productId: p.id, actor, notes: "Produto criado pelo integrador a partir da ADS" });
  const verified = variant.stockManagement === true;
  await endOp(sql, opId, reconciled ? "RESOLVED" : "SUCCEEDED", { nsProductId, variantId: variant.variantId, verified, result: { sku, price: variant.price, visibility: "hidden", reconciled } });
  return { nsProductId, variantId: variant.variantId, verified, reconciled };
}

export const updateProductSchema = z
  .object({
    name: textSchema(250).optional(),
    description: z.string().max(50_000).nullable().optional(),
    brand: z.string().trim().max(120).nullable().optional(),
    categoryIds: z.array(z.number().int().positive()).min(1).max(20).optional(),
    seoTitle: z.string().trim().max(70).nullable().optional(),
    seoDescription: z.string().trim().max(320).nullable().optional(),
    tags: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();

async function ensureLocalProduct(sql: Sql, storeId: string, nsProductId: string) {
  const [row] = await sql.query<{ status: string }>(`SELECT sync_status AS status FROM nuvemshop_products WHERE store_id = $1 AND product_id = $2::bigint`, [storeId, nsProductId]);
  if (!row) throw new AutomationError("ns_product_not_found", "Produto Nuvemshop não encontrado no catálogo importado", 404);
  if (row.status !== "ACTIVE") throw new AutomationError("ns_product_removed", "Produto removido na Nuvemshop");
}

export async function updateProduct(sql: Sql, nsProductId: string, patch: z.infer<typeof updateProductSchema>, actor: string, deps: WorkerDeps = {}): Promise<{ verified: boolean }> {
  const conn = await connOf(sql, deps);
  const storeId = conn.store.storeId;
  await ensureLocalProduct(sql, storeId, nsProductId);
  const body: Record<string, unknown> = {};
  if (patch.name !== undefined) body.name = { pt: patch.name };
  if (patch.description !== undefined) body.description = { pt: patch.description ?? "" };
  if (patch.brand !== undefined) body.brand = patch.brand ?? "";
  if (patch.categoryIds !== undefined) body.categories = patch.categoryIds;
  if (patch.seoTitle !== undefined) body.seo_title = { pt: patch.seoTitle ?? "" };
  if (patch.seoDescription !== undefined) body.seo_description = { pt: patch.seoDescription ?? "" };
  if (patch.tags !== undefined) body.tags = patch.tags ?? "";
  if (!Object.keys(body).length) throw new AutomationError("empty_patch", "Nada a alterar", 422);
  const permit = await issueWritePermit(sql, conn.store, "CATALOG", `PUT /products/${nsProductId}`);
  const opId = await startOp(sql, { storeId, operation: "UPDATE_PRODUCT", nsProductId, request: body, actor });
  await write(sql, opId, () => conn.client.send(permit, "PUT", `/products/${nsProductId}`, body, { idempotent: true }));
  await refreshProducts(sql, conn.client, storeId, [nsProductId]);
  const [local] = await sql.query<{ name: string | null; brand: string | null; categoryIds: string[] }>(`SELECT name, brand, category_ids::text[] AS "categoryIds" FROM nuvemshop_products WHERE store_id = $1 AND product_id = $2::bigint`, [storeId, nsProductId]);
  const verified =
    (patch.name === undefined || local?.name === patch.name) &&
    (patch.brand === undefined || (local?.brand ?? null) === (patch.brand || null)) &&
    (patch.categoryIds === undefined || JSON.stringify([...(local?.categoryIds ?? [])].sort()) === JSON.stringify(patch.categoryIds.map(String).sort()));
  await endOp(sql, opId, "SUCCEEDED", { verified, result: { name: local?.name, brand: local?.brand } });
  return { verified };
}

export const VISIBILITY = ["visible", "unlisted", "hidden"] as const;

/** Publicação manual: tornar visível exige confirmação explícita. */
export async function setVisibility(sql: Sql, nsProductId: string, visibility: (typeof VISIBILITY)[number], confirm: boolean, actor: string, deps: WorkerDeps = {}): Promise<{ verified: boolean }> {
  if (visibility === "visible" && !confirm) throw new AutomationError("confirmation_required", "Publicar exige confirmação", 422);
  const conn = await connOf(sql, deps);
  const storeId = conn.store.storeId;
  await ensureLocalProduct(sql, storeId, nsProductId);
  const permit = await issueWritePermit(sql, conn.store, "CATALOG", `PUT /products/${nsProductId}`);
  const opId = await startOp(sql, { storeId, operation: "SET_VISIBILITY", nsProductId, request: { visibility }, actor });
  await write(sql, opId, () => conn.client.send(permit, "PUT", `/products/${nsProductId}`, { visibility }, { idempotent: true }));
  await refreshProducts(sql, conn.client, storeId, [nsProductId]);
  const [local] = await sql.query<{ visibility: string | null }>(`SELECT visibility FROM nuvemshop_products WHERE store_id = $1 AND product_id = $2::bigint`, [storeId, nsProductId]);
  const verified = local?.visibility === visibility;
  await endOp(sql, opId, "SUCCEEDED", { verified, result: { visibility: local?.visibility } });
  return { verified };
}

export const createVariantSchema = z
  .object({
    values: z.array(textSchema(100)).min(1).max(3),
    price: priceSchema,
    sku: textSchema(80),
    barcode: z.string().trim().max(40).nullable().optional(),
    weight: z.number().positive().max(1000).nullable().optional(),
    /** Produto ADS a vincular à nova variante (opcional). */
    productId: z.number().int().positive().optional(),
  })
  .strict();

export async function createVariant(sql: Sql, nsProductId: string, input: z.infer<typeof createVariantSchema>, actor: string, deps: WorkerDeps = {}): Promise<{ variantId: string; linked: boolean }> {
  const conn = await connOf(sql, deps);
  const storeId = conn.store.storeId;
  await ensureLocalProduct(sql, storeId, nsProductId);
  const [dupe] = await sql.query<{ variantId: string }>(`SELECT variant_id::text AS "variantId" FROM nuvemshop_variants WHERE store_id = $1 AND sku_norm = $2 AND sync_status = 'ACTIVE' LIMIT 1`, [storeId, normalizeSku(input.sku)]);
  if (dupe) throw new AutomationError("sku_exists", `SKU já usado pela variante ${dupe.variantId}`);
  const before = new Set((await sql.query<{ id: string }>(`SELECT variant_id::text AS id FROM nuvemshop_variants WHERE store_id = $1 AND product_id = $2::bigint`, [storeId, nsProductId])).map((r) => r.id));
  const body = {
    values: input.values.map((v) => ({ pt: v })),
    price: input.price.toFixed(2),
    sku: input.sku,
    ...(input.barcode ? { barcode: input.barcode } : {}),
    ...(input.weight ? { weight: input.weight.toFixed(3) } : {}),
    // Nasce com estoque controlado e zerado: a quantidade vem só da sincronização.
    stock: 0,
  };
  const permit = await issueWritePermit(sql, conn.store, "CATALOG", `POST /products/${nsProductId}/variants`);
  const opId = await startOp(sql, { storeId, operation: "CREATE_VARIANT", nsProductId, request: body, actor });
  const res = await write(sql, opId, () => conn.client.send<{ id?: number }>(permit, "POST", `/products/${nsProductId}/variants`, body, { idempotent: false }));
  const remote = await refreshProducts(sql, conn.client, storeId, [nsProductId]);
  const created = [...remote.variants.values()].find((v) => !v.removed && !before.has(v.variantId) && (String(res.data?.id ?? "") === v.variantId || normalizeSku(v.sku) === normalizeSku(input.sku)));
  if (!created) {
    await endOp(sql, opId, "UNCERTAIN", { error: "Variante não apareceu na releitura" });
    throw new AutomationError("verify_failed", "Variante criada, mas não confirmada na releitura", 502);
  }
  let linked = false;
  if (input.productId) {
    await confirmMapping(sql, { storeId, variantId: created.variantId, productId: input.productId, actor, notes: "Variante criada pelo integrador" });
    linked = true;
  }
  await endOp(sql, opId, "SUCCEEDED", { variantId: created.variantId, verified: true, result: { sku: created.sku, price: created.price } });
  return { variantId: created.variantId, linked };
}

export const updateVariantSchema = z
  .object({
    price: priceSchema.optional(),
    sku: textSchema(80).optional(),
    barcode: z.string().trim().max(40).nullable().optional(),
    weight: z.number().positive().max(1000).nullable().optional(),
    width: z.number().positive().max(1000).nullable().optional(),
    height: z.number().positive().max(1000).nullable().optional(),
    depth: z.number().positive().max(1000).nullable().optional(),
    visible: z.boolean().optional(),
  })
  .strict();

export async function updateVariant(sql: Sql, nsProductId: string, variantId: string, patch: z.infer<typeof updateVariantSchema>, actor: string, deps: WorkerDeps = {}): Promise<{ verified: boolean }> {
  const conn = await connOf(sql, deps);
  const storeId = conn.store.storeId;
  const [v] = await sql.query<{ productId: string; status: string }>(`SELECT product_id::text AS "productId", sync_status AS status FROM nuvemshop_variants WHERE store_id = $1 AND variant_id = $2::bigint`, [storeId, variantId]);
  if (!v || v.productId !== nsProductId) throw new AutomationError("variant_not_found", "Variante não encontrada neste produto", 404);
  if (v.status !== "ACTIVE") throw new AutomationError("variant_removed", "Variante removida na Nuvemshop");
  if (patch.price !== undefined) {
    const price = await getAutomation(sql, "PRICE");
    const [sv] = await sql.query<{ participation: string }>(`SELECT participation FROM nuvemshop_sync_variants WHERE store_id = $1 AND variant_id = $2::bigint AND kind = 'PRICE'`, [storeId, variantId]);
    const participating = sv && sv.participation !== "NONE" && sv.participation !== "EXCLUDED";
    if (WRITE_MODES.includes(price.mode) && (participating || price.scope === "ALL_ELIGIBLE")) {
      throw new AutomationError("price_automated", "O preço desta variante é controlado pela automação de preço: exclua-a da automação antes de editar manualmente");
    }
  }
  const body: Record<string, unknown> = {};
  if (patch.price !== undefined) body.price = patch.price.toFixed(2);
  if (patch.sku !== undefined) body.sku = patch.sku;
  if (patch.barcode !== undefined) body.barcode = patch.barcode ?? "";
  for (const k of ["weight", "width", "height", "depth"] as const) if (patch[k] !== undefined) body[k] = patch[k] === null ? null : patch[k]!.toFixed(k === "weight" ? 3 : 2);
  if (patch.visible !== undefined) body.visible = patch.visible;
  if (!Object.keys(body).length) throw new AutomationError("empty_patch", "Nada a alterar", 422);
  const permit = await issueWritePermit(sql, conn.store, "CATALOG", `PUT /products/${nsProductId}/variants/${variantId}`);
  const opId = await startOp(sql, { storeId, operation: "UPDATE_VARIANT", nsProductId, variantId, request: body, actor });
  await write(sql, opId, () => conn.client.send(permit, "PUT", `/products/${nsProductId}/variants/${variantId}`, body, { idempotent: true }));
  const remote = await refreshProducts(sql, conn.client, storeId, [nsProductId]);
  const after = remote.variants.get(variantId);
  if (!after || after.removed) {
    // O ID da variante mudou/sumiu: os vínculos vão para revisão pelo motor de vinculação (refreshProducts).
    await endOp(sql, opId, "UNCERTAIN", { error: "A variante não existe mais com o mesmo ID após a edição: vínculo em revisão" });
    throw new AutomationError("variant_id_changed", "A variante mudou de ID na Nuvemshop: o vínculo foi enviado para revisão", 409);
  }
  const verified = (patch.price === undefined || Number(after.price) === Number(patch.price.toFixed(2))) && (patch.sku === undefined || after.sku === patch.sku);
  await endOp(sql, opId, "SUCCEEDED", { verified, result: { price: after.price, sku: after.sku } });
  return { verified };
}

export const addImageSchema = z.object({ src: httpsUrl, position: z.number().int().min(1).max(250).optional() }).strict();

async function imagesOf(sql: Sql, storeId: string, nsProductId: string) {
  return sql.query<{ imageId: string; src: string; position: number | null }>(`SELECT image_id::text AS "imageId", src, position FROM nuvemshop_product_images WHERE store_id = $1 AND product_id = $2::bigint ORDER BY position NULLS LAST, image_id`, [storeId, nsProductId]);
}

export async function addImage(sql: Sql, nsProductId: string, input: z.infer<typeof addImageSchema>, actor: string, deps: WorkerDeps = {}): Promise<{ imageId: string | null; verified: boolean }> {
  const conn = await connOf(sql, deps);
  const storeId = conn.store.storeId;
  await ensureLocalProduct(sql, storeId, nsProductId);
  const before = new Set((await imagesOf(sql, storeId, nsProductId)).map((i) => i.imageId));
  if (before.size >= 250) throw new AutomationError("too_many_images", "O produto já tem 250 imagens (limite da Nuvemshop)");
  const permit = await issueWritePermit(sql, conn.store, "CATALOG", `POST /products/${nsProductId}/images`);
  const opId = await startOp(sql, { storeId, operation: "ADD_IMAGE", nsProductId, request: input, actor });
  const res = await write(sql, opId, () => conn.client.send<{ id?: number }>(permit, "POST", `/products/${nsProductId}/images`, input, { idempotent: false }));
  await refreshProducts(sql, conn.client, storeId, [nsProductId]);
  const after = await imagesOf(sql, storeId, nsProductId);
  const added = after.find((i) => String(res.data?.id ?? "") === i.imageId) ?? after.find((i) => !before.has(i.imageId)) ?? null;
  await endOp(sql, opId, added ? "SUCCEEDED" : "UNCERTAIN", { imageId: added?.imageId ?? null, verified: !!added, error: added ? null : "Imagem não apareceu na releitura (processamento pode estar em andamento)" });
  return { imageId: added?.imageId ?? null, verified: !!added };
}

/** Imagem principal = posição 1 (documentação da Nuvemshop). */
export async function setMainImage(sql: Sql, nsProductId: string, imageId: string, actor: string, deps: WorkerDeps = {}): Promise<{ verified: boolean }> {
  const conn = await connOf(sql, deps);
  const storeId = conn.store.storeId;
  if (!(await imagesOf(sql, storeId, nsProductId)).some((i) => i.imageId === imageId)) throw new AutomationError("image_not_found", "Imagem não encontrada neste produto", 404);
  const permit = await issueWritePermit(sql, conn.store, "CATALOG", `PUT /products/${nsProductId}/images/${imageId}`);
  const opId = await startOp(sql, { storeId, operation: "SET_MAIN_IMAGE", nsProductId, imageId, request: { position: 1 }, actor });
  await write(sql, opId, () => conn.client.send(permit, "PUT", `/products/${nsProductId}/images/${imageId}`, { position: 1 }, { idempotent: true }));
  await refreshProducts(sql, conn.client, storeId, [nsProductId]);
  const after = await imagesOf(sql, storeId, nsProductId);
  const verified = after.find((i) => i.imageId === imageId)?.position === 1;
  await endOp(sql, opId, "SUCCEEDED", { verified, result: { positions: after.map((i) => [i.imageId, i.position]) } });
  return { verified };
}

/** Remove uma imagem. Exige `confirmImageId` igual ao ID removido (confirmação explícita). */
export async function removeImage(sql: Sql, nsProductId: string, imageId: string, confirmImageId: string | null, actor: string, deps: WorkerDeps = {}): Promise<{ verified: boolean }> {
  if (confirmImageId !== imageId) throw new AutomationError("confirmation_required", "Confirme a remoção informando o ID da imagem", 422);
  const conn = await connOf(sql, deps);
  const storeId = conn.store.storeId;
  const images = await imagesOf(sql, storeId, nsProductId);
  if (!images.some((i) => i.imageId === imageId)) throw new AutomationError("image_not_found", "Imagem não encontrada neste produto", 404);
  const permit = await issueWritePermit(sql, conn.store, "CATALOG", `DELETE /products/${nsProductId}/images/${imageId}`);
  const opId = await startOp(sql, { storeId, operation: "REMOVE_IMAGE", nsProductId, imageId, request: { imageId }, actor });
  await write(sql, opId, () => conn.client.send(permit, "DELETE", `/products/${nsProductId}/images/${imageId}`, undefined, { idempotent: true }));
  await refreshProducts(sql, conn.client, storeId, [nsProductId]);
  const verified = !(await imagesOf(sql, storeId, nsProductId)).some((i) => i.imageId === imageId);
  await endOp(sql, opId, "SUCCEEDED", { verified });
  return { verified };
}

/** Dados do editor: produto local, variantes com vínculo, imagens e operações recentes. */
export async function productEditorView(sql: Sql, storeId: string, nsProductId: string) {
  const [product] = await sql.query(
    `SELECT product_id::text AS "productId", name, description, brand, visibility, published, category_ids::text[] AS "categoryIds", tags, canonical_url AS "canonicalUrl",
            sync_status AS "syncStatus", fetched_at AS "fetchedAt", remote_updated_at AS "remoteUpdatedAt" FROM nuvemshop_products WHERE store_id = $1 AND product_id = $2::bigint`,
    [storeId, nsProductId],
  );
  if (!product) return null;
  const variants = await sql.query(
    `SELECT v.variant_id::text AS "variantId", v.sku, v.barcode, trim_scale(v.price)::text AS price, trim_scale(v.promotional_price)::text AS "promotionalPrice", v.stock_management AS "stockManagement",
            v.stock, v.visible, v.option_values AS values, trim_scale(v.weight)::text AS weight, v.sync_status AS "syncStatus",
            m.product_id AS "linkedProductId", m.status AS "mappingStatus", ap.ads_product_id AS "adsProductId", COALESCE(ap.name_custom, ap.name_original) AS "adsName"
     FROM nuvemshop_variants v
     LEFT JOIN nuvemshop_variant_mappings m ON m.store_id = v.store_id AND m.variant_id = v.variant_id AND m.status IN ('CONFIRMED', 'NEEDS_REVIEW')
     LEFT JOIN products ap ON ap.id = m.product_id
     WHERE v.store_id = $1 AND v.product_id = $2::bigint ORDER BY v.sync_status, v.position NULLS LAST, v.variant_id`,
    [storeId, nsProductId],
  );
  const images = await imagesOf(sql, storeId, nsProductId);
  const categories = await sql.query(`SELECT category_id::text AS id, name FROM nuvemshop_categories WHERE store_id = $1 ORDER BY name`, [storeId]);
  const operations = await sql.query(
    `SELECT id::text AS id, operation, status, verified, error_message AS "errorMessage", actor, variant_id::text AS "variantId", image_id::text AS "imageId", created_at AS "createdAt"
     FROM nuvemshop_product_operations WHERE store_id = $1 AND nuvemshop_product_id = $2::bigint ORDER BY created_at DESC LIMIT 30`,
    [storeId, nsProductId],
  );
  return { product, variants, images, categories, operations };
}

/** Operações com resultado incerto (ex.: criação que expirou) — exibidas para reconciliação manual. */
export async function uncertainOperations(sql: Sql, storeId: string) {
  return sql.query(
    `SELECT o.id::text AS id, o.operation, o.status, o.product_id AS "productId", o.nuvemshop_product_id::text AS "nsProductId", o.error_message AS "errorMessage", o.actor, o.created_at AS "createdAt"
     FROM nuvemshop_product_operations o WHERE o.store_id = $1 AND (o.status = 'UNCERTAIN' OR (o.status = 'PENDING' AND o.created_at < now() - interval '5 minutes')) ORDER BY o.created_at DESC LIMIT 50`,
    [storeId],
  );
}

/** Reconciliação manual de uma criação incerta: procura o SKU na loja; achou → vincula; não achou → libera nova tentativa. */
export async function reconcileUncertainCreate(sql: Sql, opId: string, actor: string, deps: WorkerDeps = {}): Promise<{ found: boolean; nsProductId: string | null }> {
  const [op] = await sql.query<{ id: string; productId: number | null; request: { sku?: string } | null; status: string; operation: string }>(
    `SELECT id::text AS id, product_id AS "productId", request, status, operation FROM nuvemshop_product_operations WHERE id = $1::uuid`,
    [opId],
  );
  if (!op || op.operation !== "CREATE_PRODUCT" || (op.status !== "UNCERTAIN" && op.status !== "PENDING") || !op.request?.sku || !op.productId) throw new AutomationError("not_reconcilable", "Operação não reconciliável", 404);
  const conn = await connOf(sql, deps);
  const found = await findRemoteBySku(conn.client, op.request.sku);
  if (!found) {
    await endOp(sql, op.id, "FAILED", { error: `Reconciliado por ${actor}: produto não existe na loja (nova criação liberada)` });
    return { found: false, nsProductId: null };
  }
  const nsProductId = String(found.id);
  const remote = await refreshProducts(sql, conn.client, conn.store.storeId, [nsProductId]);
  const variant = [...remote.variants.values()].find((v) => !v.removed && normalizeSku(v.sku) === normalizeSku(op.request!.sku));
  if (variant) await confirmMapping(sql, { storeId: conn.store.storeId, variantId: variant.variantId, productId: op.productId, actor, notes: "Criação incerta reconciliada pelo SKU" });
  await endOp(sql, op.id, "RESOLVED", { nsProductId, variantId: variant?.variantId ?? null, verified: !!variant });
  return { found: true, nsProductId };
}
