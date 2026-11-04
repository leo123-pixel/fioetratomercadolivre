import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { draftCreateSchema } from "@/lib/catalog/draft-schemas";
import { createDrafts, listDrafts } from "@/lib/catalog/drafts";
import { jsonNoStore } from "@/lib/http";
import { getSql } from "@/lib/sql";
import { parseJsonBody, parseQuery } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const query = z.object({
  status: z.enum(["DRAFT", "READY", "ARCHIVED"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export const GET = adminHandler(async (req) => {
  const q = parseQuery(req, query);
  if (!q.ok) return q.response;
  return jsonNoStore(await listDrafts(getSql(), q.data));
});

/**
 * Cria rascunhos para um ou vários produtos (seleção em lote). Produtos inativos e produtos que já têm
 * rascunho são ignorados e reportados. Nenhum anúncio é criado no Mercado Livre.
 */
export const POST = adminHandler(
  async (req) => {
    const body = await parseJsonBody(req, draftCreateSchema);
    if (!body.ok) return body.response;
    const ids = body.data.productIds ?? [body.data.productId!];
    const result = await createDrafts(getSql(), ids);
    return jsonNoStore(result, result.created.length ? 201 : 200);
  },
  { mutating: true },
);
