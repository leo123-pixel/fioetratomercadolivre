import { adminHandler, type RouteContext } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { CATEGORY_ID, getTechnicalSpecs } from "@/lib/meli/categories";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /categories/{id}/technical_specs/input (null quando a categoria não oferece). */
export const GET = adminHandler(
  async (_req, ctx: RouteContext<{ categoryId: string }>) => {
    const { categoryId } = await ctx.params;
    if (!CATEGORY_ID.test(categoryId)) return errorJson(400, "invalid_category", "Categoria inválida");
    return jsonNoStore({ categoryId, technicalSpecs: await getTechnicalSpecs(getSql(), categoryId) });
  },
  { rateLimitPerMinute: 60 },
);
