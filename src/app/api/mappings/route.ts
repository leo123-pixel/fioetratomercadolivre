import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { getAdminSession } from "@/lib/auth/admin";
import { jsonNoStore } from "@/lib/http";
import { listMappings, listUnmappedGroups, saveMapping } from "@/lib/marketplace/mappings";
import { requesterFromSession } from "@/lib/publish/service";
import { getSql } from "@/lib/sql";
import { parseJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Vínculos ativos e itens vendidos ainda sem produto ADS (agrupados). */
export const GET = adminHandler(
  async () => {
    const sql = getSql();
    const [mappings, unmapped] = await Promise.all([listMappings(sql), listUnmappedGroups(sql)]);
    return jsonNoStore({ mappings, unmapped });
  },
  { rateLimitPerMinute: 60 },
);

const body = z.object({
  scope: z.enum(["ITEM", "SKU", "ORDER_LINE"]),
  productId: z.number().int().positive(),
  itemId: z.string().regex(/^MLB\d{1,15}$/).nullish(),
  variationId: z.string().regex(/^\d{1,30}$/).nullish(),
  sellerSku: z.string().trim().min(1).max(120).nullish(),
  orderInboxId: z.string().regex(/^\d{1,18}$/).nullish(),
  lineKey: z.string().max(80).nullish(),
  notes: z.string().max(300).nullish(),
  replace: z.boolean().optional(),
});

/** Associação manual pelo administrador (reaplicada aos pedidos pendentes). Nunca por título. */
export const POST = adminHandler(
  async (req) => {
    const b = await parseJsonBody(req, body);
    if (!b.ok) return b.response;
    const r = await saveMapping(getSql(), { ...b.data, createdBy: requesterFromSession(getAdminSession(req)?.sid) });
    return jsonNoStore(r, 201);
  },
  { mutating: true, rateLimitPerMinute: 60 },
);
