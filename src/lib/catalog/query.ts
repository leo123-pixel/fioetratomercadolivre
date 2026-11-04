import { z } from "zod";

/** Filtros do catálogo (usados pela API e pela página /produtos). */
export const productQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  supplierId: z.coerce.number().int().min(0).max(2_147_483_647).optional(),
  divisionId: z.string().trim().min(1).max(20).optional(),
  stock: z.enum(["positive", "zero", "unknown"]).optional(),
  status: z.enum(["active", "inactive"]).optional(),
  image: z.enum(["with", "without"]).optional(),
  draft: z.enum(["none", "any", "DRAFT", "READY", "published", "unpublished"]).optional(),
  price: z.enum(["with", "without"]).optional(),
  sort: z.enum(["name", "ads_id", "updated", "stock"]).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export type ProductQuery = z.infer<typeof productQuerySchema>;

/** Versão tolerante para a página: ignora parâmetros inválidos em vez de falhar. */
export function parseProductQuery(raw: Record<string, string | string[] | undefined>): ProductQuery {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const value = Array.isArray(v) ? v[0] : v;
    if (value !== undefined && value !== "") clean[k] = value;
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(productQuerySchema.shape) as (keyof typeof productQuerySchema.shape)[]) {
    const field = productQuerySchema.shape[key].safeParse(clean[key]);
    if (field.success && field.data !== undefined) result[key] = field.data;
  }
  return productQuerySchema.parse(result);
}
