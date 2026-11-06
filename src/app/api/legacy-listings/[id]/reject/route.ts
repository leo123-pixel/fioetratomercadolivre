import { z } from "zod";
import { adminHandler, type RouteContext } from "@/lib/api";
import { getAdminSession } from "@/lib/auth/admin";
import { jsonNoStore } from "@/lib/http";
import { requesterFromSession } from "@/lib/publish/service";
import { getSql } from "@/lib/sql";
import { rejectSuggestion } from "@/lib/stock/links";
import { parseJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = z.object({ productId: z.number().int().positive() });

/** Recusa uma sugestão: o produto não volta a ser sugerido para este anúncio. */
export const POST = adminHandler(
  async (req, ctx: RouteContext<{ id: string }>) => {
    const { id } = await ctx.params;
    const b = await parseJsonBody(req, body);
    if (!b.ok) return b.response;
    await rejectSuggestion(getSql(), id, b.data.productId, requesterFromSession(getAdminSession(req)?.sid));
    return jsonNoStore({ ok: true });
  },
  { mutating: true, rateLimitPerMinute: 120 },
);
