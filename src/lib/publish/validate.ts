import "server-only";
import { DraftLockedError, LOCKED_STATUSES, ML_TITLE_MAX, type DraftAttributeValue, type DraftStatus } from "../catalog/drafts";
import { RECOMMENDED_MIN_SIDE } from "../catalog/images";
import { logger } from "../logger";
import { meliRequest, MeliHttpError } from "../meli/api";
import { getCapabilities, type PublicationModel } from "../meli/capabilities";
import { isValidGtin } from "../meli/catalog";
import {
  getAvailableListingTypes,
  getCategory,
  getCategoryAttributes,
  getConditionalRequired,
  type CategoryDetail,
  type MeliAttribute,
} from "../meli/categories";
import type { Sql } from "../sql";
import { recordEvent } from "./events";
import { buildItemPayload, fingerprint, loadContext, type PublishContext } from "./payload";

/**
 * Validação server-side antes da publicação. Combina:
 * 1. regras internas, 2. configurações da categoria, 3. atributos obrigatórios (estáticos e condicionais),
 * 4. condições comerciais, 5. imagens, 6. POST /items/validate do Mercado Livre e 7. capacidades da conta.
 *
 * Resultado: VALIDATED (tudo ok, inclusive a validação oficial), READY (regras internas ok, mas a validação
 * oficial não pôde ser concluída) ou INCOMPLETE (há pendências). Só VALIDATED pode ser publicado.
 */
export type IssueSource = "internal" | "category" | "attributes" | "images" | "commercial" | "account" | "mercadolivre";

export interface ValidationIssue {
  code: string;
  message: string;
  severity: "error" | "warning";
  source: IssueSource;
  field?: string;
}

export interface ValidationResult {
  status: DraftStatus;
  version: number;
  model: PublicationModel | null;
  issues: ValidationIssue[];
  remote: "ok" | "failed" | "unavailable" | "skipped";
  fingerprint: string | null;
  checkedAt: string;
}

const PRICE = /^\d{1,10}(\.\d{1,2})?$/;

function err(code: string, message: string, source: IssueSource, field?: string): ValidationIssue {
  return { code, message, severity: "error", source, field };
}
function warn(code: string, message: string, source: IssueSource, field?: string): ValidationIssue {
  return { code, message, severity: "warning", source, field };
}

function hasValue(a: DraftAttributeValue | undefined): boolean {
  return Boolean(a && (a.value_id || a.value_name?.trim() || a.values?.some((v) => v.id || v.name?.trim())));
}

/** Regras dos atributos a partir da resposta real de /categories/{id}/attributes. */
export function checkAttributes(
  attrs: MeliAttribute[],
  values: DraftAttributeValue[],
  opts: { conditionalRequired: string[] | null; catalogListing: boolean },
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byId = new Map(attrs.map((a) => [a.id, a]));
  const given = new Map(values.filter((v) => v?.id).map((v) => [v.id, v]));

  for (const a of attrs) {
    const tags = a.tags ?? {};
    const editable = !tags.read_only && a.id !== "SELLER_SKU";
    const required = (tags.required && !tags.hidden) || (opts.catalogListing && tags.catalog_required);
    if (editable && required && !hasValue(given.get(a.id))) {
      issues.push(err("ATTRIBUTE_REQUIRED", `Atributo obrigatório não preenchido: ${a.name} (${a.id}).`, "attributes", `attr:${a.id}`));
    }
  }

  // Obrigatórios condicionais informados pelo ML para os valores atuais.
  for (const id of opts.conditionalRequired ?? []) {
    const a = byId.get(id);
    if (!a || a.tags?.read_only || id === "SELLER_SKU" || hasValue(given.get(id))) continue;
    if (id === "GTIN" && hasValue(given.get("EMPTY_GTIN_REASON"))) continue;
    issues.push(err("ATTRIBUTE_CONDITIONAL_REQUIRED", `Atributo exigido pela categoria para os valores informados: ${a.name} (${id}).`, "attributes", `attr:${id}`));
  }
  // Sem resposta do recurso condicional: aplica a regra conhecida do GTIN (código ou motivo da ausência).
  if (opts.conditionalRequired === null && byId.get("GTIN")?.tags?.conditional_required) {
    if (!hasValue(given.get("GTIN")) && !hasValue(given.get("EMPTY_GTIN_REASON"))) {
      issues.push(err("GTIN_OR_REASON_REQUIRED", "Informe o GTIN/EAN ou o motivo da ausência do código (EMPTY_GTIN_REASON).", "attributes", "attr:GTIN"));
    }
  }

  for (const v of values) {
    if (!v?.id || !hasValue(v)) continue;
    const a = byId.get(v.id);
    if (!a) {
      issues.push(warn("ATTRIBUTE_UNKNOWN", `O atributo ${v.id} não pertence à categoria escolhida e será ignorado pelo Mercado Livre.`, "attributes", `attr:${v.id}`));
      continue;
    }
    if (a.tags?.read_only) {
      issues.push(err("ATTRIBUTE_READ_ONLY", `O atributo ${a.name} é somente leitura.`, "attributes", `attr:${a.id}`));
      continue;
    }
    if (v.value_id && a.values?.length && !a.values.some((x) => x.id === v.value_id)) {
      issues.push(err("ATTRIBUTE_VALUE_NOT_ALLOWED", `Valor não permitido para ${a.name}.`, "attributes", `attr:${a.id}`));
    }
    if (v.values?.length && !a.tags?.multivalued) {
      issues.push(err("ATTRIBUTE_NOT_MULTIVALUED", `${a.name} aceita apenas um valor.`, "attributes", `attr:${a.id}`));
    }
    const text = v.value_name?.trim();
    if (text) {
      if (a.value_max_length && text.length > a.value_max_length) {
        issues.push(err("ATTRIBUTE_TOO_LONG", `${a.name}: máximo de ${a.value_max_length} caracteres.`, "attributes", `attr:${a.id}`));
      }
      if (a.value_type === "number" && !/^-?\d+([.,]\d+)?$/.test(text)) {
        issues.push(err("ATTRIBUTE_NOT_NUMBER", `${a.name} deve ser numérico.`, "attributes", `attr:${a.id}`));
      }
      if (a.value_type === "number_unit") {
        const m = text.match(/^(\d+(?:[.,]\d+)?)\s*(.+)$/);
        const units = (a.allowed_units ?? []).map((u) => u.id);
        if (!m || (units.length && !units.includes(m[2].trim()))) {
          issues.push(err("ATTRIBUTE_UNIT_INVALID", `${a.name}: informe número e unidade permitida (${units.join(", ") || "—"}).`, "attributes", `attr:${a.id}`));
        }
      }
      if (a.value_type === "list" && !v.value_id && a.values?.length && !a.values.some((x) => x.name.toLowerCase() === text.toLowerCase())) {
        issues.push(warn("ATTRIBUTE_FREE_VALUE", `${a.name}: valor fora da lista sugerida pelo Mercado Livre.`, "attributes", `attr:${a.id}`));
      }
      if (a.id === "GTIN" && !text.split(/[,;\s]+/).every((g) => isValidGtin(g))) {
        issues.push(err("GTIN_INVALID", "GTIN/EAN inválido (dígito verificador não confere).", "attributes", "attr:GTIN"));
      }
    }
  }
  return issues;
}

export function checkCommercial(ctx: PublishContext, category: CategoryDetail | null): ValidationIssue[] {
  const d = ctx.draft;
  const issues: ValidationIssue[] = [];
  const s = category?.settings ?? {};
  if (!d.listingPrice || !PRICE.test(d.listingPrice) || Number(d.listingPrice) <= 0) {
    issues.push(err("PRICE_INVALID", "Defina o preço final de publicação (valor positivo, até 2 casas).", "commercial", "listingPrice"));
  } else {
    if (typeof s.minimum_price === "number" && Number(d.listingPrice) < s.minimum_price) {
      issues.push(err("PRICE_BELOW_MINIMUM", `Preço abaixo do mínimo da categoria (R$ ${s.minimum_price}).`, "commercial", "listingPrice"));
    }
    if (typeof s.maximum_price === "number" && Number(d.listingPrice) > s.maximum_price) {
      issues.push(err("PRICE_ABOVE_MAXIMUM", `Preço acima do máximo da categoria (R$ ${s.maximum_price}).`, "commercial", "listingPrice"));
    }
  }
  if (!d.referencePrice) issues.push(warn("REFERENCE_PRICE_MISSING", "Sem preço ativo na tabela de referência; confira o preço final.", "commercial", "selectedPriceTable"));
  if (d.listingQuantity === null || !Number.isInteger(d.listingQuantity) || d.listingQuantity < 1) {
    issues.push(err("QUANTITY_INVALID", "Defina a quantidade para publicação (inteiro, mínimo 1).", "commercial", "listingQuantity"));
  } else if (d.stockBranches === 0) {
    issues.push(warn("STOCK_UNKNOWN", "Estoque desconhecido na ADS: confirme a quantidade antes de publicar.", "commercial", "listingQuantity"));
  } else if (d.stockTotal !== null && d.listingQuantity > Number(d.stockTotal)) {
    issues.push(warn("QUANTITY_ABOVE_STOCK", `Quantidade (${d.listingQuantity}) maior que o estoque consultado na ADS (${d.stockTotal}).`, "commercial", "listingQuantity"));
  }
  if (!d.listingTypeId) issues.push(err("LISTING_TYPE_MISSING", "Escolha o tipo de anúncio.", "commercial", "listingTypeId"));
  const conditions = Array.isArray(s.item_conditions) ? (s.item_conditions as string[]) : null;
  if (!d.itemCondition) issues.push(err("CONDITION_MISSING", "Informe a condição do produto.", "commercial", "itemCondition"));
  else if (conditions && !conditions.includes(d.itemCondition)) {
    issues.push(err("CONDITION_NOT_ALLOWED", `Condição "${d.itemCondition}" não permitida na categoria (${conditions.join(", ")}).`, "commercial", "itemCondition"));
  }
  return issues;
}

export function checkContent(ctx: PublishContext, category: CategoryDetail | null): ValidationIssue[] {
  const d = ctx.draft;
  const issues: ValidationIssue[] = [];
  const max = typeof category?.settings.max_title_length === "number" ? category.settings.max_title_length : ML_TITLE_MAX;
  const field = ctx.model === "USER_PRODUCTS" ? "familyName" : "title";
  const label = ctx.model === "USER_PRODUCTS" ? "Nome da família (family_name)" : "Título";
  const value = (ctx.model === "USER_PRODUCTS" ? d.familyName : d.title)?.trim() ?? "";
  if (!value) issues.push(err("TITLE_MISSING", `${label} é obrigatório.`, "internal", field));
  else if (value.length > max) issues.push(err("TITLE_TOO_LONG", `${label} com ${value.length} caracteres; limite da categoria: ${max}.`, "internal", field));

  const maxDesc = typeof category?.settings.max_description_length === "number" ? category.settings.max_description_length : 50_000;
  if (!d.description?.trim()) issues.push(warn("DESCRIPTION_MISSING", "Sem descrição comercial.", "internal", "description"));
  else if (d.description.length > maxDesc) issues.push(err("DESCRIPTION_TOO_LONG", `Descrição acima de ${maxDesc} caracteres.`, "internal", "description"));
  if (d.description && /<[a-z][\s\S]*>/i.test(d.description)) {
    issues.push(err("DESCRIPTION_HTML", "A descrição deve ser texto simples (sem HTML).", "internal", "description"));
  }
  if (d.productInactive) issues.push(err("PRODUCT_INACTIVE", "Produto inativo na ADS.", "internal"));
  if (d.marketplaceItemId) issues.push(err("ALREADY_PUBLISHED", `Produto já publicado (${d.marketplaceItemId}).`, "internal"));
  return issues;
}

export function checkImages(ctx: PublishContext, category: CategoryDetail | null): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const max = typeof category?.settings.max_pictures_per_item === "number" ? category.settings.max_pictures_per_item : 12;
  if (!ctx.images.length) issues.push(err("NO_IMAGES", "Adicione ao menos uma imagem.", "images"));
  if (ctx.images.length > max) issues.push(err("TOO_MANY_IMAGES", `A categoria aceita até ${max} imagens (há ${ctx.images.length}).`, "images"));
  for (const [i, img] of ctx.images.entries()) {
    if (!["image/jpeg", "image/png"].includes(img.contentType)) issues.push(err("IMAGE_FORMAT", `Imagem ${i + 1}: formato não aceito.`, "images"));
    if (!/^https:\/\//.test(img.publicUrl)) issues.push(err("IMAGE_URL_NOT_PUBLIC", `Imagem ${i + 1}: URL não é HTTPS pública.`, "images"));
    if (img.width !== null && img.height !== null && Math.min(img.width, img.height) < RECOMMENDED_MIN_SIDE) {
      issues.push(warn("IMAGE_SMALL", `Imagem ${i + 1} com ${img.width}x${img.height}px; recomendado ≥ ${RECOMMENDED_MIN_SIDE}px.`, "images"));
    }
  }
  if (ctx.images.length && !ctx.images.some((i) => i.isPrimary)) issues.push(warn("NO_PRIMARY_IMAGE", "Nenhuma imagem marcada como principal.", "images"));
  return issues;
}

/** Converte a resposta de erro de POST /items/validate em pendências. */
export function issuesFromMeli(e: MeliHttpError): ValidationIssue[] {
  const fromCauses = e.causes.map((c) =>
    (c.type === "warning" ? warn : err)(`ML_${(c.code ?? "cause").toUpperCase()}`, c.message ?? c.code ?? "Erro informado pelo Mercado Livre", "mercadolivre"),
  );
  // A recusa (HTTP 4xx) sem nenhuma causa do tipo erro: o motivo real está na mensagem principal
  // da resposta. Sem isso a tela mostraria só avisos e esconderia por que o anúncio foi recusado.
  if (!fromCauses.some((i) => i.severity === "error")) {
    fromCauses.unshift(err(`ML_${(e.code ?? e.kind).toUpperCase()}`, `Recusado pelo Mercado Livre: ${e.message}`, "mercadolivre"));
  }
  return fromCauses;
}

export async function validateDraft(sql: Sql, draftId: number, opts: { remote?: boolean } = {}): Promise<ValidationResult | null> {
  const caps = await getCapabilities(sql);
  const model: PublicationModel = caps.publicationModel ?? "CLASSIC";
  const ctx = await loadContext(sql, draftId, model);
  if (!ctx) return null;
  const startStatus = ctx.draft.status;
  if (LOCKED_STATUSES.includes(startStatus) && !(startStatus === "VALIDATING" && Date.now() - new Date(ctx.draft.updatedAt).getTime() > 120_000)) {
    throw new DraftLockedError(startStatus);
  }
  const version = ctx.draft.version;
  const issues: ValidationIssue[] = [];

  if (!caps.connected) issues.push(err("ACCOUNT_NOT_CONNECTED", "Conta Mercado Livre não conectada ou autorização expirada.", "account"));
  else if (!caps.canWrite) issues.push(err("ACCOUNT_NO_WRITE_SCOPE", "A autorização da conta não inclui permissão de escrita (write).", "account"));
  if (!caps.publicationModel) issues.push(warn("MODEL_UNKNOWN", "Modelo de publicação da conta não detectado; usando o modelo clássico.", "account"));

  let category: CategoryDetail | null = null;
  let attrs: MeliAttribute[] = [];
  const categoryId = ctx.draft.marketplaceCategoryId;
  if (!categoryId) issues.push(err("CATEGORY_MISSING", "Escolha a categoria do Mercado Livre.", "category", "category"));
  else {
    try {
      category = await getCategory(sql, categoryId);
      attrs = await getCategoryAttributes(sql, categoryId);
      if (category.settings.listing_allowed === false) issues.push(err("CATEGORY_NOT_LISTABLE", "A categoria não permite anúncios.", "category", "category"));
      if (category.children_categories.length) issues.push(err("CATEGORY_NOT_LEAF", "Escolha uma subcategoria final (a categoria possui subcategorias).", "category", "category"));
      if (category.settings.status && category.settings.status !== "enabled") issues.push(err("CATEGORY_DISABLED", `Categoria com status ${category.settings.status}.`, "category", "category"));
    } catch (e) {
      issues.push(err("CATEGORY_INVALID", `Categoria inválida ou indisponível: ${(e as Error).message}`, "category", "category"));
    }
  }

  issues.push(...checkContent(ctx, category), ...checkCommercial(ctx, category), ...checkImages(ctx, category));

  if (category) {
    const conditional = await getConditionalRequired(category.id, ctx.draft.marketplaceAttributes ?? []);
    issues.push(...checkAttributes(attrs, ctx.draft.marketplaceAttributes ?? [], { conditionalRequired: conditional, catalogListing: ctx.draft.catalogListing }));
    if (caps.connected && ctx.draft.listingTypeId && caps.meliUserId) {
      try {
        const types = await getAvailableListingTypes(caps.meliUserId, category.id);
        if (types.length && !types.some((t) => t.id === ctx.draft.listingTypeId)) {
          issues.push(err("LISTING_TYPE_UNAVAILABLE", `Tipo de anúncio ${ctx.draft.listingTypeId} indisponível para a conta nesta categoria.`, "commercial", "listingTypeId"));
        }
      } catch {
        issues.push(warn("LISTING_TYPES_UNAVAILABLE", "Não foi possível consultar os tipos de anúncio disponíveis.", "commercial", "listingTypeId"));
      }
    }
  }

  let remote: ValidationResult["remote"] = "skipped";
  const hasErrors = () => issues.some((i) => i.severity === "error");
  if (opts.remote !== false && !hasErrors()) {
    await sql.execute(`UPDATE listing_drafts SET status = 'VALIDATING', updated_at = now() WHERE id = $1::int AND version = $2::int`, [draftId, version]);
    try {
      await meliRequest("/items/validate", { method: "POST", auth: true, body: buildItemPayload(ctx, { pictures: "source" }) });
      remote = "ok";
    } catch (e) {
      if (e instanceof MeliHttpError && (e.kind === "bad_request" || e.kind === "forbidden" || e.kind === "auth")) {
        remote = "failed";
        issues.push(...issuesFromMeli(e));
      } else {
        remote = "unavailable";
        logger.warn("Validação oficial indisponível", { draftId, err: e });
        issues.push(warn("ML_VALIDATION_UNAVAILABLE", "Validação oficial do Mercado Livre indisponível no momento; tente novamente.", "mercadolivre"));
      }
    }
  }

  const status: DraftStatus = hasErrors() ? "INCOMPLETE" : remote === "ok" ? "VALIDATED" : "READY";
  const fp = status === "VALIDATED" ? fingerprint(ctx) : null;
  const result: ValidationResult = { status, version, model, issues, remote, fingerprint: fp, checkedAt: new Date().toISOString() };

  // Grava somente se o rascunho não mudou durante a validação (mesma versão).
  const saved = await sql.execute(
    `UPDATE listing_drafts SET status = $3::text, validation_result = $4::jsonb, validated_at = now(),
       validated_version = CASE WHEN $3::text = 'VALIDATED' THEN version ELSE NULL END,
       validated_fingerprint = $5::text, updated_at = now()
     WHERE id = $1::int AND version = $2::int`,
    [draftId, version, status, JSON.stringify(result), fp],
  );
  if (saved) await recordEvent(sql, { draftId, type: "validated", from: startStatus, to: status, details: { version, remote, errors: issues.filter((i) => i.severity === "error").length } });
  return saved ? result : { ...result, status: startStatus, issues: [...issues, warn("DRAFT_CHANGED", "O rascunho foi alterado durante a validação; valide novamente.", "internal")] };
}
