import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { getSql } from "@/lib/sql";
import { actorOf, catalogStoreId } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/nuvemshop/locations — localizações lidas da loja e associação a depósito do Inventory Core. */
export const GET = adminHandler(async () => {
  const sql = getSql();
  const storeId = await catalogStoreId(sql);
  const items = await sql.query(
    `SELECT location_id AS "locationId", name, is_default AS "isDefault", priority, tags, (removed_at IS NOT NULL) AS removed,
            mapping_status AS "mappingStatus", warehouse_code AS "warehouseCode", mapped_by AS "mappedBy", mapped_at AS "mappedAt", fetched_at AS "fetchedAt"
     FROM nuvemshop_locations WHERE store_id = $1 ORDER BY removed_at NULLS FIRST, priority NULLS LAST, location_id`,
    [storeId],
  );
  return jsonNoStore({ items });
});

const Body = z.object({
  locationId: z.string().min(1).max(64),
  status: z.enum(["MAPPED", "UNMAPPED", "EXCLUDED"]),
  warehouseCode: z.string().regex(/^[a-z0-9_-]{1,40}$/).nullish(),
});

/**
 * PUT /api/nuvemshop/locations — associa (ou não) uma localização Nuvemshop a um depósito do Inventory Core.
 * Nunca presumido: localização sem associação não participa do cálculo (estoque nela = desconhecido).
 */
export const PUT = adminHandler(
  async (req) => {
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return errorJson(422, "invalid_body", "Informe a localização, a situação e, se mapeada, o depósito (minúsculas, números, - ou _)");
    const b = parsed.data;
    if (b.status === "MAPPED" && !b.warehouseCode) return errorJson(422, "invalid_body", "Localização mapeada exige o depósito");
    const sql = getSql();
    const storeId = await catalogStoreId(sql);
    const n = await sql.execute(
      `UPDATE nuvemshop_locations SET mapping_status = $3, warehouse_code = $4, mapped_by = $5, mapped_at = now() WHERE store_id = $1 AND location_id = $2`,
      [storeId, b.locationId, b.status, b.status === "MAPPED" ? b.warehouseCode : null, actorOf(req)],
    );
    if (!n) return errorJson(404, "not_found", "Localização não encontrada (verifique a conexão para atualizar a lista)");
    return jsonNoStore({ ok: true });
  },
  { mutating: true, rateLimitPerMinute: 30 },
);
