import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { bulkConfirmSafe, confirmMapping, refreshMappingSuggestions, rejectSuggestion, revokeMapping } from "@/lib/nuvemshop/mapping";
import { getSql } from "@/lib/sql";
import { actorOf, catalogStoreId } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VariantId = z.string().regex(/^\d{1,20}$/);
const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("confirm"),
    variantId: VariantId,
    productId: z.number().int().positive(),
    components: z.array(z.object({ productId: z.number().int().positive(), quantity: z.number().int().min(1).max(1000) })).max(20).optional(),
    notes: z.string().max(500).nullish(),
  }),
  z.object({ action: z.literal("reject"), variantId: VariantId, productId: z.number().int().positive(), reason: z.string().max(500).nullish() }),
  z.object({ action: z.literal("revoke"), variantId: VariantId, reason: z.string().min(3).max(500) }),
  z.object({ action: z.literal("bulk_confirm_safe"), variantIds: z.array(VariantId).min(1).max(500) }),
  z.object({ action: z.literal("refresh_suggestions") }),
]);

/**
 * POST /api/nuvemshop/mappings — vínculos variante Nuvemshop ↔ produto ADS (somente no banco local; nada é
 * enviado à Nuvemshop). Ações: confirm, reject, revoke, bulk_confirm_safe, refresh_suggestions.
 */
export const POST = adminHandler(
  async (req) => {
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return jsonNoStore({ error: "invalid_body", message: "Requisição inválida", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 422);
    }
    const sql = getSql();
    const storeId = await catalogStoreId(sql);
    const actor = actorOf(req);
    const b = parsed.data;
    switch (b.action) {
      case "confirm":
        return jsonNoStore(await confirmMapping(sql, { storeId, variantId: b.variantId, productId: b.productId, actor, components: b.components, notes: b.notes ?? null }));
      case "reject":
        await rejectSuggestion(sql, { storeId, variantId: b.variantId, productId: b.productId, actor, reason: b.reason ?? null });
        return jsonNoStore({ ok: true });
      case "revoke":
        await revokeMapping(sql, { storeId, variantId: b.variantId, actor, reason: b.reason });
        return jsonNoStore({ ok: true });
      case "bulk_confirm_safe":
        return jsonNoStore(await bulkConfirmSafe(sql, { storeId, actor, variantIds: b.variantIds }));
      case "refresh_suggestions":
        return jsonNoStore(await sql.transaction((tx) => refreshMappingSuggestions(tx, storeId, actor)));
      default:
        return errorJson(422, "invalid_action", "Ação inválida");
    }
  },
  { mutating: true, rateLimitPerMinute: 60 },
);
