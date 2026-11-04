import { adminHandler } from "@/lib/api";
import { listProducts } from "@/lib/catalog/products";
import { productQuerySchema } from "@/lib/catalog/query";
import { jsonNoStore } from "@/lib/http";
import { getSql } from "@/lib/sql";
import { parseQuery } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Catálogo paginado no servidor, com busca e filtros. */
export const GET = adminHandler(async (req) => {
  const q = parseQuery(req, productQuerySchema);
  if (!q.ok) return q.response;
  return jsonNoStore(await listProducts(getSql(), q.data));
});
