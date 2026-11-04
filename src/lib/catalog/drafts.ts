import "server-only";
import type { Sql } from "../sql";
import { findActivePrice } from "./products";
import { getCatalogSettings } from "./settings";

/**
 * Rascunhos de anúncio. Preparação manual apenas — nada aqui chama a API do Mercado Livre.
 *
 * - O título nasce do nome do produto; preço e quantidade de anúncio ficam vazios até o operador
 *   confirmar (nenhum desconto/margem é aplicado automaticamente).
 * - reference_price é um snapshot do preço ATIVO da tabela/filial escolhidas, recalculado a cada gravação.
 * - Produtos inativos não recebem rascunho automaticamente.
 */
export type DraftStatus = "DRAFT" | "READY" | "ARCHIVED";

/** Limite de título do Mercado Livre (MLB). */
export const ML_TITLE_MAX = 60;
export const MAX_ATTRIBUTES = 100;

export interface ListingDraft {
  id: number;
  productId: number;
  adsProductId: number;
  productName: string;
  productInactive: boolean;
  title: string | null;
  description: string | null;
  selectedPriceTable: string | null;
  selectedBranchId: string | null;
  referencePrice: string | null;
  listingPrice: string | null;
  listingQuantity: number | null;
  marketplaceCategoryId: string | null;
  marketplaceAttributes: unknown;
  status: DraftStatus;
  imageCount: number;
  stockTotal: string | null;
  stockBranches: number;
  createdAt: Date;
  updatedAt: Date;
}

const DRAFT_SELECT = `
  SELECT d.id, d.product_id AS "productId", p.ads_product_id AS "adsProductId",
         COALESCE(p.name_custom, p.name_original) AS "productName", p.inactive AS "productInactive",
         d.title, d.description, d.selected_price_table AS "selectedPriceTable", d.selected_branch_id AS "selectedBranchId",
         d.reference_price::text AS "referencePrice", d.listing_price::text AS "listingPrice",
         d.listing_quantity AS "listingQuantity", d.marketplace_category_id AS "marketplaceCategoryId",
         d.marketplace_attributes AS "marketplaceAttributes", d.status,
         (SELECT count(*)::int FROM product_images i WHERE i.product_id = d.product_id) AS "imageCount",
         (SELECT sum(quantity)::text FROM product_stocks st WHERE st.product_id = d.product_id) AS "stockTotal",
         (SELECT count(*)::int FROM product_stocks st WHERE st.product_id = d.product_id) AS "stockBranches",
         d.created_at AS "createdAt", d.updated_at AS "updatedAt"
  FROM listing_drafts d JOIN products p ON p.id = d.product_id`;

export async function getDraft(sql: Sql, id: number): Promise<ListingDraft | null> {
  const rows = await sql.query<ListingDraft>(`${DRAFT_SELECT} WHERE d.id = $1::int`, [id]);
  return rows[0] ?? null;
}

export async function getDraftByProduct(sql: Sql, productId: number): Promise<ListingDraft | null> {
  const rows = await sql.query<ListingDraft>(`${DRAFT_SELECT} WHERE d.product_id = $1::int`, [productId]);
  return rows[0] ?? null;
}

export async function listDrafts(sql: Sql, opts: { status?: DraftStatus; page?: number; pageSize?: number } = {}) {
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 100);
  const page = Math.max(opts.page ?? 1, 1);
  const params: unknown[] = [];
  let clause = "";
  if (opts.status) {
    params.push(opts.status);
    clause = `WHERE d.status = $1::text`;
  }
  const [{ total }] = await sql.query<{ total: number }>(`SELECT count(*)::int AS total FROM listing_drafts d ${clause}`, params);
  params.push(pageSize, (page - 1) * pageSize);
  const items = await sql.query<ListingDraft>(
    `${DRAFT_SELECT} ${clause} ORDER BY d.updated_at DESC, d.id LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { items, total, page, pageSize };
}

export interface CreateDraftsResult {
  created: { productId: number; draftId: number }[];
  skipped: { productId: number; reason: "not_found" | "inactive" | "already_exists"; draftId?: number }[];
}

export async function createDrafts(sql: Sql, productIds: number[]): Promise<CreateDraftsResult> {
  const settings = await getCatalogSettings(sql);
  const result: CreateDraftsResult = { created: [], skipped: [] };

  for (const productId of [...new Set(productIds)]) {
    await sql.transaction(async (tx) => {
      const [product] = await tx.query<{ id: number; inactive: boolean; name: string }>(
        `SELECT id, inactive, COALESCE(name_custom, name_original) AS name FROM products WHERE id = $1::int`,
        [productId],
      );
      if (!product) return void result.skipped.push({ productId, reason: "not_found" });
      if (product.inactive) return void result.skipped.push({ productId, reason: "inactive" });

      const ref = await findActivePrice(tx, productId, settings.defaultPriceTable, settings.defaultBranchId);
      const inserted = await tx.query<{ id: number }>(
        `INSERT INTO listing_drafts (product_id, title, selected_price_table, selected_branch_id, reference_price, status, updated_at)
         VALUES ($1::int, $2::text, $3::text, $4::text, $5::numeric, 'DRAFT', now())
         ON CONFLICT (product_id) DO NOTHING RETURNING id`,
        [productId, product.name ? product.name.slice(0, 120) : null, settings.defaultPriceTable, ref?.branchId ?? settings.defaultBranchId, ref?.price ?? null],
      );
      if (inserted[0]) {
        result.created.push({ productId, draftId: inserted[0].id });
      } else {
        const [existing] = await tx.query<{ id: number }>(`SELECT id FROM listing_drafts WHERE product_id = $1::int`, [productId]);
        result.skipped.push({ productId, reason: "already_exists", draftId: existing?.id });
      }
    });
  }
  return result;
}

export interface DraftPatch {
  title?: string | null;
  description?: string | null;
  selectedPriceTable?: string | null;
  selectedBranchId?: string | null;
  /** String decimal com até 2 casas, ex.: "89.90". */
  listingPrice?: string | null;
  listingQuantity?: number | null;
  marketplaceCategoryId?: string | null;
  marketplaceAttributes?: unknown[];
  status?: DraftStatus;
}

export interface Readiness {
  blocking: { code: string; message: string }[];
  warnings: { code: string; message: string }[];
}

/** Requisitos mínimos para marcar o rascunho como pronto para a futura publicação. */
export function checkReadiness(d: ListingDraft): Readiness {
  const blocking: Readiness["blocking"] = [];
  const warnings: Readiness["warnings"] = [];
  const title = d.title?.trim() ?? "";
  if (!title) blocking.push({ code: "TITLE_MISSING", message: "Informe o título do anúncio." });
  else if (title.length > ML_TITLE_MAX) blocking.push({ code: "TITLE_TOO_LONG", message: `O título tem ${title.length} caracteres; o limite do Mercado Livre é ${ML_TITLE_MAX}.` });
  if (!d.listingPrice) blocking.push({ code: "PRICE_MISSING", message: "Defina o preço de publicação." });
  if (d.listingQuantity === null || d.listingQuantity < 1) blocking.push({ code: "QUANTITY_MISSING", message: "Defina a quantidade para publicação (mínimo 1)." });
  if (d.imageCount < 1) blocking.push({ code: "NO_IMAGES", message: "Adicione ao menos uma imagem." });
  if (d.productInactive) blocking.push({ code: "PRODUCT_INACTIVE", message: "O produto está inativo na ADS." });

  if (!d.marketplaceCategoryId) warnings.push({ code: "CATEGORY_MISSING", message: "Categoria do Mercado Livre ainda não definida (necessária na fase de publicação)." });
  if (d.stockBranches === 0) warnings.push({ code: "STOCK_UNKNOWN", message: "Estoque desconhecido: atualize o estoque antes de publicar." });
  else if (d.listingQuantity !== null && d.stockTotal !== null && d.listingQuantity > Number(d.stockTotal)) {
    warnings.push({ code: "QUANTITY_ABOVE_STOCK", message: `Quantidade (${d.listingQuantity}) maior que o estoque consultado (${d.stockTotal}).` });
  }
  if (!d.referencePrice) warnings.push({ code: "REFERENCE_PRICE_MISSING", message: "Sem preço ativo na tabela de referência selecionada." });
  return { blocking, warnings };
}

export class DraftNotReadyError extends Error {
  constructor(readonly readiness: Readiness) {
    super("Rascunho não atende aos requisitos para ficar pronto");
  }
}

export async function updateDraft(sql: Sql, id: number, patch: DraftPatch): Promise<ListingDraft | null> {
  return sql.transaction(async (tx) => {
    const current = await getDraft(tx, id);
    if (!current) return null;

    const table = patch.selectedPriceTable !== undefined ? patch.selectedPriceTable : current.selectedPriceTable;
    const branch = patch.selectedBranchId !== undefined ? patch.selectedBranchId : current.selectedBranchId;
    const ref = await findActivePrice(tx, current.productId, table, branch);

    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (column: string, value: unknown, cast: string) => {
      params.push(value);
      sets.push(`${column} = $${params.length}::${cast}`);
    };
    if (patch.title !== undefined) set("title", patch.title?.trim() || null, "text");
    if (patch.description !== undefined) set("description", patch.description?.trim() || null, "text");
    if (patch.selectedPriceTable !== undefined) set("selected_price_table", patch.selectedPriceTable, "text");
    if (patch.selectedBranchId !== undefined) set("selected_branch_id", patch.selectedBranchId, "text");
    if (patch.listingPrice !== undefined) set("listing_price", patch.listingPrice, "numeric");
    if (patch.listingQuantity !== undefined) set("listing_quantity", patch.listingQuantity, "int");
    if (patch.marketplaceCategoryId !== undefined) set("marketplace_category_id", patch.marketplaceCategoryId?.trim() || null, "text");
    if (patch.marketplaceAttributes !== undefined) set("marketplace_attributes", JSON.stringify(patch.marketplaceAttributes), "jsonb");
    if (patch.status !== undefined) set("status", patch.status, "text");
    set("reference_price", ref?.price ?? null, "numeric");
    sets.push("updated_at = now()");

    await tx.execute(`UPDATE listing_drafts SET ${sets.join(", ")} WHERE id = $1::int`, params);
    const updated = (await getDraft(tx, id))!;

    if (updated.status === "READY") {
      const readiness = checkReadiness(updated);
      if (readiness.blocking.length) throw new DraftNotReadyError(readiness); // desfaz a transação
    }
    return updated;
  });
}
