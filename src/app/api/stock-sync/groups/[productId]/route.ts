import { z } from "zod";
import { adminHandler, type RouteContext } from "@/lib/api";
import { getAdminSession } from "@/lib/auth/admin";
import { errorJson, jsonNoStore } from "@/lib/http";
import { requesterFromSession } from "@/lib/publish/service";
import { getSql } from "@/lib/sql";
import { getGroupPolicies, updateGroupPolicy } from "@/lib/stock/settings";
import { parseId, parseJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Política do grupo de estoque de um produto ADS + anúncios que consomem o seu saldo. */
export const GET = adminHandler(
  async (_req, ctx: RouteContext<{ productId: string }>) => {
    const id = await parseId(ctx.params, "productId");
    if (!id) return errorJson(400, "invalid_id", "ID inválido");
    const sql = getSql();
    const policy = (await getGroupPolicies(sql, [id])).get(id) ?? null;
    const listings = await sql.query(
      `SELECT ll.marketplace_item_id AS "itemId", ll.variation_id AS "variationId", ll.user_product_id AS "userProductId", ll.title, ll.status,
              ll.available_quantity AS "availableQuantity", ll.logistic_type AS "logisticType"
       FROM legacy_listings ll
       WHERE ll.removed_at IS NULL AND (
         EXISTS (SELECT 1 FROM marketplace_listings l WHERE l.marketplace_item_id = ll.marketplace_item_id AND l.status <> 'deleted' AND l.product_id = $1::int)
         OR EXISTS (SELECT 1 FROM marketplace_product_mappings m WHERE m.active AND m.mapping_type = 'ITEM' AND m.marketplace_item_id = ll.marketplace_item_id
                    AND m.variation_id = ll.variation_id AND (m.product_id = $1::int OR EXISTS (SELECT 1 FROM marketplace_mapping_components c WHERE c.mapping_id = m.id AND c.product_id = $1::int))))
       ORDER BY ll.marketplace_item_id`,
      [id],
    );
    return jsonNoStore({ policy, listings });
  },
  { rateLimitPerMinute: 120 },
);

const body = z
  .object({
    safetyReserve: z.number().int().min(0).max(100_000).nullable().optional(),
    allocationMode: z.enum(["EXCLUSIVE", "SPLIT_EVEN"]).optional(),
    autoSyncApproved: z.boolean().optional(),
    notes: z.string().max(300).nullable().optional(),
  })
  .strict();

export const PATCH = adminHandler(
  async (req, ctx: RouteContext<{ productId: string }>) => {
    const id = await parseId(ctx.params, "productId");
    if (!id) return errorJson(400, "invalid_id", "ID inválido");
    const b = await parseJsonBody(req, body);
    if (!b.ok) return b.response;
    const policy = await updateGroupPolicy(getSql(), id, b.data, requesterFromSession(getAdminSession(req)?.sid));
    return jsonNoStore({ policy });
  },
  { mutating: true, rateLimitPerMinute: 60 },
);
