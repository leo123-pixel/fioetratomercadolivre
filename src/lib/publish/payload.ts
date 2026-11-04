import "server-only";
import { createHash } from "node:crypto";
import { getDraft, type DraftAttributeValue, type ListingDraft } from "../catalog/drafts";
import { listImages, type ProductImage } from "../catalog/images";
import type { PublicationModel } from "../meli/capabilities";
import type { Sql } from "../sql";

/**
 * Montagem do payload de POST /items conforme o modelo de publicação da conta:
 *
 * - USER_PRODUCTS (tag user_product_seller): envia `family_name`, NÃO envia `title` nem `variations`
 *   (documentação "Preço por variação"/User Products, consultada em 11/2026).
 * - CLASSIC: envia `title`.
 *
 * A descrição é enviada depois, em POST /items/{id}/description (documentação "Publicar produtos").
 * SELLER_SKU = "ADS-<produtoId>" é sempre incluído: referência interna e chave de conciliação.
 */
export const CURRENCY = "BRL";

export function sellerSku(adsProductId: number): string {
  return `ADS-${adsProductId}`;
}

export interface PublishContext {
  draft: ListingDraft;
  images: ProductImage[];
  model: PublicationModel;
}

export async function loadContext(sql: Sql, draftId: number, model: PublicationModel): Promise<PublishContext | null> {
  const draft = await getDraft(sql, draftId);
  if (!draft) return null;
  const images = await listImages(sql, draft.productId);
  return { draft, images, model };
}

function cleanAttributes(attrs: DraftAttributeValue[], adsProductId: number): DraftAttributeValue[] {
  const out: DraftAttributeValue[] = [];
  for (const a of attrs) {
    if (!a?.id || a.id === "SELLER_SKU") continue;
    if (a.values?.length) {
      const values = a.values.filter((v) => v.id || v.name?.trim()).map((v) => (v.id ? { id: v.id } : { name: v.name!.trim() }));
      if (values.length) out.push({ id: a.id, values });
      continue;
    }
    if (a.value_id) out.push({ id: a.id, value_id: a.value_id });
    else if (a.value_name?.trim()) out.push({ id: a.id, value_name: a.value_name.trim() });
  }
  out.push({ id: "SELLER_SKU", value_name: sellerSku(adsProductId) });
  return out;
}

export interface BuildOptions {
  /** "source": URLs públicas (validação); "ids": IDs de /pictures/items/upload quando disponíveis (publicação). */
  pictures: "source" | "ids";
}

export function buildItemPayload(ctx: PublishContext, opts: BuildOptions): Record<string, unknown> {
  const d = ctx.draft;
  const payload: Record<string, unknown> = {
    category_id: d.marketplaceCategoryId,
    price: d.listingPrice === null ? null : Number(d.listingPrice),
    currency_id: CURRENCY,
    available_quantity: d.listingQuantity,
    buying_mode: "buy_it_now",
    listing_type_id: d.listingTypeId,
    condition: d.itemCondition ?? "new",
    pictures: ctx.images.map((img) => (opts.pictures === "ids" && img.mlPictureId ? { id: img.mlPictureId } : { source: img.publicUrl })),
    attributes: cleanAttributes(d.marketplaceAttributes ?? [], d.adsProductId),
  };
  if (ctx.model === "USER_PRODUCTS") payload.family_name = d.familyName?.trim() || null;
  else payload.title = d.title?.trim() || null;

  const saleTerms = (d.saleTerms ?? []).filter((t) => t?.id && (t.value_id || t.value_name?.trim()));
  if (saleTerms.length) payload.sale_terms = saleTerms.map((t) => (t.value_id ? { id: t.id, value_id: t.value_id } : { id: t.id, value_name: t.value_name!.trim() }));
  if (d.catalogListing && d.catalogProductId) {
    payload.catalog_product_id = d.catalogProductId;
    payload.catalog_listing = true;
  }
  return payload;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, stable((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/**
 * Impressão digital do conteúdo que será publicado (payload + descrição + imagens locais).
 * A confirmação do administrador e o job ficam amarrados a ela: qualquer mudança exige nova validação.
 */
export function fingerprint(ctx: PublishContext): string {
  const content = {
    model: ctx.model,
    payload: buildItemPayload(ctx, { pictures: "source" }),
    description: ctx.draft.description?.trim() ?? "",
    images: ctx.images.map((i) => [i.id, i.storagePath]),
  };
  return createHash("sha256").update(JSON.stringify(stable(content))).digest("hex");
}

/** Versão resumida para revisão/confirmação e auditoria (sem dados sensíveis). */
export function reviewSummary(ctx: PublishContext, account: { meliUserId: string | null; nickname: string | null }) {
  const p = buildItemPayload(ctx, { pictures: "source" });
  return {
    draftId: ctx.draft.id,
    draftVersion: ctx.draft.version,
    product: { id: ctx.draft.productId, adsProductId: ctx.draft.adsProductId, name: ctx.draft.productName },
    model: ctx.model,
    titleField: ctx.model === "USER_PRODUCTS" ? "family_name" : "title",
    title: (p.family_name ?? p.title) as string | null,
    categoryId: ctx.draft.marketplaceCategoryId,
    categoryName: ctx.draft.categoryName,
    price: ctx.draft.listingPrice,
    currency: CURRENCY,
    quantity: ctx.draft.listingQuantity,
    listingTypeId: ctx.draft.listingTypeId,
    condition: ctx.draft.itemCondition,
    catalogProductId: ctx.draft.catalogListing ? ctx.draft.catalogProductId : null,
    sellerSku: sellerSku(ctx.draft.adsProductId),
    images: ctx.images.map((i) => ({ id: i.id, url: i.publicUrl, primary: i.isPrimary })),
    attributes: p.attributes,
    account,
    payload: p,
  };
}
