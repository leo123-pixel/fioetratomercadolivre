import { adminHandler, type RouteContext } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { CATEGORY_ID, getCategory } from "@/lib/meli/categories";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Detalhes da categoria (caminho, subcategorias e configurações como max_title_length e preço mínimo). */
export const GET = adminHandler(
  async (_req, ctx: RouteContext<{ categoryId: string }>) => {
    const { categoryId } = await ctx.params;
    if (!CATEGORY_ID.test(categoryId)) return errorJson(400, "invalid_category", "Categoria inválida");
    return jsonNoStore({ category: await getCategory(getSql(), categoryId) });
  },
  { rateLimitPerMinute: 120 },
);
