import "server-only";
import { recordEvent } from "../publish/events";
import type { Sql } from "../sql";
import { findActivePrice } from "./products";
import { getCatalogSettings } from "./settings";

/**
 * Rascunhos de anúncio. Salvar um rascunho NUNCA publica: a publicação é um comando separado,
 * confirmado pelo administrador e amarrado a uma versão validada (src/lib/publish).
 *
 * - Preço e quantidade de anúncio começam vazios (o operador define; nada é aplicado automaticamente).
 * - reference_price é um snapshot do preço ATIVO da tabela/filial escolhidas.
 * - Cada alteração incrementa `version` e invalida a validação anterior.
 */
export const DRAFT_STATUSES = ["DRAFT", "INCOMPLETE", "READY", "VALIDATING", "VALIDATED", "PUBLISHING", "PUBLISHED", "FAILED", "UNKNOWN", "ARCHIVED"] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];
/** Estados em que o conteúdo não pode mudar (publicação em curso, concluída ou incerta). */
export const LOCKED_STATUSES: DraftStatus[] = ["VALIDATING", "PUBLISHING", "PUBLISHED", "UNKNOWN"];

/** Limite padrão de título (MLB); a categoria pode definir outro em settings.max_title_length. */
export const ML_TITLE_MAX = 60;
export const MAX_ATTRIBUTES = 150;

export interface DraftAttributeValue {
  id: string;
  value_id?: string | null;
  value_name?: string | null;
  values?: { id?: string | null; name?: string | null }[];
}

export interface ListingDraft {
  id: number;
  productId: number;
  adsProductId: number;
  productName: string;
  productInactive: boolean;
  title: string | null;
  familyName: string | null;
  description: string | null;
  selectedPriceTable: string | null;
  selectedBranchId: string | null;
  referencePrice: string | null;
  listingPrice: string | null;
  listingQuantity: number | null;
  marketplaceCategoryId: string | null;
  categoryName: string | null;
  marketplaceAttributes: DraftAttributeValue[];
  listingTypeId: string | null;
  itemCondition: string | null;
  saleTerms: DraftAttributeValue[];
  catalogProductId: string | null;
  catalogListing: boolean;
  status: DraftStatus;
  version: number;
  validatedVersion: number | null;
  validatedFingerprint: string | null;
  validatedAt: Date | null;
  validationResult: unknown;
  lastError: string | null;
  imageCount: number;
  stockTotal: string | null;
  stockBranches: number;
  marketplaceItemId: string | null;
  permalink: string | null;
  listingStatus: string | null;
  /** Dados lidos no Mercado Livre (fotografia remota; ver reconciliação). */
  listingRemoteStatus: string | null;
  listingRemoteSubStatus: string[] | null;
  listingRemotePrice: string | null;
  listingRemoteQuantity: number | null;
  /** Preço/quantidade enviados na publicação. */
  listingPublishedPrice: string | null;
  listingPublishedQuantity: number | null;
  listingLastSyncedAt: Date | null;
  listingSyncError: string | null;
  listingIssues: string[];
  primaryImageUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export /** Anúncio mais relevante do rascunho: o vigente; senão, o mais recente (encerrado/excluído). */
const LISTING_JOIN = `LEFT JOIN LATERAL (
    SELECT * FROM marketplace_listings x WHERE x.listing_draft_id = d.id
    ORDER BY (x.status NOT IN ('closed', 'deleted')) DESC, x.id DESC LIMIT 1
  ) ml ON true`;

const DRAFT_SELECT = `
  SELECT d.id, d.product_id AS "productId", p.ads_product_id AS "adsProductId",
         COALESCE(p.name_custom, p.name_original) AS "productName", p.inactive AS "productInactive",
         d.title, d.family_name AS "familyName", d.description, d.selected_price_table AS "selectedPriceTable",
         d.selected_branch_id AS "selectedBranchId", d.reference_price::text AS "referencePrice",
         d.listing_price::text AS "listingPrice", d.listing_quantity AS "listingQuantity",
         d.marketplace_category_id AS "marketplaceCategoryId", d.category_name AS "categoryName",
         d.marketplace_attributes AS "marketplaceAttributes", d.listing_type_id AS "listingTypeId",
         d.item_condition AS "itemCondition", d.sale_terms AS "saleTerms", d.catalog_product_id AS "catalogProductId",
         d.catalog_listing AS "catalogListing", d.status, d.version, d.validated_version AS "validatedVersion",
         d.validated_fingerprint AS "validatedFingerprint", d.validated_at AS "validatedAt",
         d.validation_result AS "validationResult", d.last_error AS "lastError",
         (SELECT count(*)::int FROM product_images i WHERE i.product_id = d.product_id) AS "imageCount",
         (SELECT sum(quantity)::text FROM product_stocks st WHERE st.product_id = d.product_id) AS "stockTotal",
         (SELECT count(*)::int FROM product_stocks st WHERE st.product_id = d.product_id) AS "stockBranches",
         ml.marketplace_item_id AS "marketplaceItemId", ml.permalink, ml.status AS "listingStatus",
         ml.remote_status AS "listingRemoteStatus", ml.remote_sub_status AS "listingRemoteSubStatus",
         ml.remote_price::text AS "listingRemotePrice", ml.remote_quantity AS "listingRemoteQuantity",
         ml.price::text AS "listingPublishedPrice", ml.quantity AS "listingPublishedQuantity",
         ml.last_synced_at AS "listingLastSyncedAt", ml.sync_error_message AS "listingSyncError",
         COALESCE((SELECT array_agg(r.issue_type ORDER BY r.issue_type) FROM marketplace_reconciliation_issues r
                   WHERE r.listing_id = ml.id AND r.resolved_at IS NULL), '{}') AS "listingIssues",
         (SELECT public_url FROM product_images i WHERE i.product_id = d.product_id ORDER BY i.is_primary DESC, i.position LIMIT 1) AS "primaryImageUrl",
         d.created_at AS "createdAt", d.updated_at AS "updatedAt"
  FROM listing_drafts d
  JOIN products p ON p.id = d.product_id
  ${LISTING_JOIN}`;

export async function getDraft(sql: Sql, id: number): Promise<ListingDraft | null> {
  const rows = await sql.query<ListingDraft>(`${DRAFT_SELECT} WHERE d.id = $1::int`, [id]);
  return rows[0] ?? null;
}

export async function getDraftByProduct(sql: Sql, productId: number): Promise<ListingDraft | null> {
  const rows = await sql.query<ListingDraft>(`${DRAFT_SELECT} WHERE d.product_id = $1::int`, [productId]);
  return rows[0] ?? null;
}

/** Filtros do painel de anúncios (abas). */
export const DRAFT_TABS: Record<string, DraftStatus[]> = {
  rascunhos: ["DRAFT"],
  incompletos: ["INCOMPLETE"],
  prontos: ["READY", "VALIDATED"],
  publicando: ["VALIDATING", "PUBLISHING"],
  publicados: ["PUBLISHED"],
  ativos: ["PUBLISHED"],
  pausados: ["PUBLISHED"],
  encerrados: ["PUBLISHED"],
  excluidos: ["PUBLISHED"],
  divergencia: ["PUBLISHED"],
  "erro-sync": ["PUBLISHED"],
  erros: ["FAILED"],
  desconhecidos: ["UNKNOWN"],
  arquivados: ["ARCHIVED"],
};

/** Abas que separam o anúncio vigente dos encerrados/excluídos no Mercado Livre. */
export type ListingFilter = "current" | "ended" | "active" | "paused" | "closed" | "deleted" | "divergent" | "sync_error";
export const TAB_LISTING: Record<string, ListingFilter> = {
  publicados: "current",
  ativos: "active",
  pausados: "paused",
  encerrados: "closed",
  excluidos: "deleted",
  divergencia: "divergent",
  "erro-sync": "sync_error",
};

/** Divergências que exigem atenção num anúncio vigente (encerrado/excluído têm abas próprias). */
const DIVERGENT_SQL = `EXISTS (SELECT 1 FROM marketplace_reconciliation_issues r WHERE r.listing_id = ml.id AND r.resolved_at IS NULL
  AND r.issue_type IN ('STATUS_DIVERGENCE', 'PRICE_DIVERGENCE', 'QUANTITY_DIVERGENCE', 'INCOMPLETE_LINK'))`;

const LISTING_FILTER_SQL: Record<ListingFilter, string> = {
  current: `(ml.status IS NULL OR ml.status NOT IN ('closed', 'deleted'))`,
  ended: `ml.status IN ('closed', 'deleted')`,
  active: `ml.status = 'active'`,
  paused: `ml.status = 'paused'`,
  closed: `ml.status = 'closed'`,
  // "Excluídos ou indisponíveis": excluído no ML (sub_status deleted ou 404) e situações sem venda possível.
  deleted: `ml.status IN ('deleted', 'inactive', 'under_review', 'payment_required')`,
  divergent: DIVERGENT_SQL,
  sync_error: `ml.sync_error_at IS NOT NULL`,
};


export async function listDrafts(
  sql: Sql,
  opts: { status?: DraftStatus; statuses?: DraftStatus[]; listing?: ListingFilter; q?: string; page?: number; pageSize?: number } = {},
) {
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 100);
  const page = Math.max(opts.page ?? 1, 1);
  const params: unknown[] = [];
  const where: string[] = [];
  const statuses = opts.statuses ?? (opts.status ? [opts.status] : null);
  if (statuses?.length) {
    params.push(statuses);
    where.push(`d.status = ANY($${params.length}::text[])`);
  }
  if (opts.listing) where.push(LISTING_FILTER_SQL[opts.listing]);
  if (opts.q?.trim()) {
    params.push(`%${opts.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    where.push(`(COALESCE(p.name_custom, p.name_original) ILIKE $${params.length} OR d.title ILIKE $${params.length} OR p.ads_product_id::text = trim(both '%' from $${params.length}))`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [{ total }] = await sql.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM listing_drafts d JOIN products p ON p.id = d.product_id ${LISTING_JOIN} ${clause}`,
    params,
  );
  params.push(pageSize, (page - 1) * pageSize);
  const items = await sql.query<ListingDraft>(
    `${DRAFT_SELECT} ${clause} ORDER BY d.updated_at DESC, d.id LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const counts = await sql.query<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM listing_drafts GROUP BY status`);
  const filters = Object.keys(LISTING_FILTER_SQL) as ListingFilter[];
  const [listingRow] = await sql.query<Record<ListingFilter, number>>(
    `SELECT ${filters.map((f) => `count(*) FILTER (WHERE ${LISTING_FILTER_SQL[f]})::int AS "${f}"`).join(", ")}
     FROM listing_drafts d ${LISTING_JOIN} WHERE d.status = 'PUBLISHED'`,
  );
  return {
    items,
    total,
    page,
    pageSize,
    endedPublished: listingRow?.ended ?? 0,
    listingCounts: listingRow ?? ({} as Record<ListingFilter, number>),
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) as Record<string, number>,
  };
}

export interface CreateDraftsResult {
  created: { productId: number; draftId: number }[];
  skipped: { productId: number; reason: "not_found" | "inactive" | "already_exists" | "already_published"; draftId?: number }[];
}

export async function createDrafts(sql: Sql, productIds: number[]): Promise<CreateDraftsResult> {
  const settings = await getCatalogSettings(sql);
  const result: CreateDraftsResult = { created: [], skipped: [] };

  for (const productId of [...new Set(productIds)]) {
    await sql.transaction(async (tx) => {
      const [product] = await tx.query<{ id: number; inactive: boolean; name: string; published: boolean }>(
        `SELECT p.id, p.inactive, COALESCE(p.name_custom, p.name_original) AS name,
                EXISTS (SELECT 1 FROM marketplace_listings ml WHERE ml.product_id = p.id AND ml.status NOT IN ('closed', 'deleted')) AS published
         FROM products p WHERE p.id = $1::int`,
        [productId],
      );
      if (!product) return void result.skipped.push({ productId, reason: "not_found" });
      if (product.inactive) return void result.skipped.push({ productId, reason: "inactive" });

      const ref = await findActivePrice(tx, productId, settings.defaultPriceTable, settings.defaultBranchId);
      const name = product.name ? product.name.slice(0, 120) : null;
      const inserted = await tx.query<{ id: number }>(
        `INSERT INTO listing_drafts (product_id, title, family_name, selected_price_table, selected_branch_id, reference_price, status, updated_at)
         VALUES ($1::int, $2::text, $2::text, $3::text, $4::text, $5::numeric, 'DRAFT', now())
         ON CONFLICT (product_id) DO NOTHING RETURNING id`,
        [productId, name, settings.defaultPriceTable, ref?.branchId ?? settings.defaultBranchId, ref?.price ?? null],
      );
      if (inserted[0]) {
        result.created.push({ productId, draftId: inserted[0].id });
        await recordEvent(tx, { draftId: inserted[0].id, type: "draft_created", to: "DRAFT" });
      } else {
        const [existing] = await tx.query<{ id: number }>(`SELECT id FROM listing_drafts WHERE product_id = $1::int`, [productId]);
        result.skipped.push({ productId, reason: product.published ? "already_published" : "already_exists", draftId: existing?.id });
      }
    });
  }
  return result;
}

export interface DraftPatch {
  title?: string | null;
  familyName?: string | null;
  description?: string | null;
  selectedPriceTable?: string | null;
  selectedBranchId?: string | null;
  /** String decimal com até 2 casas, ex.: "89.90". */
  listingPrice?: string | null;
  listingQuantity?: number | null;
  marketplaceCategoryId?: string | null;
  categoryName?: string | null;
  marketplaceAttributes?: DraftAttributeValue[];
  listingTypeId?: string | null;
  itemCondition?: string | null;
  saleTerms?: DraftAttributeValue[];
  catalogProductId?: string | null;
  catalogListing?: boolean;
  /** Somente DRAFT, READY ou ARCHIVED podem ser definidos manualmente. */
  status?: "DRAFT" | "READY" | "ARCHIVED";
}

export interface Readiness {
  blocking: { code: string; message: string }[];
  warnings: { code: string; message: string }[];
}

/** Requisitos internos mínimos (fase 2). A validação completa da fase 3 está em src/lib/publish/validate.ts. */
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

  if (!d.marketplaceCategoryId) warnings.push({ code: "CATEGORY_MISSING", message: "Categoria do Mercado Livre ainda não definida." });
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

export class DraftLockedError extends Error {
  constructor(readonly status: DraftStatus) {
    super(
      status === "PUBLISHED"
        ? "Rascunho já publicado: alterações no anúncio publicado não são feitas por aqui."
        : `Rascunho bloqueado durante a operação em andamento (${status}).`,
    );
  }
}

const CONTENT_FIELDS: [keyof DraftPatch, string, string][] = [
  ["title", "title", "text"],
  ["familyName", "family_name", "text"],
  ["description", "description", "text"],
  ["selectedPriceTable", "selected_price_table", "text"],
  ["selectedBranchId", "selected_branch_id", "text"],
  ["listingPrice", "listing_price", "numeric"],
  ["listingQuantity", "listing_quantity", "int"],
  ["marketplaceCategoryId", "marketplace_category_id", "text"],
  ["categoryName", "category_name", "text"],
  ["marketplaceAttributes", "marketplace_attributes", "jsonb"],
  ["listingTypeId", "listing_type_id", "text"],
  ["itemCondition", "item_condition", "text"],
  ["saleTerms", "sale_terms", "jsonb"],
  ["catalogProductId", "catalog_product_id", "text"],
  ["catalogListing", "catalog_listing", "boolean"],
];

export async function updateDraft(sql: Sql, id: number, patch: DraftPatch): Promise<ListingDraft | null> {
  return sql.transaction(async (tx) => {
    // FOR UPDATE: serializa com o comando de publicação, que também trava o rascunho.
    const [locked] = await tx.query<{ status: DraftStatus }>(`SELECT status FROM listing_drafts WHERE id = $1::int FOR UPDATE`, [id]);
    if (!locked) return null;
    if (LOCKED_STATUSES.includes(locked.status)) throw new DraftLockedError(locked.status);
    const current = (await getDraft(tx, id))!;

    const table = patch.selectedPriceTable !== undefined ? patch.selectedPriceTable : current.selectedPriceTable;
    const branch = patch.selectedBranchId !== undefined ? patch.selectedBranchId : current.selectedBranchId;
    const ref = await findActivePrice(tx, current.productId, table, branch);

    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (column: string, value: unknown, cast: string) => {
      params.push(value);
      sets.push(`${column} = $${params.length}::${cast}`);
    };
    let contentChanged = false;
    for (const [key, column, cast] of CONTENT_FIELDS) {
      const value = patch[key];
      if (value === undefined) continue;
      contentChanged = true;
      if (cast === "jsonb") set(column, JSON.stringify(value), cast);
      else if (typeof value === "string") set(column, value.trim() || null, cast);
      else set(column, value, cast);
    }
    set("reference_price", ref?.price ?? null, "numeric");

    // Qualquer mudança de conteúdo gera nova versão e invalida a validação anterior.
    let nextStatus: DraftStatus | undefined = patch.status;
    if (contentChanged) {
      sets.push("version = version + 1");
      if (!nextStatus && ["VALIDATED", "READY", "INCOMPLETE", "FAILED"].includes(current.status)) nextStatus = "DRAFT";
    }
    if (nextStatus) set("status", nextStatus, "text");
    sets.push("updated_at = now()");

    await tx.execute(`UPDATE listing_drafts SET ${sets.join(", ")} WHERE id = $1::int`, params);
    const updated = (await getDraft(tx, id))!;

    if (updated.status === "READY") {
      const readiness = checkReadiness(updated);
      if (readiness.blocking.length) throw new DraftNotReadyError(readiness); // desfaz a transação
    }
    if (nextStatus && nextStatus !== current.status) {
      await recordEvent(tx, { draftId: id, type: "status_changed", from: current.status, to: nextStatus, details: { version: updated.version } });
    }
    return updated;
  });
}
