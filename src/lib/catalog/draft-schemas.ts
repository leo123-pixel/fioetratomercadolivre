import { z } from "zod";
import { moneyInput } from "../validation";

const attribute = z
  .object({
    id: z.string().trim().min(1).max(100),
    name: z.string().trim().max(200).optional(),
    value_id: z.string().trim().max(100).nullable().optional(),
    value_name: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

/** Campos editáveis do rascunho. Categoria e atributos ficam preparados para a fase de publicação. */
export const draftPatchSchema = z
  .object({
    title: z.string().max(120).nullable().optional(),
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
    marketplaceAttributes: z.array(attribute).max(100).optional(),
    status: z.enum(["DRAFT", "READY", "ARCHIVED"]).optional(),
  })
  .strict();

export const draftCreateSchema = z
  .object({
    productId: z.number().int().positive().optional(),
    productIds: z.array(z.number().int().positive()).min(1).max(500).optional(),
  })
  .strict()
  .refine((v) => (v.productId === undefined) !== (v.productIds === undefined), "Informe productId ou productIds");
