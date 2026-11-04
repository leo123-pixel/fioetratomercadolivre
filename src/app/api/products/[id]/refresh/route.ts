import { z } from "zod";
import { getAdsClient } from "@/lib/ads/client";
import { adminHandler, type RouteContext } from "@/lib/api";
import { refreshProduct } from "@/lib/catalog/refresh";
import { errorJson, jsonNoStore } from "@/lib/http";
import { getSql } from "@/lib/sql";
import { parseId, parseJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bodySchema = z
  .object({ scopes: z.array(z.enum(["product", "prices", "stock"])).min(1).max(3).default(["prices", "stock"]) })
  .strict();

/** Nova consulta à ADS (somente leitura) para um produto: cadastro, preços e/ou estoque. */
export const POST = adminHandler(
  async (req, ctx: RouteContext<{ id: string }>) => {
    const id = await parseId(ctx.params);
    if (!id) return errorJson(400, "invalid_id", "ID inválido");
    const body = await parseJsonBody(req, bodySchema);
    if (!body.ok) return body.response;
    const result = await refreshProduct(getSql(), getAdsClient(), id, body.data.scopes);
    if (!result) return errorJson(404, "not_found", "Produto não encontrado");
    return jsonNoStore({ result });
  },
  { mutating: true },
);
