import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { getAdminSession } from "@/lib/auth/admin";
import { jsonNoStore } from "@/lib/http";
import { MappingError, remapOrders, saveMapping } from "@/lib/marketplace/mappings";
import { requesterFromSession } from "@/lib/publish/service";
import { getSql } from "@/lib/sql";
import { parseJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const body = z.object({
  items: z
    .array(z.object({ itemId: z.string().regex(/^MLB\d{1,15}$/), variationId: z.string().regex(/^\d{1,30}$/).nullish(), productId: z.number().int().positive() }))
    .min(1)
    .max(300),
  note: z.string().max(100).optional(),
});

/** Confirma vários vínculos de anúncio de uma vez (ex.: sugestões por código de barras revisadas pelo administrador). */
export const POST = adminHandler(
  async (req) => {
    const b = await parseJsonBody(req, body);
    if (!b.ok) return b.response;
    const sql = getSql();
    const by = requesterFromSession(getAdminSession(req)?.sid);
    const results: { itemId: string; ok: boolean; message?: string }[] = [];
    for (const it of b.data.items) {
      try {
        await saveMapping(sql, { scope: "ITEM", itemId: it.itemId, variationId: it.variationId ?? null, productId: it.productId, createdBy: by, notes: b.data.note ?? null, remap: false });
        results.push({ itemId: it.itemId, ok: true });
      } catch (err) {
        if (!(err instanceof MappingError)) throw err;
        results.push({ itemId: it.itemId, ok: false, message: err.message });
      }
    }
    const remapped = await remapOrders(sql);
    return jsonNoStore({ results, remapped });
  },
  { mutating: true, rateLimitPerMinute: 10 },
);
