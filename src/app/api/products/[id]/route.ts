import { z } from "zod";
import { adminHandler, type RouteContext } from "@/lib/api";
import { getDraftByProduct } from "@/lib/catalog/drafts";
import { listImages } from "@/lib/catalog/images";
import { getProduct, getProductPrices, getProductStocks, stockStatus, updateProductCustom } from "@/lib/catalog/products";
import { getCatalogSettings } from "@/lib/catalog/settings";
import { errorJson, jsonNoStore } from "@/lib/http";
import { getSql } from "@/lib/sql";
import { parseId, parseJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = RouteContext<{ id: string }>;

export const GET = adminHandler(async (_req, ctx: Ctx) => {
  const id = await parseId(ctx.params);
  if (!id) return errorJson(400, "invalid_id", "ID inválido");
  const sql = getSql();
  const product = await getProduct(sql, id);
  if (!product) return errorJson(404, "not_found", "Produto não encontrado");
  const [prices, stocks, images, draft, settings] = await Promise.all([
    getProductPrices(sql, id),
    getProductStocks(sql, id),
    listImages(sql, id),
    getDraftByProduct(sql, id),
    getCatalogSettings(sql),
  ]);
  return jsonNoStore({ product, prices, stocks, stockStatus: stockStatus(stocks), images, draft, settings });
});

const patchSchema = z
  .object({
    /** Nome comercial personalizado; null/"" volta a usar a descrição da ADS. */
    nameCustom: z.string().max(200).nullable().optional(),
  })
  .strict();

/** Edita apenas campos manuais. Dados de origem da ADS não são editáveis por aqui. */
export const PATCH = adminHandler(
  async (req, ctx: Ctx) => {
    const id = await parseId(ctx.params);
    if (!id) return errorJson(400, "invalid_id", "ID inválido");
    const body = await parseJsonBody(req, patchSchema);
    if (!body.ok) return body.response;
    const product = await updateProductCustom(getSql(), id, body.data);
    if (!product) return errorJson(404, "not_found", "Produto não encontrado");
    return jsonNoStore({ product });
  },
  { mutating: true },
);
