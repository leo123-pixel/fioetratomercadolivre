import { z } from "zod";
import { moneyInput } from "../validation";

const attributeValue = z
  .object({
    id: z.string().trim().regex(/^[A-Z0-9_]{1,80}$/, "ID de atributo inválido"),
    value_id: z.string().trim().max(100).nullable().optional(),
    value_name: z.string().trim().max(500).nullable().optional(),
    values: z
      .array(z.object({ id: z.string().trim().max(100).nullable().optional(), name: z.string().trim().max(500).nullable().optional() }).strict())
      .max(50)
      .optional(),
    name: z.string().max(200).optional(),
  })
  .strict()
  .transform(({ name: _name, ...rest }) => rest);

/** Campos editáveis do rascunho (salvar nunca publica). */
export const draftPatchSchema = z
  .object({
    title: z.string().max(120).nullable().optional(),
    familyName: z.string().max(120).nullable().optional(),
    description: z.string().max(50_000).nullable().optional(),
    selectedPriceTable: z.string().trim().min(1).max(10).nullable().optional(),
    selectedBranchId: z.string().trim().min(1).max(10).nullable().optional(),
    listingPrice: moneyInput.nullable().optional(),
    listingQuantity: z.number().int().min(0).max(1_000_000).nullable().optional(),
    marketplaceCategoryId: z
      .string()
      .trim()
      .regex(/^(MLB\d{1,12})?$/, "Categoria no formato MLB123456")
      .nullable()
      .optional(),
    categoryName: z.string().trim().max(200).nullable().optional(),
    marketplaceAttributes: z.array(attributeValue).max(150).optional(),
    listingTypeId: z.string().trim().regex(/^[a-z_]{2,40}$/, "Tipo de anúncio inválido").nullable().optional(),
    itemCondition: z.enum(["new", "used", "not_specified"]).nullable().optional(),
    saleTerms: z.array(attributeValue).max(20).optional(),
    catalogProductId: z.string().trim().regex(/^MLB[A-Z0-9]{1,20}$/, "Produto de catálogo inválido").nullable().optional(),
    catalogListing: z.boolean().optional(),
    status: z.enum(["DRAFT", "READY", "ARCHIVED"]).optional(),
  })
  .strict();

export const draftCreateSchema = z
  .object({
    productId: z.number().int().positive().optional(),
    productIds: z.array(z.number().int().positive()).min(1).max(500).optional(),
    /** Todos os resultados de um filtro do catálogo — exige confirmação e a contagem exibida ao usuário. */
    filter: z.record(z.string(), z.string()).optional(),
    expectedCount: z.number().int().positive().max(1000).optional(),
    confirmAll: z.literal(true).optional(),
  })
  .strict()
  .refine((v) => [v.productId, v.productIds, v.filter].filter((x) => x !== undefined).length === 1, "Informe productId, productIds ou filter")
  .refine((v) => !v.filter || (v.confirmAll === true && v.expectedCount !== undefined), "Seleção por filtro exige confirmAll e expectedCount");

export const publishSchema = z
  .object({
    confirm: z.literal(true),
    draftVersion: z.number().int().positive(),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const publishBatchSchema = z
  .object({
    confirm: z.literal(true),
    items: z.array(z.object({ draftId: z.number().int().positive(), draftVersion: z.number().int().positive(), fingerprint: z.string().regex(/^[0-9a-f]{64}$/) }).strict()).min(1).max(100),
  })
  .strict();
