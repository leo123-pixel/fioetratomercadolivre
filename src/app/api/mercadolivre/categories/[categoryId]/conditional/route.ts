import { z } from "zod";
import { adminHandler, type RouteContext } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { CATEGORY_ID, getConditionalRequired } from "@/lib/meli/categories";
import { parseJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = z
  .object({
    attributes: z
      .array(
        z.object({
          id: z.string().regex(/^[A-Z0-9_]{1,80}$/),
          value_id: z.string().max(100).nullable().optional(),
          value_name: z.string().max(500).nullable().optional(),
          values: z.array(z.object({ id: z.string().max(100).nullable().optional(), name: z.string().max(500).nullable().optional() })).max(50).optional(),
        }),
      )
      .max(150),
  })
  .strict();

/** Atributos que passam a ser obrigatórios conforme os valores preenchidos (regras condicionais oficiais). */
export const POST = adminHandler(
  async (req, ctx: RouteContext<{ categoryId: string }>) => {
    const { categoryId } = await ctx.params;
    if (!CATEGORY_ID.test(categoryId)) return errorJson(400, "invalid_category", "Categoria inválida");
    const b = await parseJsonBody(req, body);
    if (!b.ok) return b.response;
    const required = await getConditionalRequired(categoryId, b.data.attributes);
    return jsonNoStore({ categoryId, required: required ?? [], available: required !== null });
  },
  { mutating: true, rateLimitPerMinute: 60 },
);
