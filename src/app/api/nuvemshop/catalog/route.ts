import { adminHandler } from "@/lib/api";
import { jsonNoStore } from "@/lib/http";
import { createProductFromAds, createProductSchema, uncertainOperations } from "@/lib/nuvemshop/products-admin";
import { getSql } from "@/lib/sql";
import { actorOf, catalogStoreId } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** GET /api/nuvemshop/catalog — operações de catálogo com resultado incerto (para reconciliação). */
export const GET = adminHandler(async () => {
  const sql = getSql();
  return jsonNoStore({ uncertain: await uncertainOperations(sql, await catalogStoreId(sql)) });
});

/**
 * POST /api/nuvemshop/catalog — cria na Nuvemshop um produto a partir de um produto ADS (oculto, estoque 0) e o
 * vincula. Recusa se o produto ADS já está vinculado, se o SKU já existe ou se há criação anterior incerta.
 */
export const POST = adminHandler(
  async (req) => {
    const parsed = createProductSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonNoStore({ error: "invalid_body", message: "Requisição inválida", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 422);
    return jsonNoStore(await createProductFromAds(getSql(), parsed.data, actorOf(req)), 201);
  },
  { mutating: true, rateLimitPerMinute: 20 },
);
