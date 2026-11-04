import { z } from "zod";
import { adminHandler, type RouteContext } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { CATEGORY_ID, getCategoryAttributes, suggestCategories } from "@/lib/meli/categories";
import { loadProductForSuggestions, suggestFromAds } from "@/lib/publish/suggestions";
import { getSql } from "@/lib/sql";
import { parseQuery } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const query = z.object({ draftId: z.coerce.number().int().positive().optional() });

/**
 * Atributos reais da categoria (GET /categories/{id}/attributes). Com draftId, inclui sugestões
 * confiáveis a partir da ADS e do preditor — que o operador aplica manualmente.
 */
export const GET = adminHandler(
  async (req, ctx: RouteContext<{ categoryId: string }>) => {
    const { categoryId } = await ctx.params;
    if (!CATEGORY_ID.test(categoryId)) return errorJson(400, "invalid_category", "Categoria inválida");
    const q = parseQuery(req, query);
    if (!q.ok) return q.response;
    const sql = getSql();
    const attributes = await getCategoryAttributes(sql, categoryId);
    let suggestions: ReturnType<typeof suggestFromAds> = [];
    if (q.data.draftId) {
      const product = await loadProductForSuggestions(sql, q.data.draftId);
      if (product) {
        const predicted = await suggestCategories(product.name, 3).catch(() => []);
        const sameCategory = predicted.find((p) => p.categoryId === categoryId);
        suggestions = suggestFromAds(product, attributes, sameCategory?.attributes ?? []);
      }
    }
    return jsonNoStore({ categoryId, attributes, suggestions });
  },
  { rateLimitPerMinute: 120 },
);
